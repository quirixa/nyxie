// server/services/marketplaceService.js — all marketplace business logic.
// HTTP plumbing lives in routes/marketplace.js; this file never touches
// req/res. Money movement is delegated to services/walletService.js
// (writeTransactionInline/markTransactionStatusInline) so the marketplace
// never invents a second wallet or a second ledger — see
// database/marketplaceDb.js's header comment for how "escrow" is
// represented on top of the existing wallet_transactions table.
//
// CONCURRENCY: same rule as walletService.js. Every function below that
// touches balances/stock is a single synchronous block (BEGIN..COMMIT
// with no `await` in between). The one await callers do (getUserDb()) is
// always finished before any of these functions run.

const crypto = require('crypto');
const { getUserDb, all, get, run } = require('../database/userDb');
const { ensureMarketplaceTables, getOrCreateVendor } = require('../database/marketplaceDb');
const { toMinorUnits, formatCurrency } = require('./currency');
const {
  getOrCreateWallet,
  writeTransactionInline,
  markTransactionStatusInline,
} = require('./walletService');

class MarketplaceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const CATEGORIES = ['gaming', 'digital', 'services', 'other'];
const DELIVERY_TYPES = ['manual', 'instant'];
const SORTS = ['newest', 'price_asc', 'price_desc', 'rating', 'popular'];
const DISPUTE_REASONS = ['item_not_received', 'item_not_as_described', 'seller_not_responding', 'buyer_issue', 'other'];

const MAX_TITLE = 100;
const MAX_DESCRIPTION = 4000;
const MAX_COMMENT = 1000;
const MAX_DISPUTE_DESCRIPTION = 2000;

// Trusted Vendor thresholds (section 15 of the spec).
const TRUSTED = { completedSales: 10, totalReviews: 5, rating: 4.5, completionRate: 95 };
const ELITE = { completedSales: 100, rating: 4.8, completionRate: 98 };

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// ── Validation helpers ──────────────────────────────────────────────
function validateListingInput(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('title')) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) throw new MarketplaceError('INVALID_TITLE', 'Title is required');
    if (title.length > MAX_TITLE) throw new MarketplaceError('INVALID_TITLE', `Title must be ${MAX_TITLE} characters or fewer`);
    out.title = title;
  }
  if (!partial || has('description')) {
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!description) throw new MarketplaceError('INVALID_DESCRIPTION', 'Description is required');
    if (description.length > MAX_DESCRIPTION) throw new MarketplaceError('INVALID_DESCRIPTION', `Description must be ${MAX_DESCRIPTION} characters or fewer`);
    out.description = description;
  }
  if (!partial || has('category')) {
    const category = typeof body.category === 'string' ? body.category.trim().toLowerCase() : '';
    if (!CATEGORIES.includes(category)) throw new MarketplaceError('INVALID_CATEGORY', `Category must be one of: ${CATEGORIES.join(', ')}`);
    out.category = category;
  }
  if (!partial || has('price_nx') || has('price')) {
    const raw = has('price_nx') ? body.price_nx : body.price;
    const subunits = toMinorUnits(raw);
    if (subunits === null || subunits <= 0) throw new MarketplaceError('INVALID_PRICE', 'Price must be a positive NX amount');
    out.price = subunits;
  }
  if (!partial || has('stock')) {
    const stock = parseInt(body.stock, 10);
    if (!Number.isInteger(stock) || stock <= 0) throw new MarketplaceError('INVALID_STOCK', 'Stock must be a positive integer');
    out.stock = stock;
  }
  if (!partial || has('delivery_type') || has('deliveryType')) {
    const deliveryType = (body.delivery_type || body.deliveryType || '').trim().toLowerCase();
    if (!DELIVERY_TYPES.includes(deliveryType)) throw new MarketplaceError('INVALID_DELIVERY_TYPE', `Delivery type must be one of: ${DELIVERY_TYPES.join(', ')}`);
    out.delivery_type = deliveryType;
  }
  if (has('image_url') || has('imageUrl')) {
    const imageUrl = body.image_url || body.imageUrl || null;
    if (imageUrl !== null) {
      if (typeof imageUrl !== 'string' || imageUrl.length > 2000) {
        throw new MarketplaceError('INVALID_IMAGE', 'Invalid image URL');
      }
      // Only ever accept our own upload/media paths — never an arbitrary
      // external or javascript: URL (spec section 38: never trust a
      // user-provided filename/URL as-is).
      if (!/^\/(uploads|avatars|banners)\//.test(imageUrl)) {
        throw new MarketplaceError('INVALID_IMAGE', 'Image must be an uploaded file');
      }
    }
    out.image_url = imageUrl;
  }
  if (!partial && has('status')) {
    // status is settable only through update (never at create time).
  }
  return out;
}

