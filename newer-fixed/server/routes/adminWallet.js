// server/routes/adminWallet.js — wallet actions restricted to the
// ADMIN role. Currently just fund-granting; setWalletStatus (freeze/
// unfreeze) already lives in routes/wallet.js behind its own admin
// check and isn't duplicated here.
//
// Same gate as routes/adminBadges.js: requireAuth loads the caller's
// row (including `role`) from the database on every request, and
// requireAdmin refuses anyone whose DB role isn't ADMIN.
//
// Unlike server/routes/dev.js's faucet, this is NOT gated on
// NODE_ENV — it's meant to work in production, since it's the real
// admin tool for crediting a user's wallet (e.g. support, promos,
// event rewards). It always credits someone *else's* wallet, chosen
// by username, and every grant is written to audit_logs via
// walletService.audit with the admin's id as actor.

const express = require('express');
const router = express.Router();
const { getUserDb, get } = require('../database/userDb');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { toMinorUnits } = require('../services/currency');
const { WalletError, adminGrantFunds, listAdminGrantLog, walletSummary, getOrCreateWallet } = require('../services/walletService');

router.use(requireAuth, requireAdmin);

// POST /api/admin/wallet/grant  { username, amount, note? }
// amount is in NX (major units), same as the rest of the wallet API —
// e.g. "500" or "500.25", not subunits.
router.post('/grant', async (req, res) => {
  try {
    const { username, amount, note } = req.body || {};
    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'username is required' });
    }

    const db = await getUserDb();
    const targetUser = get(db, 'SELECT id, username FROM users WHERE username = ?', [username.trim()]);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }

    const amountSubunits = toMinorUnits(amount);
    if (amountSubunits === null || amountSubunits <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (typeof note === 'string' && note.length > 280) {
      return res.status(400).json({ error: 'Note is too long (280 characters max)' });
    }

    const transaction = adminGrantFunds(db, {
      adminUserId: req.user.id,
      targetUserId: targetUser.id,
      amountSubunits,
      note: typeof note === 'string' ? note.trim() || undefined : undefined,
    });

    const wallet = walletSummary(db, getOrCreateWallet(db, targetUser.id));

    res.status(201).json({
      transaction,
      user: { id: targetUser.id, username: targetUser.username },
      wallet,
    });
  } catch (err) {
    if (err instanceof WalletError) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code });
    }
    console.error('Admin grant funds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/wallet/log?limit=15 — recent grants for the admin panel.
router.get('/log', async (req, res) => {
  try {
    const db = await getUserDb();
    const limit = parseInt(req.query.limit, 10) || 15;
    res.json({ entries: listAdminGrantLog(db, limit) });
  } catch (err) {
    console.error('Admin grant log error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
