// server/routes/shop.js — NX cosmetics shop. HTTP plumbing only; all rules
// and every money/ownership write live in services/cosmetics.js.
//
//   GET  /api/shop                     catalog + what you own/equipped + balance
//   POST /api/shop/items/:id/purchase  buy one item with NX
//
// Equipping is NOT here: it goes through PATCH /api/users/me (so it's saved
// with the rest of the profile and broadcast to everyone), and that route
// refuses anything the user doesn't own.

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { getUserDb } = require('../database/userDb');
const { requireAuth } = require('../middleware/auth');
const { CosmeticsError, listShop, purchaseItem } = require('../services/cosmetics');
const { WalletError } = require('../services/walletService');

function sendError(res, err) {
  if (err instanceof CosmeticsError || err instanceof WalletError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  console.error('Shop route error:', err);
  return res.status(500).json({ error: 'Internal server error' });
}

router.use(requireAuth);

const purchaseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

router.get('/', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json(listShop(db, req.user.id));
  } catch (err) { sendError(res, err); }
});

router.post('/items/:id/purchase', purchaseLimiter, async (req, res) => {
  try {
    const db = await getUserDb();
    // Only the item id comes from the client; price/ownership/balance are
    // all re-derived server-side inside purchaseItem().
    purchaseItem(db, req.user.id, req.params.id);
    res.status(201).json({ ok: true, shop: listShop(db, req.user.id) });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