// ── Formatting (DB row -> public API shape) ─────────────────────────
function formatMoney(subunits) {
  return { nx: formatCurrency(subunits), usd: formatCurrency(subunits) };
}

function vendorSummary(db, userId) {
  const vendor = getOrCreateVendor(db, userId);
  const user = get(db, 'SELECT id, username, display_name, avatar FROM users WHERE id = ?', [userId]);
  const rating = vendor.total_reviews > 0 ? vendor.rating_sum / vendor.total_reviews : null;
  return {
    id: user ? user.id : userId,
    username: user ? user.username : null,
    displayName: user ? user.display_name : null,
    avatar: user ? user.avatar : null,
    rating: rating !== null ? Math.round(rating * 100) / 100 : null,
    reviews: vendor.total_reviews,
    sales: vendor.completed_sales,
    completionRate: Math.round(vendor.completion_rate * 10) / 10,
    trusted: !!vendor.trusted_vendor,
    elite: !!vendor.elite_vendor,
  };
}

function formatListing(db, item) {
  const price = formatMoney(item.price);
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    category: item.category,
    priceNx: price.nx,
    priceUsd: price.usd,
    stock: item.stock,
    deliveryType: item.delivery_type,
    imageUrl: item.images ? (JSON.parse(item.images)[0] || null) : null,
    status: item.status,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    seller: vendorSummary(db, item.seller_id),
  };
}

function formatOrder(db, order) {
  return {
    id: order.id,
    listingId: order.item_id,
    buyerId: order.buyer_id,
    sellerId: order.seller_id,
    quantity: order.quantity,
    unitPriceNx: formatCurrency(order.unit_price),
    totalPriceNx: formatCurrency(order.amount),
    status: order.status,
    escrowStatus: order.escrow_status,
    sellerDelivered: !!order.seller_delivered,
    buyerConfirmed: !!order.buyer_confirmed,
    deliveryData: order.delivery_data || null,
    disputeId: order.dispute_id || null,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    completedAt: order.completed_at,
  };
}

