// server/routes/adminMarketplace.js — admin-only marketplace endpoints
// (dispute review/resolution). Kept as a separate router mounted at
// /api/admin/marketplace, per spec section 18, so admin surface area is
// never mixed into the regular /api/marketplace router that ordinary
// users hit. Uses the existing role-based requireAdmin middleware —
// no separate/insecure frontend-only admin check.

const express = require('express');
const router = express.Router();
const { getUserDb } = require('../database/userDb');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  MarketplaceError,
  adminListDisputes,
  adminGetDispute,
  adminResolveDispute,
} = require('../services/marketplaceService');

function sendMarketplaceError(res, err) {
  if (err instanceof MarketplaceError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  console.error('Admin marketplace route error:', err);
  return res.status(500).json({ error: 'Internal server error' });
}

router.use(requireAuth, requireAdmin);

router.get('/disputes', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json(adminListDisputes(db, req.query));
  } catch (err) { sendMarketplaceError(res, err); }
});

router.get('/disputes/:id', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json(adminGetDispute(db, req.params.id));
  } catch (err) { sendMarketplaceError(res, err); }
});

router.post('/disputes/:id/resolve', async (req, res) => {
  try {
    const db = await getUserDb();
    const { resolution, note } = req.body || {};
    res.json(adminResolveDispute(db, req.user.id, req.params.id, { resolution, note }));
  } catch (err) { sendMarketplaceError(res, err); }
});

module.exports = router;
