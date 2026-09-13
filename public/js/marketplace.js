// marketplace.js — Marketplace frontend. Classic script, same pattern as
// wallet.js: shares the global lexical environment with dashboard.js/
// state.js/utils.js (token, currentUser, api(), toast(), escapeHtml(),
// versionedMediaUrl()). Talks only to /api/marketplace — the server is
// always the source of truth for price, balance, and ownership; this
// file never computes a price or a balance itself, only displays what
// the API returns (spec section 26).

const MP_API = '';

let _mpPage = 1;
let _mpPages = 1;
let _mpSearchTimer = null;
let _mpCurrentListing = null;   // full listing detail currently shown
let _mpCurrentOrder = null;     // full order detail currently shown
let _mpManageTab = 'purchases';
let _mpEditingListingId = null; // set when the sell form is editing, not creating
let _mpReviewOrderId = null;
let _mpDisputeOrderId = null;
let _mpPurchaseListingId = null;
let _mpReviewRating = 0;

async function marketplaceApi(method, path, body) {
  const res = await fetch(MP_API + '/api/marketplace' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong');
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

function mpShowView(id) {
  document.querySelectorAll('#marketplace-panel .mp-view').forEach(el => { el.style.display = 'none'; });
  document.getElementById(id).style.display = 'flex';
}

function mpCloseModal(id) { document.getElementById(id).style.display = 'none'; }

function mpStatusClass(status) { return (status || '').toLowerCase(); }

function mpStatusLabel(status) {
  const map = { PAID: 'Paid', DELIVERED: 'Waiting for you', COMPLETED: 'Completed', CANCELLED: 'Cancelled', DISPUTED: 'Disputed', REFUNDED: 'Refunded' };
  return map[status] || status;
}

function mpStars(rating) {
  if (rating === null || rating === undefined) return 'No ratings yet';
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(5 - full) + ` ${rating.toFixed(2)}`;
}

// ─── Panel entry point ──────────────────────────────────────────────
async function initMarketplacePanel() {
  mpShowView('mp-browse-view');
  _mpPage = 1;
  mpRefreshBalance();
  await mpReloadListings();
}

async function mpRefreshBalance() {
  try {
    const data = await api('GET', '/wallet');
    if (data && data.wallet) {
      document.getElementById('mp-balance-pill').textContent = data.wallet.balanceDisplay + ' NX';
    }
  } catch { /* non-critical */ }
}

// ─── Browse ─────────────────────────────────────────────────────────
function mpOnSearchInput() {
  clearTimeout(_mpSearchTimer);
  _mpSearchTimer = setTimeout(() => { _mpPage = 1; mpReloadListings(); }, 350);
}

async function mpReloadListings() {
  const grid = document.getElementById('mp-listings-grid');
  grid.innerHTML = '<div class="mp-empty">Loading…</div>';
  const category = document.getElementById('mp-category-select').value;
  const sort = document.getElementById('mp-sort-select').value;
  const search = document.getElementById('mp-search-input').value.trim();
  const params = new URLSearchParams({ page: _mpPage, limit: 24 });
  if (category) params.set('category', category);
  if (sort) params.set('sort', sort);
  if (search) params.set('search', search);

  try {
    const data = await marketplaceApi('GET', '/listings?' + params.toString());
    _mpPages = data.pagination.pages;
    renderListingsGrid(data.listings);
    const pag = document.getElementById('mp-pagination');
    if (data.pagination.pages > 1) {
      pag.style.display = 'flex';
      document.getElementById('mp-page-label').textContent = `Page ${data.pagination.page} of ${data.pagination.pages}`;
      document.getElementById('mp-prev-page').disabled = data.pagination.page <= 1;
      document.getElementById('mp-next-page').disabled = data.pagination.page >= data.pagination.pages;
    } else {
      pag.style.display = 'none';
    }
  } catch (e) {
    grid.innerHTML = `<div class="mp-empty">${escapeHtml(e.message || 'Failed to load listings')}</div>`;
  }
}

function mpChangePage(delta) {
  const next = _mpPage + delta;
  if (next < 1 || next > _mpPages) return;
  _mpPage = next;
  mpReloadListings();
}

function renderListingsGrid(listings) {
  const grid = document.getElementById('mp-listings-grid');
  if (!listings.length) {
    grid.innerHTML = '<div class="mp-empty">No listings found. Try a different search or category.</div>';
    return;
  }
  grid.innerHTML = listings.map(l => `
    <div class="mp-card" onclick="mpOpenListing('${l.id}')">
      <div class="mp-card-image" style="${l.imageUrl ? `background-image:url('${versionedMediaUrl(l.imageUrl)}')` : ''}">${l.imageUrl ? '' : escapeHtml(l.title.charAt(0).toUpperCase())}</div>
      <div class="mp-card-title">${escapeHtml(l.title)}</div>
      <div class="mp-card-price">${l.priceNx} NX<small>$${l.priceUsd} USD</small></div>
      <div class="mp-card-seller">
        ${l.seller.trusted ? '<span class="mp-badge trusted">🛡 Trusted</span>' : ''}
        <span>@${escapeHtml(l.seller.username || 'unknown')}</span>
      </div>
      <div class="mp-card-seller">
        <span>${l.seller.rating !== null ? '★ ' + l.seller.rating.toFixed(1) : 'No ratings'}</span>
        <span>·</span>
        <span>${l.seller.sales} sales</span>
        ${l.stock <= 2 ? `<span class="mp-badge stock-low">${l.stock} left</span>` : ''}
      </div>
    </div>
  `).join('');
}

function mpBackToBrowse() { mpShowView('mp-browse-view'); mpReloadListings(); mpRefreshBalance(); }

// ─── Listing detail ─────────────────────────────────────────────────
async function mpOpenListing(id) {
  mpShowView('mp-listing-view');
  const body = document.getElementById('mp-listing-body');
  body.innerHTML = '<div class="mp-empty">Loading…</div>';
  try {
    const data = await marketplaceApi('GET', '/listings/' + id);
    _mpCurrentListing = data.listing;
    renderListingDetail(data.listing);
  } catch (e) {
    body.innerHTML = `<div class="mp-empty">${escapeHtml(e.message)}</div>`;
  }
}

function renderListingDetail(l) {
  const isOwn = currentUser && l.seller.id === currentUser.id;
  const body = document.getElementById('mp-listing-body');
  body.innerHTML = `
    <div class="mp-detail-image" style="${l.imageUrl ? `background-image:url('${versionedMediaUrl(l.imageUrl)}')` : ''}"></div>
    <div class="mp-detail-title">${escapeHtml(l.title)}</div>
    <div class="mp-detail-price">${l.priceNx} NX <small>≈ $${l.priceUsd} USD</small></div>
    <div class="mp-detail-desc">${escapeHtml(l.description)}</div>
    <div class="mp-seller-card" onclick="mpOpenVendor('${l.seller.id}')">
      <div class="mp-seller-avatar">${escapeHtml((l.seller.displayName || l.seller.username || '?').charAt(0).toUpperCase())}</div>
      <div>
        <div style="font-weight:700;">${l.seller.trusted ? '🛡 ' : ''}@${escapeHtml(l.seller.username || 'unknown')}</div>
        <div class="mp-seller-meta">${mpStars(l.seller.rating)} · ${l.seller.reviews} reviews · ${l.seller.sales} sales · ${l.seller.completionRate}% completion</div>
      </div>
    </div>
    <div class="mp-form-hint">Stock: ${l.stock} · Delivery: ${l.deliveryType === 'instant' ? 'Instant' : 'Manual'}</div>
    <div class="modal-actions" style="justify-content:flex-start; margin-top:16px;">
      ${isOwn
        ? `<span class="mp-form-hint">This is your own listing — manage it from My Listings.</span>`
        : (l.status === 'ACTIVE' && l.stock > 0
            ? `<button class="btn-primary" onclick="mpOpenPurchaseModal('${l.id}')">Buy Now</button>`
            : `<span class="mp-badge status">No longer available</span>`)}
    </div>
  `;
}

// ─── Purchase flow ──────────────────────────────────────────────────
function mpOpenPurchaseModal(listingId) {
  const l = _mpCurrentListing;
  if (!l || l.id !== listingId) return;
  _mpPurchaseListingId = listingId;
  document.getElementById('mp-purchase-title').textContent = `Purchase "${l.title}"?`;
  document.getElementById('mp-purchase-amount').textContent = l.priceNx + ' NX';
  document.getElementById('mp-purchase-qty').textContent = '1';
  document.getElementById('mp-purchase-total').textContent = l.priceNx + ' NX';
  document.getElementById('mp-purchase-error').textContent = '';
  document.getElementById('mp-purchase-modal').style.display = 'flex';
}

async function mpConfirmPurchase() {
  const btn = document.getElementById('mp-purchase-confirm-btn');
  const errEl = document.getElementById('mp-purchase-error');
  errEl.textContent = '';
  btn.disabled = true;
  try {
    const data = await marketplaceApi('POST', `/listings/${_mpPurchaseListingId}/purchase`, { quantity: 1 });
    mpCloseModal('mp-purchase-modal');
    toast('Purchase complete — funds are held in escrow until you confirm delivery.');
    mpOpenOrder(data.order.id);
  } catch (e) {
    errEl.textContent = e.message || 'Purchase failed';
  } finally {
    btn.disabled = false;
  }
}

// ─── Sell ───────────────────────────────────────────────────────────
function mpOpenSell(editListing) {
  mpShowView('mp-sell-view');
  _mpEditingListingId = editListing ? editListing.id : null;
  document.querySelector('#mp-sell-view .mp-title').textContent = editListing ? 'Edit Listing' : 'Create Listing';
  document.getElementById('mp-sell-submit-btn').textContent = editListing ? 'Save Changes' : 'Publish Listing';
  document.getElementById('mp-f-title').value = editListing ? editListing.title : '';
  document.getElementById('mp-f-category').value = editListing ? editListing.category : 'gaming';
  document.getElementById('mp-f-description').value = editListing ? editListing.description : '';
  document.getElementById('mp-f-price').value = editListing ? editListing.priceNx : '';
  document.getElementById('mp-f-stock').value = editListing ? editListing.stock : 1;
  document.getElementById('mp-f-delivery').value = editListing ? editListing.deliveryType : 'manual';
  mpUpdatePricePreview();
}

function mpUpdatePricePreview() {
  const raw = document.getElementById('mp-f-price').value;
  const n = parseFloat(raw);
  document.getElementById('mp-f-price-preview').textContent = Number.isFinite(n) ? `$${n.toFixed(2)} USD` : '$0.00 USD';
}

async function mpSubmitListing(event) {
  event.preventDefault();
  const btn = document.getElementById('mp-sell-submit-btn');
  btn.disabled = true;
  const payload = {
    title: document.getElementById('mp-f-title').value,
    category: document.getElementById('mp-f-category').value,
    description: document.getElementById('mp-f-description').value,
    price_nx: document.getElementById('mp-f-price').value,
    stock: document.getElementById('mp-f-stock').value,
    delivery_type: document.getElementById('mp-f-delivery').value,
  };
  try {
    if (_mpEditingListingId) {
      await marketplaceApi('PATCH', '/listings/' + _mpEditingListingId, payload);
      toast('Listing updated.');
    } else {
      await marketplaceApi('POST', '/listings', payload);
      toast('Listing published.');
    }
    mpOpenManage();
    mpSwitchManageTab('listings');
  } catch (e) {
    toast(e.message || 'Could not save listing', true);
  } finally {
    btn.disabled = false;
  }
  return false;
}

// ─── Manage: Purchases / Sales / My Listings ───────────────────────
function mpOpenManage() {
  mpShowView('mp-manage-view');
  mpSwitchManageTab(_mpManageTab || 'purchases');
}

function mpBackToManage() { mpOpenManage(); }

function mpSwitchManageTab(tab) {
  _mpManageTab = tab;
  document.querySelectorAll('#mp-manage-view .mp-tab').forEach(el => el.classList.remove('active'));
  document.getElementById('mp-tab-' + tab).classList.add('active');
  if (tab === 'purchases') renderPurchasesList();
  else if (tab === 'sales') renderSalesList();
  else renderMyListingsList();
}

async function renderPurchasesList() {
  const body = document.getElementById('mp-manage-body');
  body.innerHTML = '<div class="mp-empty">Loading…</div>';
  try {
    const data = await marketplaceApi('GET', '/orders/purchases');
    if (!data.orders.length) { body.innerHTML = '<div class="mp-empty">You haven\'t purchased anything yet.</div>'; return; }
    body.innerHTML = data.orders.map(o => `
      <div class="mp-order-row" onclick="mpOpenOrder('${o.id}')">
        <div class="mp-row-thumb">📦</div>
        <div class="mp-row-main">
          <div class="mp-row-title">Order #${o.id.slice(0, 8)}</div>
          <div class="mp-row-sub">${o.totalPriceNx} NX · ${new Date(o.createdAt).toLocaleDateString()}</div>
        </div>
        <div class="mp-row-status ${mpStatusClass(o.status)}">${mpStatusLabel(o.status)}</div>
      </div>
    `).join('');
  } catch (e) {
    body.innerHTML = `<div class="mp-empty">${escapeHtml(e.message)}</div>`;
  }
}

async function renderSalesList() {
  const body = document.getElementById('mp-manage-body');
  body.innerHTML = '<div class="mp-empty">Loading…</div>';
  try {
    const data = await marketplaceApi('GET', '/orders/sales');
    if (!data.orders.length) { body.innerHTML = '<div class="mp-empty">No sales yet.</div>'; return; }
    body.innerHTML = data.orders.map(o => `
      <div class="mp-order-row" onclick="mpOpenOrder('${o.id}')">
        <div class="mp-row-thumb">💰</div>
        <div class="mp-row-main">
          <div class="mp-row-title">Order #${o.id.slice(0, 8)}</div>
          <div class="mp-row-sub">${o.totalPriceNx} NX · ${new Date(o.createdAt).toLocaleDateString()}</div>
        </div>
        <div class="mp-row-status ${mpStatusClass(o.status)}">${mpStatusLabel(o.status)}</div>
      </div>
    `).join('');
  } catch (e) {
    body.innerHTML = `<div class="mp-empty">${escapeHtml(e.message)}</div>`;
  }
}

async function renderMyListingsList() {
  const body = document.getElementById('mp-manage-body');
  body.innerHTML = '<div class="mp-empty">Loading…</div>';
  try {
    // No dedicated "my listings" endpoint exists (spec never asked for
    // one) — vendor profile already returns a seller's active listings,
    // which covers the common case. Paused/sold/removed listings a
    // seller wants to manage individually can still be reached via the
    // browse grid + edit, but won't show here. Documented as a known
    // gap in the delivery summary.
    const data = await marketplaceApi('GET', '/vendors/' + currentUser.id);
    if (!data.listings.length) { body.innerHTML = '<div class="mp-empty">You have no active listings. Tap + above to create one.</div>'; return; }
    body.innerHTML = data.listings.map(l => `
      <div class="mp-listing-row">
        <div class="mp-row-thumb" style="${l.imageUrl ? `background-image:url('${versionedMediaUrl(l.imageUrl)}');background-size:cover;` : ''}">${l.imageUrl ? '' : '🛒'}</div>
        <div class="mp-row-main" onclick="mpOpenListing('${l.id}')">
          <div class="mp-row-title">${escapeHtml(l.title)}</div>
          <div class="mp-row-sub">${l.priceNx} NX · Stock ${l.stock} · ${l.status}</div>
        </div>
        <div class="mp-row-actions">
          <button class="btn-cancel" onclick="event.stopPropagation(); mpEditListingById('${l.id}')">Edit</button>
          <button class="btn-cancel" onclick="event.stopPropagation(); mpRemoveListing('${l.id}')">Remove</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    body.innerHTML = `<div class="mp-empty">${escapeHtml(e.message)}</div>`;
  }
}

async function mpEditListingById(id) {
  try {
    const data = await marketplaceApi('GET', '/listings/' + id);
    mpOpenSell(data.listing);
  } catch (e) {
    toast(e.message || 'Could not load listing', true);
  }
}

async function mpRemoveListing(id) {
  if (!confirm('Remove this listing? This cannot be undone.')) return;
  try {
    await marketplaceApi('DELETE', '/listings/' + id);
    toast('Listing removed.');
    renderMyListingsList();
  } catch (e) {
    toast(e.message || 'Could not remove listing', true);
  }
}

// ─── Order detail ───────────────────────────────────────────────────
async function mpOpenOrder(orderId) {
  mpShowView('mp-order-view');
  const body = document.getElementById('mp-order-body');
  body.innerHTML = '<div class="mp-empty">Loading…</div>';
  try {
    const data = await marketplaceApi('GET', '/orders/' + orderId);
    _mpCurrentOrder = data.order;
    renderOrderDetail(data.order);
  } catch (e) {
    body.innerHTML = `<div class="mp-empty">${escapeHtml(e.message)}</div>`;
  }
}

function renderOrderDetail(o) {
  const isBuyer = currentUser && o.buyerId === currentUser.id;
  const isSeller = currentUser && o.sellerId === currentUser.id;
  const body = document.getElementById('mp-order-body');

  let actions = '';
  if (isSeller && o.status === 'PAID') {
    actions = `
      <label>Delivery details (sent to buyer)</label>
      <textarea id="mp-deliver-data" maxlength="4000" placeholder="Account credentials, download link, instructions…"></textarea>
      <div class="modal-actions" style="justify-content:flex-start; margin-top:10px;">
        <button class="btn-primary" onclick="mpDeliverOrder('${o.id}')">Mark as Delivered</button>
      </div>`;
  } else if (isBuyer && o.status === 'PAID') {
    actions = `<div class="mp-order-actions"><button class="btn-cancel" onclick="mpCancelOrder('${o.id}')">Cancel Order</button></div>`;
  } else if (isBuyer && o.status === 'DELIVERED') {
    actions = `
      <div class="mp-order-actions">
        <button class="btn-primary" onclick="mpConfirmReceipt('${o.id}')">Confirm Receipt</button>
        <button class="btn-cancel" onclick="mpOpenDisputeModal('${o.id}')">Open Dispute</button>
      </div>`;
  } else if (isSeller && o.status === 'DELIVERED') {
    actions = `<div class="mp-form-hint">Waiting for the buyer to confirm receipt.</div>`;
  } else if (isBuyer && o.status === 'COMPLETED') {
    actions = `<div class="mp-order-actions"><button class="btn-primary" onclick="mpOpenReviewModal('${o.id}')">Leave a Review</button></div>`;
  }

  body.innerHTML = `
    <div class="mp-order-summary">
      <div class="mp-order-summary-row"><span>Order</span><span>#${o.id.slice(0, 8)}</span></div>
      <div class="mp-order-summary-row"><span>Quantity</span><span>${o.quantity}</span></div>
      <div class="mp-order-summary-row"><span>Unit price</span><span>${o.unitPriceNx} NX</span></div>
      <div class="mp-order-summary-row"><span>Total</span><span>${o.totalPriceNx} NX</span></div>
      <div class="mp-order-summary-row"><span>Status</span><span class="mp-row-status ${mpStatusClass(o.status)}">${mpStatusLabel(o.status)}</span></div>
      <div class="mp-order-summary-row"><span>Escrow</span><span>${o.escrowStatus}</span></div>
    </div>
    ${o.deliveryData ? `<div class="mp-delivery-box">${escapeHtml(o.deliveryData)}</div>` : ''}
    ${actions}
  `;
}

async function mpDeliverOrder(orderId) {
  const deliveryData = document.getElementById('mp-deliver-data').value;
  try {
    await marketplaceApi('POST', `/orders/${orderId}/deliver`, { deliveryData });
    toast('Marked as delivered.');
    mpOpenOrder(orderId);
  } catch (e) {
    toast(e.message || 'Could not mark as delivered', true);
  }
}

async function mpConfirmReceipt(orderId) {
  if (!confirm('Confirm you received this item? This releases payment to the seller and cannot be undone.')) return;
  try {
    await marketplaceApi('POST', `/orders/${orderId}/confirm`);
    toast('Confirmed — payment released to the seller.');
    mpOpenOrder(orderId);
  } catch (e) {
    toast(e.message || 'Could not confirm order', true);
  }
}

async function mpCancelOrder(orderId) {
  if (!confirm('Cancel this order and get a full refund?')) return;
  try {
    await marketplaceApi('POST', `/orders/${orderId}/cancel`);
    toast('Order cancelled and refunded.');
    mpOpenOrder(orderId);
  } catch (e) {
    toast(e.message || 'Could not cancel order', true);
  }
}

// ─── Disputes ───────────────────────────────────────────────────────
function mpOpenDisputeModal(orderId) {
  _mpDisputeOrderId = orderId;
  document.getElementById('mp-dispute-reason').value = 'item_not_received';
  document.getElementById('mp-dispute-description').value = '';
  document.getElementById('mp-dispute-error').textContent = '';
  document.getElementById('mp-dispute-modal').style.display = 'flex';
}

async function mpSubmitDispute() {
  const reason = document.getElementById('mp-dispute-reason').value;
  const description = document.getElementById('mp-dispute-description').value;
  const errEl = document.getElementById('mp-dispute-error');
  const btn = document.getElementById('mp-dispute-submit-btn');
  btn.disabled = true;
  try {
    await marketplaceApi('POST', `/orders/${_mpDisputeOrderId}/dispute`, { reason, description });
    mpCloseModal('mp-dispute-modal');
    toast('Dispute opened — an admin will review it.');
    mpOpenOrder(_mpDisputeOrderId);
  } catch (e) {
    errEl.textContent = e.message || 'Could not open dispute';
  } finally {
    btn.disabled = false;
  }
}

// ─── Reviews ────────────────────────────────────────────────────────
function mpOpenReviewModal(orderId) {
  _mpReviewOrderId = orderId;
  _mpReviewRating = 0;
  document.getElementById('mp-review-comment').value = '';
  document.getElementById('mp-review-error').textContent = '';
  mpRenderStars();
  document.getElementById('mp-review-modal').style.display = 'flex';
}

function mpRenderStars() {
  document.querySelectorAll('#mp-review-stars span').forEach(el => {
    const v = parseInt(el.dataset.star, 10);
    el.classList.toggle('active', v <= _mpReviewRating);
    el.onclick = () => { _mpReviewRating = v; mpRenderStars(); };
  });
}

async function mpSubmitReview() {
  const errEl = document.getElementById('mp-review-error');
  if (_mpReviewRating < 1) { errEl.textContent = 'Pick a star rating first.'; return; }
  const btn = document.getElementById('mp-review-submit-btn');
  btn.disabled = true;
  try {
    await marketplaceApi('POST', `/orders/${_mpReviewOrderId}/review`, {
      rating: _mpReviewRating,
      comment: document.getElementById('mp-review-comment').value,
    });
    mpCloseModal('mp-review-modal');
    toast('Thanks for the review!');
    mpOpenOrder(_mpReviewOrderId);
  } catch (e) {
    errEl.textContent = e.message || 'Could not submit review';
  } finally {
    btn.disabled = false;
  }
}

// ─── Vendor profile ─────────────────────────────────────────────────
async function mpOpenVendor(userId) {
  mpShowView('mp-vendor-view');
  const body = document.getElementById('mp-vendor-body');
  body.innerHTML = '<div class="mp-empty">Loading…</div>';
  try {
    const [profile, reviews] = await Promise.all([
      marketplaceApi('GET', '/vendors/' + userId),
      marketplaceApi('GET', '/vendors/' + userId + '/reviews'),
    ]);
    renderVendorProfile(profile.vendor, profile.listings, reviews.reviews);
  } catch (e) {
    body.innerHTML = `<div class="mp-empty">${escapeHtml(e.message)}</div>`;
  }
}

function renderVendorProfile(vendor, listings, reviews) {
  const body = document.getElementById('mp-vendor-body');
  document.querySelector('#mp-vendor-view .mp-title').textContent = '@' + (vendor.username || 'vendor');
  body.innerHTML = `
    <div class="mp-vendor-hero">
      <div class="mp-seller-avatar">${escapeHtml((vendor.displayName || vendor.username || '?').charAt(0).toUpperCase())}</div>
      <div style="font-weight:800; font-size:1.1rem;">${vendor.trusted ? '🛡 Trusted Vendor · ' : ''}@${escapeHtml(vendor.username || '')}</div>
      <div class="mp-form-hint">${mpStars(vendor.rating)}</div>
    </div>
    <div class="mp-vendor-stats">
      <div><b>${vendor.reviews}</b>reviews</div>
      <div><b>${vendor.sales}</b>sales</div>
      <div><b>${vendor.completionRate}%</b>completion</div>
    </div>
    <div style="font-weight:700; margin-bottom:8px;">Listings</div>
    <div class="mp-grid" style="margin-bottom:20px;">
      ${listings.length ? listings.map(l => `
        <div class="mp-card" onclick="mpOpenListing('${l.id}')">
          <div class="mp-card-image" style="${l.imageUrl ? `background-image:url('${versionedMediaUrl(l.imageUrl)}')` : ''}">${l.imageUrl ? '' : escapeHtml(l.title.charAt(0).toUpperCase())}</div>
          <div class="mp-card-title">${escapeHtml(l.title)}</div>
          <div class="mp-card-price">${l.priceNx} NX</div>
        </div>
      `).join('') : '<div class="mp-empty">No active listings.</div>'}
    </div>
    <div style="font-weight:700; margin-bottom:8px;">Reviews</div>
    ${reviews.length ? reviews.map(r => `
      <div class="mp-review-row">
        <div class="mp-review-stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>
        <div>${escapeHtml(r.comment || '')}</div>
        <div class="mp-form-hint">@${escapeHtml(r.reviewerUsername)} · ${new Date(r.createdAt).toLocaleDateString()}</div>
      </div>
    `).join('') : '<div class="mp-empty">No reviews yet.</div>'}
  `;
}