// ── Listings ─────────────────────────────────────────────────────────
function listListings(db, { category, search, sort, page, limit } = {}) {
  ensureMarketplaceTables(db);
  page = clampInt(page, 1, 1_000_000, 1);
  limit = clampInt(limit, 1, 50, 24);
  const offset = (page - 1) * limit;

  const where = ["status = 'ACTIVE'"];
  const params = [];
  if (category && CATEGORIES.includes(String(category).toLowerCase())) {
    where.push('category = ?');
    params.push(String(category).toLowerCase());
  }
  if (search && typeof search === 'string' && search.trim()) {
    where.push('(title LIKE ? OR description LIKE ?)');
    const like = `%${search.trim().slice(0, 100)}%`;
    params.push(like, like);
  }

  let orderBy = 'created_at DESC';
  const chosenSort = SORTS.includes(sort) ? sort : 'newest';
  if (chosenSort === 'price_asc') orderBy = 'price ASC';
  else if (chosenSort === 'price_desc') orderBy = 'price DESC';
  // 'rating' and 'popular' need a join against vendor stats — done via
  // subselects rather than pulling every listing into JS to sort, since
  // pagination has to happen in SQL for this to stay cheap at scale.
  else if (chosenSort === 'rating') {
    orderBy = `(SELECT CASE WHEN v.total_reviews > 0 THEN CAST(v.rating_sum AS REAL) / v.total_reviews ELSE 0 END
                FROM marketplace_vendors v WHERE v.user_id = marketplace_items.seller_id) DESC`;
  } else if (chosenSort === 'popular') {
    orderBy = `(SELECT v.completed_sales FROM marketplace_vendors v WHERE v.user_id = marketplace_items.seller_id) DESC`;
  }

  const whereSql = where.join(' AND ');
  const totalRow = get(db, `SELECT COUNT(*) AS c FROM marketplace_items WHERE ${whereSql}`, params);
  const rows = all(db, `
    SELECT * FROM marketplace_items WHERE ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  return {
    listings: rows.map(r => formatListing(db, r)),
    pagination: { page, limit, total: totalRow ? totalRow.c : 0, pages: Math.max(1, Math.ceil((totalRow ? totalRow.c : 0) / limit)) },
  };
}

function getListingRaw(db, id) {
  ensureMarketplaceTables(db);
  return get(db, 'SELECT * FROM marketplace_items WHERE id = ?', [id]);
}

function getListing(db, id) {
  const item = getListingRaw(db, id);
  if (!item) throw new MarketplaceError('LISTING_NOT_FOUND', 'Listing not found', 404);
  return formatListing(db, item);
}

function createListing(db, sellerId, body) {
  ensureMarketplaceTables(db);
  const data = validateListingInput(body, { partial: false });
  const now = Date.now();
  const id = crypto.randomUUID();
  run(db, `
    INSERT INTO marketplace_items (id, seller_id, title, description, images, price, currency, category, status, stock, delivery_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'NX', ?, 'ACTIVE', ?, ?, ?, ?)
  `, [id, sellerId, data.title, data.description, data.image_url ? JSON.stringify([data.image_url]) : null,
      data.price, data.category, data.stock, data.delivery_type, now, now]);
  getOrCreateVendor(db, sellerId);
  return getListing(db, id);
}

function requireOwnedListing(db, sellerId, listingId) {
  const item = getListingRaw(db, listingId);
  if (!item) throw new MarketplaceError('LISTING_NOT_FOUND', 'Listing not found', 404);
  if (item.seller_id !== sellerId) throw new MarketplaceError('NOT_AUTHORIZED', 'Not authorized', 403);
  return item;
}

function updateListing(db, sellerId, listingId, body) {
  ensureMarketplaceTables(db);
  const item = requireOwnedListing(db, sellerId, listingId);
  const data = validateListingInput(body, { partial: true });

  // Status transitions are limited to what a seller may self-serve;
  // 'removed' goes through the dedicated delete endpoint so it can
  // enforce the soft-delete-if-has-orders rule.
  let status = item.status;
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const requested = String(body.status).toLowerCase();
    if (!['active', 'paused'].includes(requested)) {
      throw new MarketplaceError('INVALID_STATUS', "Status can only be set to 'active' or 'paused' here");
    }
    if (item.status === 'REMOVED' || item.status === 'SOLD') {
      throw new MarketplaceError('INVALID_STATUS', 'This listing can no longer be changed');
    }
    status = requested.toUpperCase();
  }

  const now = Date.now();
  run(db, `
    UPDATE marketplace_items SET
      title = ?, description = ?, category = ?, price = ?, stock = ?, delivery_type = ?, images = ?, status = ?, updated_at = ?
    WHERE id = ?
  `, [
    data.title ?? item.title,
    data.description ?? item.description,
    data.category ?? item.category,
    data.price ?? item.price,
    data.stock ?? item.stock,
    data.delivery_type ?? item.delivery_type,
    data.image_url !== undefined ? (data.image_url ? JSON.stringify([data.image_url]) : null) : item.images,
    status,
    now,
    listingId,
  ]);
  return getListing(db, listingId);
}

function removeListing(db, sellerId, listingId) {
  ensureMarketplaceTables(db);
  requireOwnedListing(db, sellerId, listingId);
  // Always soft-delete — orders reference listing rows by id and we must
  // never break that history (spec section 11).
  run(db, "UPDATE marketplace_items SET status = 'REMOVED', updated_at = ? WHERE id = ?", [Date.now(), listingId]);
  return { ok: true };
}

// ── Purchase / escrow flow (spec section 5) ─────────────────────────
function purchase(db, { buyerId, listingId, quantity }) {
  ensureMarketplaceTables(db);
  quantity = parseInt(quantity, 10);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new MarketplaceError('INVALID_QUANTITY', 'Quantity must be a positive integer');
  }

  // No `await` from here until COMMIT — see concurrency note at top.
  run(db, 'BEGIN TRANSACTION');
  try {
    const listing = get(db, 'SELECT * FROM marketplace_items WHERE id = ?', [listingId]);
    if (!listing) throw new MarketplaceError('LISTING_NOT_FOUND', 'Listing not found', 404);
    if (listing.status !== 'ACTIVE') throw new MarketplaceError('LISTING_UNAVAILABLE', 'Listing is no longer available');
    if (listing.seller_id === buyerId) throw new MarketplaceError('SELF_PURCHASE', 'Cannot purchase your own listing');
    if (listing.stock < quantity) throw new MarketplaceError('INSUFFICIENT_STOCK', 'Insufficient stock');

    const unitPrice = listing.price;
    const totalPrice = unitPrice * quantity;

    const buyerWallet = getOrCreateWallet(db, buyerId);
    if (buyerWallet.status !== 'ACTIVE') throw new MarketplaceError('WALLET_FROZEN', 'Your wallet is frozen');
    if (buyerWallet.balance < totalPrice) throw new MarketplaceError('INSUFFICIENT_BALANCE', 'Insufficient NX balance');

    const sellerWallet = getOrCreateWallet(db, listing.seller_id);

    // Debit the buyer now, held as ESCROW (single-leg debit — the
    // counterpart credit doesn't happen until release/refund).
    const holdTx = writeTransactionInline(db, {
      type: 'MARKETPLACE_ESCROW_HOLD',
      status: 'ESCROW',
      senderWalletDbId: buyerWallet.id,
      amount: totalPrice,
      description: `Escrow hold for "${listing.title}"`,
      metadata: { listingId: listing.id },
      legs: [{ walletDbId: buyerWallet.id, amount: totalPrice, direction: 'DEBIT' }],
    });

    const remainingStock = listing.stock - quantity;
    const newListingStatus = remainingStock <= 0 ? 'SOLD' : listing.status;
    const now = Date.now();
    run(db, 'UPDATE marketplace_items SET stock = ?, status = ?, updated_at = ? WHERE id = ?',
      [remainingStock, newListingStatus, now, listing.id]);

    const orderId = crypto.randomUUID();
    run(db, `
      INSERT INTO marketplace_orders
        (id, buyer_id, seller_id, item_id, amount, currency, status, purchase_transaction_id, quantity, unit_price, escrow_status, buyer_confirmed, seller_delivered, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'NX', 'PAID', ?, ?, ?, 'held', 0, 0, ?, ?)
    `, [orderId, buyerId, listing.seller_id, listing.id, totalPrice, holdTx.id, quantity, unitPrice, now, now]);

    getOrCreateVendor(db, listing.seller_id);
    run(db, 'COMMIT');
    return getOrderRaw(db, orderId);
  } catch (e) {
    try { run(db, 'ROLLBACK'); } catch (e2) { /* best-effort */ }
    throw e;
  }
}

function getOrderRaw(db, orderId) {
  return get(db, 'SELECT * FROM marketplace_orders WHERE id = ?', [orderId]);
}

function requireOrderParty(order, userId) {
  if (!order) throw new MarketplaceError('ORDER_NOT_FOUND', 'Order not found', 404);
  if (order.buyer_id !== userId && order.seller_id !== userId) {
    throw new MarketplaceError('NOT_AUTHORIZED', 'Not authorized', 403);
  }
}

function getOrder(db, userId, orderId, isAdmin = false) {
  ensureMarketplaceTables(db);
  const order = getOrderRaw(db, orderId);
  if (!order) throw new MarketplaceError('ORDER_NOT_FOUND', 'Order not found', 404);
  if (!isAdmin) requireOrderParty(order, userId);
  return formatOrder(db, order);
}

function listPurchases(db, buyerId, { page, limit } = {}) {
  ensureMarketplaceTables(db);
  page = clampInt(page, 1, 1_000_000, 1);
  limit = clampInt(limit, 1, 50, 20);
  const rows = all(db, `
    SELECT * FROM marketplace_orders WHERE buyer_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `, [buyerId, limit, (page - 1) * limit]);
  return { orders: rows.map(r => formatOrder(db, r)) };
}

function listSales(db, sellerId, { page, limit } = {}) {
  ensureMarketplaceTables(db);
  page = clampInt(page, 1, 1_000_000, 1);
  limit = clampInt(limit, 1, 50, 20);
  const rows = all(db, `
    SELECT * FROM marketplace_orders WHERE seller_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `, [sellerId, limit, (page - 1) * limit]);
  return { orders: rows.map(r => formatOrder(db, r)) };
}

// ── Order state machine (spec section 27) ───────────────────────────
// Deliver: seller only, PAID -> DELIVERED.
function deliverOrder(db, sellerId, orderId, deliveryData) {
  ensureMarketplaceTables(db);
  const order = getOrderRaw(db, orderId);
  if (!order) throw new MarketplaceError('ORDER_NOT_FOUND', 'Order not found', 404);
  if (order.seller_id !== sellerId) throw new MarketplaceError('NOT_AUTHORIZED', 'Not authorized', 403);
  if (order.status !== 'PAID') throw new MarketplaceError('INVALID_STATE', 'Order cannot be delivered from its current state');

  if (deliveryData !== undefined && deliveryData !== null) {
    if (typeof deliveryData !== 'string' || deliveryData.length > 4000) {
      throw new MarketplaceError('INVALID_DELIVERY_DATA', 'Delivery data is too long');
    }
  }

  const now = Date.now();
  run(db, `UPDATE marketplace_orders SET status = 'DELIVERED', seller_delivered = 1, delivery_data = ?, updated_at = ? WHERE id = ?`,
    [deliveryData || null, now, orderId]);
  return formatOrder(db, getOrderRaw(db, orderId));
}

// Recomputes a seller's vendor stats/badges from marketplace_orders +
// marketplace_reviews. Called after any order reaches a terminal state
// (completed/refunded/cancelled) and after every new review. Must be
// called from inside the same synchronous block as the write that
// triggered it (no awaits in between) — see concurrency note at top.
function recalcVendorStats(db, sellerId) {
  getOrCreateVendor(db, sellerId);
  const completed = get(db, `SELECT COUNT(*) AS c FROM marketplace_orders WHERE seller_id = ? AND status = 'COMPLETED'`, [sellerId]).c;
  // "Terminal" orders are the ones that count toward a completion rate:
  // ones that were paid for and then either finished or fell through.
  // Still-open PAID/DELIVERED orders aren't counted against the seller yet.
  const terminal = get(db, `
    SELECT COUNT(*) AS c FROM marketplace_orders
    WHERE seller_id = ? AND status IN ('COMPLETED', 'REFUNDED', 'CANCELLED', 'DISPUTED')
  `, [sellerId]).c;
  const reviewStats = get(db, `SELECT COUNT(*) AS c, COALESCE(SUM(rating), 0) AS s FROM marketplace_reviews WHERE vendor_id = ?`, [sellerId]);
  const totalReviews = reviewStats.c;
  const ratingSum = reviewStats.s;
  const rating = totalReviews > 0 ? ratingSum / totalReviews : 0;
  const completionRate = terminal > 0 ? (completed / terminal) * 100 : 100;

  const trusted = completed >= TRUSTED.completedSales && totalReviews >= TRUSTED.totalReviews &&
    rating >= TRUSTED.rating && completionRate >= TRUSTED.completionRate;
  const elite = trusted && completed >= ELITE.completedSales && rating >= ELITE.rating && completionRate >= ELITE.completionRate;

  run(db, `
    UPDATE marketplace_vendors SET
      total_sales = ?, completed_sales = ?, total_reviews = ?, rating_sum = ?, completion_rate = ?,
      trusted_vendor = ?, elite_vendor = ?, updated_at = ?
    WHERE user_id = ?
  `, [completed, completed, totalReviews, ratingSum, completionRate, trusted ? 1 : 0, elite ? 1 : 0, Date.now(), sellerId]);
}

// Confirm: buyer only, DELIVERED -> COMPLETED, releases escrow to seller.
function confirmOrder(db, buyerId, orderId) {
  ensureMarketplaceTables(db);
  run(db, 'BEGIN TRANSACTION');
  try {
    const order = getOrderRaw(db, orderId);
    if (!order) throw new MarketplaceError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (order.buyer_id !== buyerId) throw new MarketplaceError('NOT_AUTHORIZED', 'Not authorized', 403);
    if (order.status !== 'DELIVERED') throw new MarketplaceError('INVALID_STATE', 'Order cannot be confirmed from its current state');
    if (order.escrow_status !== 'held') throw new MarketplaceError('ESCROW_ALREADY_RESOLVED', 'This order has already been settled');

    const sellerWallet = getOrCreateWallet(db, order.seller_id);
    writeTransactionInline(db, {
      type: 'MARKETPLACE_SALE',
      status: 'COMPLETED',
      receiverWalletDbId: sellerWallet.id,
      amount: order.amount,
      description: `Marketplace sale payout (order ${order.id})`,
      metadata: { orderId: order.id },
      legs: [{ walletDbId: sellerWallet.id, amount: order.amount, direction: 'CREDIT' }],
    });
    markTransactionStatusInline(db, order.purchase_transaction_id, 'COMPLETED');

    const now = Date.now();
    run(db, `UPDATE marketplace_orders SET status = 'COMPLETED', buyer_confirmed = 1, escrow_status = 'released', completed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, orderId]);

    recalcVendorStats(db, order.seller_id);
    run(db, 'COMMIT');
    return formatOrder(db, getOrderRaw(db, orderId));
  } catch (e) {
    try { run(db, 'ROLLBACK'); } catch (e2) { /* best-effort */ }
    throw e;
  }
}

