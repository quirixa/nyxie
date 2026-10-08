// server/routes/marketplace.js — HTTP plumbing for the marketplace.
// All business logic and every DB write live in services/marketplaceService.js
// (and, for money movement, services/walletService.js); this file is just
// auth, request parsing, and mapping MarketplaceError -> HTTP status codes,
// same split as routes/wallet.js.

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { getUserDb } = require('../database/userDb');
const { requireAuth } = require('../middleware/auth');
const {
  MarketplaceError,
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
  addReview,
  getVendorProfile,
  getVendorReviews,
} = require('../services/marketplaceService');

function sendMarketplaceError(res, err) {
  if (err instanceof MarketplaceError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  console.error('Marketplace route error:', err);
  return res.status(500).json({ error: 'Internal server error' });
}

// Every marketplace route needs a signed-in user (spec section 26 —
// browsing is the one exception the spec allows to be public, but this
// app has no public/guest session concept elsewhere either, so browsing
// requires auth too, same as the rest of Nyxie's API).
router.use(requireAuth);

// Stronger rate limits on the actions the spec calls out (section 29) —
// layered on top of the app-wide limiter already mounted at /api/ in
// server.js.
function actionLimiter(max) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
  });
}
const createListingLimiter = actionLimiter(30);
const purchaseLimiter = actionLimiter(60);
const reviewLimiter = actionLimiter(30);
const disputeLimiter = actionLimiter(10);
const deliverLimiter = actionLimiter(60);

// ── Listings ─────────────────────────────────────────────────────────
router.get('/listings', async (req, res) => {
  try {
    const db = await getUserDb();
    const { category, search, sort, page, limit } = req.query;
    res.json(listListings(db, { category, search, sort, page, limit }));
  } catch (err) { sendMarketplaceError(res, err); }
});

router.get('/listings/:id', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json({ listing: getListing(db, req.params.id) });
  } catch (err) { sendMarketplaceError(res, err); }
});

router.post('/listings', createListingLimiter, async (req, res) => {
  try {
    const db = await getUserDb();
    // Seller ID always comes from the JWT — never from the request body.
    res.status(201).json({ listing: createListing(db, req.user.id, req.body || {}) });
  } catch (err) { sendMarketplaceError(res, err); }
});

router.patch('/listings/:id', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json({ listing: updateListing(db, req.user.id, req.params.id, req.body || {}) });
  } catch (err) { sendMarketplaceError(res, err); }
});

router.delete('/listings/:id', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json(removeListing(db, req.user.id, req.params.id));
  } catch (err) { sendMarketplaceError(res, err); }
});

// ── Orders ───────────────────────────────────────────────────────────
// Purchase: only listing id + quantity ever come from the client. Price,
// seller, and balance are all re-derived server-side inside purchase().
router.post('/listings/:id/purchase', purchaseLimiter, async (req, res) => {
  try {
    const db = await getUserDb();
    const quantity = (req.body && req.body.quantity !== undefined) ? req.body.quantity : 1;
    const order = purchase(db, { buyerId: req.user.id, listingId: req.params.id, quantity });
    res.status(201).json({ order: getOrder(db, req.user.id, order.id) });
  } catch (err) { sendMarketplaceError(res, err); }
});

router.get('/orders/purchases', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json(listPurchases(db, req.user.id, req.query));
  } catch (err) { sendMarketplaceError(res, err); }
});

router.get('/orders/sales', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json(listSales(db, req.user.id, req.query));
  } catch (err) { sendMarketplaceError(res, err); }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json({ order: getOrder(db, req.user.id, req.params.id) });
  } catch (err) { sendMarketplaceError(res, err); }
});

router.post('/orders/:id/deliver', deliverLimiter, async (req, res) => {
  try {
    const db = await getUserDb();
    const deliveryData = req.body ? req.body.deliveryData || req.body.delivery_data : undefined;
    res.json({ order: deliverOrder(db, req.user.id, req.params.id, deliveryData) });
  } catch (err) { sendMarketplaceError(res, err); }
});

router.post('/orders/:id/confirm', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json({ order: confirmOrder(db, req.user.id, req.params.id) });
  } catch (err) { sendMarketplaceError(res, err); }
});

router.post('/orders/:id/cancel', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json({ order: cancelOrder(db, req.user.id, req.params.id) });
  } catch (err) { sendMarketplaceError(res, err); }
});

router.post('/orders/:id/dispute', disputeLimiter, async (req, res) => {
  try {
    const db = await getUserDb();
    const { reason, description } = req.body || {};
    res.status(201).json({ dispute: openDispute(db, req.user.id, req.params.id, { reason, description }) });
  } catch (err) { sendMarketplaceError(res, err); }
});

router.post('/orders/:id/review', reviewLimiter, async (req, res) => {
  try {
    const db = await getUserDb();
    const { rating, comment } = req.body || {};
    res.status(201).json(addReview(db, req.user.id, req.params.id, { rating, comment }));
  } catch (err) { sendMarketplaceError(res, err); }
});

// ── Vendors ──────────────────────────────────────────────────────────
router.get('/vendors/:userId', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json(getVendorProfile(db, req.params.userId));
  } catch (err) { sendMarketplaceError(res, err); }
});

router.get('/vendors/:userId/reviews', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json(getVendorReviews(db, req.params.userId, req.query));
  } catch (err) { sendMarketplaceError(res, err); }
});

module.exports = router;
