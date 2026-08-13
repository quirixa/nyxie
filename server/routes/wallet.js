// server/routes/wallet.js — the actual Express router for the NX wallet
// backend. (Note: an earlier pass accidentally saved the *frontend*
// wallet.js script into this path, which is why the app never started
// with a working `/api/wallet` API — that file has been moved to
// public/js/wallet.js where it belongs, and this is the real router.)
//
// All money logic lives in services/walletService.js; this file is just
// HTTP plumbing: auth, request parsing/validation, and mapping
// WalletError -> HTTP status codes. See walletService.js's header
// comment for the concurrency model these handlers rely on.

const express = require('express');
const router = express.Router();
const { getUserDb, get } = require('../database/userDb');
const { requireAuth } = require('../middleware/auth');
const { toMinorUnits } = require('../services/currency');
const {
  WalletError,
  getOrCreateWallet,
  walletSummary,
  resolveRecipientWallet,
  setPin,
  verifyPin,
  pinRecord,
  transfer,
  setWalletStatus,
  listTransactionsForUser,
  getTransactionForUser,
} = require('../services/walletService');

// Any route under /api/wallet is per-user money handling — require auth
// on everything in this router.
router.use(requireAuth);

function sendWalletError(res, err) {
  if (err instanceof WalletError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  console.error('Wallet route error:', err);
  return res.status(500).json({ error: 'Internal server error' });
}

// ── GET /api/wallet — wallet home summary ──────────────────────────
router.get('/', async (req, res) => {
  try {
    const db = await getUserDb();
    const wallet = getOrCreateWallet(db, req.user.id);
    const hasPin = !!pinRecord(db, wallet.id);
    res.json({ wallet: Object.assign(walletSummary(db, wallet), { hasPin }) });
  } catch (err) {
    sendWalletError(res, err);
  }
});

// ── GET /api/wallet/balance ─────────────────────────────────────────
router.get('/balance', async (req, res) => {
  try {
    const db = await getUserDb();
    const wallet = getOrCreateWallet(db, req.user.id);
    const summary = walletSummary(db, wallet);
    res.json({ balance: summary.balance, balanceDisplay: summary.balanceDisplay, currency: summary.currency });
  } catch (err) {
    sendWalletError(res, err);
  }
});

// ── GET /api/wallet/transactions ────────────────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const db = await getUserDb();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const filter = ['all', 'sent', 'received', 'marketplace', 'deposits', 'withdrawals'].includes(req.query.filter)
      ? req.query.filter : 'all';
    const transactions = listTransactionsForUser(db, req.user.id, { filter, limit, offset });
    res.json({ transactions });
  } catch (err) {
    sendWalletError(res, err);
  }
});

// ── GET /api/wallet/transactions/:id ────────────────────────────────
router.get('/transactions/:id', async (req, res) => {
  try {
    const db = await getUserDb();
    const transaction = getTransactionForUser(db, req.user.id, req.params.id);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ transaction });
  } catch (err) {
    sendWalletError(res, err);
  }
});

// ── GET /api/wallet/receive — my payable identity + QR payload ────
router.get('/receive', async (req, res) => {
  try {
    const db = await getUserDb();
    const wallet = getOrCreateWallet(db, req.user.id);
    res.json({
      username: req.user.username,
      walletId: wallet.wallet_id,
      // Wallet ID only — never a password, PIN, or token (spec section 11).
      qrPayload: `nyx://pay/${wallet.wallet_id}`,
    });
  } catch (err) {
    sendWalletError(res, err);
  }
});

// ── POST /api/wallet/send ───────────────────────────────────────────
router.post('/send', async (req, res) => {
  try {
    const idempotencyKey = req.get('Idempotency-Key');
    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Idempotency-Key header is required' });
    }
    const { recipient, amount, pin, note } = req.body || {};
    if (!recipient || typeof recipient !== 'string') {
      return res.status(400).json({ error: 'recipient is required' });
    }
    const amountSubunits = toMinorUnits(amount);
    if (amountSubunits === null || amountSubunits <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (note && (typeof note !== 'string' || note.length > 200)) {
      return res.status(400).json({ error: 'Note must be 200 characters or fewer' });
    }

    const db = await getUserDb();
    const transaction = await transfer(db, {
      senderUserId: req.user.id,
      recipientIdentifier: recipient,
      amountSubunits,
      note: note || null,
      pin,
      idempotencyKey,
    });
    res.json({ transaction });
  } catch (err) {
    sendWalletError(res, err);
  }
});

// ── POST /api/wallet/freeze / unfreeze — self-service security lock ─
// Lets a user lock their own wallet (e.g. if they suspect it's
// compromised) without needing an admin. Re-activating only requires
// being authenticated as the owner, same as freezing.
router.post('/freeze', async (req, res) => {
  try {
    const db = await getUserDb();
    const wallet = getOrCreateWallet(db, req.user.id);
    const updated = setWalletStatus(db, wallet.wallet_id, 'FROZEN', req.user.id);
    res.json({ wallet: walletSummary(db, updated) });
  } catch (err) {
    sendWalletError(res, err);
  }
});

router.post('/unfreeze', async (req, res) => {
  try {
    const db = await getUserDb();
    const wallet = getOrCreateWallet(db, req.user.id);
    if (wallet.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'This wallet is suspended and cannot be reactivated here. Contact support.' });
    }
    const updated = setWalletStatus(db, wallet.wallet_id, 'ACTIVE', req.user.id);
    res.json({ wallet: walletSummary(db, updated) });
  } catch (err) {
    sendWalletError(res, err);
  }
});

// ── POST /api/wallet/pin — first-time PIN creation ──────────────────
router.post('/pin', async (req, res) => {
  try {
    const { pin } = req.body || {};
    const db = await getUserDb();
    const wallet = getOrCreateWallet(db, req.user.id);
    if (pinRecord(db, wallet.id)) {
      return res.status(409).json({ error: 'A wallet PIN is already set. Use PUT to change it.' });
    }
    await setPin(db, wallet.id, pin);
    res.status(201).json({ ok: true });
  } catch (err) {
    sendWalletError(res, err);
  }
});

// ── PUT /api/wallet/pin — change an existing PIN ────────────────────
router.put('/pin', async (req, res) => {
  try {
    const { currentPin, newPin } = req.body || {};
    if (!currentPin) return res.status(400).json({ error: 'currentPin is required' });
    const db = await getUserDb();
    const wallet = getOrCreateWallet(db, req.user.id);
    await verifyPin(db, wallet.id, currentPin);
    await setPin(db, wallet.id, newPin);
    res.json({ ok: true });
  } catch (err) {
    sendWalletError(res, err);
  }
});

// ── GET /api/wallet/:identifier — recipient preview for the send flow ─
// Accepts a username (with/without leading @) or a wallet id
// (NX-XXXX-XXXX-XXXX). Intentionally returns only the public identity,
// never a balance — this is a "does this recipient exist" lookup, not
// an account viewer. Kept LAST so it can't shadow the named routes above.
router.get('/:identifier', async (req, res) => {
  try {
    const db = await getUserDb();
    const wallet = resolveRecipientWallet(db, req.params.identifier);
    if (!wallet) return res.status(404).json({ error: 'Recipient not found' });
    const owner = get(db, 'SELECT username FROM users WHERE id = ?', [wallet.user_id]);
    if (!owner) return res.status(404).json({ error: 'Recipient not found' });
    res.json({ username: owner.username, walletId: wallet.wallet_id });
  } catch (err) {
    sendWalletError(res, err);
  }
});

module.exports = router;