// Cancel: buyer only, and only before the seller has delivered anything.
// Refunds escrow, restores stock, reactivates the listing if it had sold out.
function cancelOrder(db, buyerId, orderId) {
  ensureMarketplaceTables(db);
  run(db, 'BEGIN TRANSACTION');
  try {
    const order = getOrderRaw(db, orderId);
    if (!order) throw new MarketplaceError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (order.buyer_id !== buyerId) throw new MarketplaceError('NOT_AUTHORIZED', 'Not authorized', 403);
    if (order.status !== 'PAID') throw new MarketplaceError('INVALID_STATE', 'Order can only be cancelled before the seller delivers it');
    if (order.escrow_status !== 'held') throw new MarketplaceError('ESCROW_ALREADY_RESOLVED', 'This order has already been settled');

    refundEscrowInline(db, order);

    const now = Date.now();
    run(db, `UPDATE marketplace_orders SET status = 'CANCELLED', escrow_status = 'refunded', updated_at = ? WHERE id = ?`, [now, orderId]);

    const listing = get(db, 'SELECT * FROM marketplace_items WHERE id = ?', [order.item_id]);
    if (listing) {
      const restoredStock = listing.stock + order.quantity;
      const restoredStatus = listing.status === 'SOLD' ? 'ACTIVE' : listing.status;
      run(db, 'UPDATE marketplace_items SET stock = ?, status = ?, updated_at = ? WHERE id = ?',
        [restoredStock, restoredStatus, now, listing.id]);
    }

    recalcVendorStats(db, order.seller_id);
    run(db, 'COMMIT');
    return formatOrder(db, getOrderRaw(db, orderId));
  } catch (e) {
    try { run(db, 'ROLLBACK'); } catch (e2) { /* best-effort */ }
    throw e;
  }
}

