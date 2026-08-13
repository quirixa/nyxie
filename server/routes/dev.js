// server/routes/dev.js — development-only helper endpoints. Only ever
// mounted when NODE_ENV !== 'production' (see server.js); devFaucet()
// in walletService.js also re-checks NODE_ENV itself as a second layer
// of defense in case this router is ever mounted somewhere unexpected.

const express = require('express');
const router = express.Router();
const { getUserDb } = require('../database/userDb');
const { requireAuth } = require('../middleware/auth');
const { toMinorUnits } = require('../services/currency');
const { WalletError, devFaucet } = require('../services/walletService');

// POST /api/dev/faucet — credit the current user's wallet with test NX.
// Body: { "amount": "5000" }
router.post('/faucet', requireAuth, async (req, res) => {
  try {
    const amountSubunits = toMinorUnits((req.body || {}).amount);
    if (amountSubunits === null || amountSubunits <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const db = await getUserDb();
    const transaction = devFaucet(db, { userId: req.user.id, amountSubunits, actorId: req.user.id });
    res.json({ transaction });
  } catch (err) {
    if (err instanceof WalletError) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code });
    }
    console.error('Dev faucet error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