// Shared refund primitive (buyer cancel + admin dispute resolution).
// Caller must already be inside a BEGIN/COMMIT block.
function refundEscrowInline(db, order) {
  const buyerWallet = getOrCreateWallet(db, order.buyer_id);
  writeTransactionInline(db, {
    type: 'MARKETPLACE_REFUND',
    status: 'COMPLETED',
    receiverWalletDbId: buyerWallet.id,
    amount: order.amount,
    description: `Marketplace refund (order ${order.id})`,
    metadata: { orderId: order.id },
    legs: [{ walletDbId: buyerWallet.id, amount: order.amount, direction: 'CREDIT' }],
  });
  markTransactionStatusInline(db, order.purchase_transaction_id, 'REFUNDED');
}

// ── Disputes (spec sections 17-18) ──────────────────────────────────
function openDispute(db, userId, orderId, { reason, description }) {
  ensureMarketplaceTables(db);
  const order = getOrderRaw(db, orderId);
  if (!order) throw new MarketplaceError('ORDER_NOT_FOUND', 'Order not found', 404);
  requireOrderParty(order, userId);
  if (!['PAID', 'DELIVERED'].includes(order.status)) {
    throw new MarketplaceError('INVALID_STATE', 'This order cannot be disputed from its current state');
  }
  if (!DISPUTE_REASONS.includes(reason)) {
    throw new MarketplaceError('INVALID_REASON', `Reason must be one of: ${DISPUTE_REASONS.join(', ')}`);
  }
  const desc = typeof description === 'string' ? description.trim() : '';
  if (!desc) throw new MarketplaceError('INVALID_DESCRIPTION', 'Description is required');
  if (desc.length > MAX_DISPUTE_DESCRIPTION) throw new MarketplaceError('INVALID_DESCRIPTION', 'Description is too long');

  const now = Date.now();
  const disputeId = crypto.randomUUID();
  run(db, 'BEGIN TRANSACTION');
  try {
    run(db, `
      INSERT INTO marketplace_disputes (id, order_id, opened_by, reason, description, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `, [disputeId, orderId, userId, reason, desc, now]);
    run(db, `UPDATE marketplace_orders SET status = 'DISPUTED', dispute_id = ?, updated_at = ? WHERE id = ?`, [disputeId, now, orderId]);
    run(db, 'COMMIT');
  } catch (e) {
    try { run(db, 'ROLLBACK'); } catch (e2) { /* best-effort */ }
    throw e;
  }
  return get(db, 'SELECT * FROM marketplace_disputes WHERE id = ?', [disputeId]);
}

function adminListDisputes(db, { status, page, limit } = {}) {
  ensureMarketplaceTables(db);
  page = clampInt(page, 1, 1_000_000, 1);
  limit = clampInt(limit, 1, 100, 20);
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(db, `SELECT * FROM marketplace_disputes ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit]);
  return { disputes: rows };
}

function adminGetDispute(db, disputeId) {
  ensureMarketplaceTables(db);
  const dispute = get(db, 'SELECT * FROM marketplace_disputes WHERE id = ?', [disputeId]);
  if (!dispute) throw new MarketplaceError('DISPUTE_NOT_FOUND', 'Dispute not found', 404);
  const order = getOrderRaw(db, dispute.order_id);
  return { dispute, order: order ? formatOrder(db, order) : null };
}

function adminResolveDispute(db, adminId, disputeId, { resolution, note }) {
  ensureMarketplaceTables(db);
  if (!['resolved_buyer', 'resolved_seller', 'closed'].includes(resolution)) {
    throw new MarketplaceError('INVALID_RESOLUTION', "Resolution must be 'resolved_buyer', 'resolved_seller', or 'closed'");
  }
  run(db, 'BEGIN TRANSACTION');
  try {
    const dispute = get(db, 'SELECT * FROM marketplace_disputes WHERE id = ?', [disputeId]);
    if (!dispute) throw new MarketplaceError('DISPUTE_NOT_FOUND', 'Dispute not found', 404);
    if (dispute.status !== 'open' && dispute.status !== 'investigating') {
      throw new MarketplaceError('DISPUTE_ALREADY_RESOLVED', 'This dispute has already been resolved');
    }
    const order = getOrderRaw(db, dispute.order_id);
    if (!order) throw new MarketplaceError('ORDER_NOT_FOUND', 'Order not found', 404);

    const now = Date.now();
    if (resolution === 'resolved_buyer') {
      if (order.escrow_status !== 'held') throw new MarketplaceError('ESCROW_ALREADY_RESOLVED', 'This order has already been settled');
      refundEscrowInline(db, order);
      run(db, `UPDATE marketplace_orders SET status = 'REFUNDED', escrow_status = 'refunded', updated_at = ? WHERE id = ?`, [now, order.id]);
      const listing = get(db, 'SELECT * FROM marketplace_items WHERE id = ?', [order.item_id]);
      if (listing) {
        const restoredStock = listing.stock + order.quantity;
        const restoredStatus = listing.status === 'SOLD' ? 'ACTIVE' : listing.status;
        run(db, 'UPDATE marketplace_items SET stock = ?, status = ?, updated_at = ? WHERE id = ?',
          [restoredStock, restoredStatus, now, listing.id]);
      }
    } else if (resolution === 'resolved_seller') {
      if (order.escrow_status !== 'held') throw new MarketplaceError('ESCROW_ALREADY_RESOLVED', 'This order has already been settled');
      const sellerWallet = getOrCreateWallet(db, order.seller_id);
      writeTransactionInline(db, {
        type: 'MARKETPLACE_SALE',
        status: 'COMPLETED',
        receiverWalletDbId: sellerWallet.id,
        amount: order.amount,
        description: `Marketplace sale payout after dispute resolution (order ${order.id})`,
        metadata: { orderId: order.id, disputeId },
        legs: [{ walletDbId: sellerWallet.id, amount: order.amount, direction: 'CREDIT' }],
      });
      markTransactionStatusInline(db, order.purchase_transaction_id, 'COMPLETED');
      run(db, `UPDATE marketplace_orders SET status = 'COMPLETED', escrow_status = 'released', completed_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, order.id]);
    }
    // 'closed' — dispute closed with no money movement (e.g. withdrawn,
    // resolved informally); order keeps its DISPUTED status.

    run(db, `UPDATE marketplace_disputes SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`,
      [resolution, typeof note === 'string' ? note.slice(0, 2000) : null, adminId, now, disputeId]);

    recalcVendorStats(db, order.seller_id);
    run(db, 'COMMIT');
    return { dispute: get(db, 'SELECT * FROM marketplace_disputes WHERE id = ?', [disputeId]), order: formatOrder(db, getOrderRaw(db, order.id)) };
  } catch (e) {
    try { run(db, 'ROLLBACK'); } catch (e2) { /* best-effort */ }
    throw e;
  }
}

// ── Reviews (spec section 13) ───────────────────────────────────────
function addReview(db, buyerId, orderId, { rating, comment }) {
  ensureMarketplaceTables(db);
  rating = parseInt(rating, 10);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new MarketplaceError('INVALID_RATING', 'Rating must be an integer from 1 to 5');
  }
  const cmt = typeof comment === 'string' ? comment.trim().slice(0, MAX_COMMENT) : null;

  run(db, 'BEGIN TRANSACTION');
  try {
    const order = getOrderRaw(db, orderId);
    if (!order) throw new MarketplaceError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (order.buyer_id !== buyerId) throw new MarketplaceError('NOT_AUTHORIZED', 'You cannot review this order');
    if (order.status !== 'COMPLETED') throw new MarketplaceError('ORDER_NOT_COMPLETED', 'Only completed orders can be reviewed');
    const existing = get(db, 'SELECT id FROM marketplace_reviews WHERE order_id = ?', [orderId]);
    if (existing) throw new MarketplaceError('REVIEW_EXISTS', 'Review already exists');

    const id = crypto.randomUUID();
    run(db, `
      INSERT INTO marketplace_reviews (id, order_id, reviewer_id, vendor_id, rating, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, orderId, buyerId, order.seller_id, rating, cmt, Date.now()]);

    recalcVendorStats(db, order.seller_id);
    run(db, 'COMMIT');
    return { review: get(db, 'SELECT * FROM marketplace_reviews WHERE id = ?', [id]), vendor: vendorSummary(db, order.seller_id) };
  } catch (e) {
    try { run(db, 'ROLLBACK'); } catch (e2) { /* best-effort */ }
    throw e;
  }
}

// ── Vendor profile (spec section 14) ────────────────────────────────
function getVendorProfile(db, userId) {
  ensureMarketplaceTables(db);
  const user = get(db, 'SELECT id FROM users WHERE id = ?', [userId]);
  if (!user) throw new MarketplaceError('VENDOR_NOT_FOUND', 'Vendor not found', 404);
  const summary = vendorSummary(db, userId);
  const listings = all(db, `SELECT * FROM marketplace_items WHERE seller_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 24`, [userId])
    .map(r => formatListing(db, r));
  return { vendor: summary, listings };
}

function getVendorReviews(db, userId, { page, limit } = {}) {
  ensureMarketplaceTables(db);
  page = clampInt(page, 1, 1_000_000, 1);
  limit = clampInt(limit, 1, 50, 20);
  const rows = all(db, `
    SELECT r.*, u.username AS reviewer_username
    FROM marketplace_reviews r JOIN users u ON u.id = r.reviewer_id
    WHERE r.vendor_id = ? ORDER BY r.created_at DESC LIMIT ? OFFSET ?
  `, [userId, limit, (page - 1) * limit]);
  return {
    reviews: rows.map(r => ({
      id: r.id, rating: r.rating, comment: r.comment, createdAt: r.created_at, reviewerUsername: r.reviewer_username,
    })),
  };
}

module.exports = {
  MarketplaceError,
  CATEGORIES,
  SORTS,
  DELIVERY_TYPES,
  DISPUTE_REASONS,
  listListings,
  getListing,
  createListing,
  updateListing,
  removeListing,
  purchase,
  getOrder,
  listPurchases,
  listSales,
  deliverOrder,
  confirmOrder,
  cancelOrder,
  openDispute,
  adminListDisputes,
  adminGetDispute,
  adminResolveDispute,
  addReview,
  getVendorProfile,
  getVendorReviews,
};
