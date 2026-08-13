// server/services/walletService.js — all money-moving logic lives here.
//
// CONCURRENCY MODEL (read this before touching this file):
// sql.js is synchronous and this app keeps one shared in-process
// connection (see userDb.js). Node is single-threaded, so as long as a
// unit of work never `await`s between its first read and its last
// write, no other request's handler can run in the middle of it — that
// *is* our isolation guarantee, in place of real DB-level row locking.
// Consequences:
//   - Every function below that touches balances is written as a single
//     synchronous block (`doTransactionally`). Async steps that must
//     happen first (bcrypt PIN compare, etc.) are done *before* that
//     block starts, never inside it.
//   - Never insert an `await` inside `doTransactionally`'s callback.
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getUserDb, all, get, run } = require('../database/userDb');
const { ensureWalletTables } = require('../database/walletDb');
const { toMinorUnits, fromMinorUnits, formatCurrency } = require('./currency');

const PIN_SALT_ROUNDS = 10;
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// Configurable fraud/abuse limits (section 32) — env-overridable.
const LIMITS = {
  MAX_TRANSFER_SUBUNITS: toMinorUnits(process.env.WALLET_MAX_TRANSFER_NX || '1000000'),
  MAX_DAILY_TRANSFER_SUBUNITS: toMinorUnits(process.env.WALLET_MAX_DAILY_TRANSFER_NX || '5000000'),
  MAX_TRANSFERS_PER_MINUTE: Number(process.env.WALLET_MAX_TRANSFERS_PER_MIN || 10),
};

class WalletError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ── ID / reference generation ──────────────────────────────────────
// Non-sequential, safe to expose publicly, not derived from the
// internal DB row id. Excludes visually ambiguous characters (0/O, 1/I/L).
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function randomSegment(len) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}
function generateWalletId() {
  return `NX-${randomSegment(4)}-${randomSegment(4)}-${randomSegment(4)}`;
}
function generateTransactionRef() {
  return `NX-TX-${randomSegment(8)}`;
}

// ── Audit log ────────────────────────────────────────────────────
function audit(db, actorId, action, target, metadata) {
  run(db, `
    INSERT INTO audit_logs (id, actor_id, action, target, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [crypto.randomUUID(), actorId || null, action, target || null, metadata ? JSON.stringify(metadata) : null, Date.now()]);
}

// ── Wallet lifecycle ────────────────────────────────────────────────
function getOrCreateWallet(db, userId) {
  ensureWalletTables(db);
  let wallet = get(db, 'SELECT * FROM wallets WHERE user_id = ?', [userId]);
  if (wallet) return wallet;

  // Retry on the astronomically unlikely event of a wallet_id collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = crypto.randomUUID();
    const walletId = generateWalletId();
    const now = Date.now();
    try {
      run(db, `
        INSERT INTO wallets (id, user_id, wallet_id, balance, currency, status, created_at, updated_at)
        VALUES (?, ?, ?, 0, 'NX', 'ACTIVE', ?, ?)
      `, [id, userId, walletId, now, now]);
      audit(db, userId, 'WALLET_CREATED', walletId, null);
      return get(db, 'SELECT * FROM wallets WHERE id = ?', [id]);
    } catch (e) {
      // Unique constraint collision on wallet_id — retry with a new one.
      continue;
    }
  }
  throw new WalletError('WALLET_CREATE_FAILED', 'Could not create wallet, try again', 500);
}

function getWalletByUserId(db, userId) {
  return get(db, 'SELECT * FROM wallets WHERE user_id = ?', [userId]);
}
function getWalletByWalletId(db, walletId) {
  return get(db, 'SELECT * FROM wallets WHERE wallet_id = ?', [walletId]);
}

// Recomputes balance straight from the ledger (source of truth). Used
// by admin/debug tooling and tests to verify the cached `balance`
// column never drifts.
function computeLedgerBalance(db, walletDbId) {
  const row = get(db, `
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0) AS balance
    FROM ledger_entries WHERE wallet_id = ?
  `, [walletDbId]);
  return row ? row.balance : 0;
}

// Public wallet summary safe to hand back to the owning user.
function walletSummary(db, wallet) {
  return {
    walletId: wallet.wallet_id,
    balance: wallet.balance,
    balanceDisplay: formatCurrency(wallet.balance),
    currency: wallet.currency,
    status: wallet.status,
  };
}

// ── Recipient resolution ────────────────────────────────────────────
// Accepts a username (with or without leading @), a wallet id
// (NX-XXXX-XXXX-XXXX), or (in future) a phone number.
function resolveRecipientWallet(db, identifier) {
  if (!identifier || typeof identifier !== 'string') return null;
  const trimmed = identifier.trim();
  if (/^NX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(trimmed)) {
    return getWalletByWalletId(db, trimmed.toUpperCase());
  }
  const username = trimmed.replace(/^@/, '');
  const user = get(db, 'SELECT id FROM users WHERE username = ?', [username]);
  if (!user) return null;
  return getOrCreateWallet(db, user.id);
}

// ── PIN management ──────────────────────────────────────────────────
function pinRecord(db, walletDbId) {
  return get(db, 'SELECT * FROM wallet_pins WHERE wallet_id = ?', [walletDbId]);
}

async function setPin(db, walletDbId, pin) {
  if (!/^\d{4,6}$/.test(String(pin))) {
    throw new WalletError('INVALID_PIN', 'PIN must be 4-6 digits');
  }
  const hash = await bcrypt.hash(String(pin), PIN_SALT_ROUNDS);
  const now = Date.now();
  const existing = pinRecord(db, walletDbId);
  if (existing) {
    run(db, `UPDATE wallet_pins SET pin_hash = ?, fail_count = 0, locked_until = NULL, updated_at = ? WHERE wallet_id = ?`,
      [hash, now, walletDbId]);
  } else {
    run(db, `INSERT INTO wallet_pins (wallet_id, pin_hash, fail_count, locked_until, created_at, updated_at)
              VALUES (?, ?, 0, NULL, ?, ?)`, [walletDbId, hash, now, now]);
  }
}

// Verifies a PIN with rate limiting. Throws WalletError on any failure
// (wrong PIN, locked out, no PIN set). The bcrypt compare happens
// *before* any balance mutation ever starts (see concurrency note above).
async function verifyPin(db, walletDbId, pin) {
  const record = pinRecord(db, walletDbId);
  if (!record) throw new WalletError('PIN_NOT_SET', 'Set a wallet PIN before sending money');

  const now = Date.now();
  if (record.locked_until && record.locked_until > now) {
    const mins = Math.ceil((record.locked_until - now) / 60000);
    throw new WalletError('PIN_LOCKED', `Too many incorrect PIN attempts. Try again in ${mins} minute(s).`, 429);
  }

  const ok = await bcrypt.compare(String(pin || ''), record.pin_hash);
  if (!ok) {
    const failCount = record.fail_count + 1;
    const lockedUntil = failCount >= MAX_PIN_ATTEMPTS ? now + PIN_LOCKOUT_MS : null;
    run(db, 'UPDATE wallet_pins SET fail_count = ?, locked_until = ?, updated_at = ? WHERE wallet_id = ?',
      [failCount >= MAX_PIN_ATTEMPTS ? 0 : failCount, lockedUntil, now, walletDbId]);
    throw new WalletError('INCORRECT_PIN', 'Incorrect PIN');
  }
  if (record.fail_count !== 0) {
    run(db, 'UPDATE wallet_pins SET fail_count = 0, locked_until = NULL, updated_at = ? WHERE wallet_id = ?', [now, walletDbId]);
  }
}

// ── Idempotency ──────────────────────────────────────────────────────
// If a transaction already exists for this idempotency key, return it
// instead of creating a new one. Callers pass a per-operation-type key
// so the same raw UUID reused across different endpoints doesn't collide.
function findByIdempotencyKey(db, idempotencyKey) {
  if (!idempotencyKey) return null;
  return get(db, 'SELECT * FROM wallet_transactions WHERE idempotency_key = ?', [idempotencyKey]);
}

// ── Rate limiting / fraud checks (section 32) ───────────────────────
function checkRateLimits(db, senderWalletDbId, amountSubunits) {
  if (amountSubunits > LIMITS.MAX_TRANSFER_SUBUNITS) {
    throw new WalletError('AMOUNT_TOO_LARGE', `Amount exceeds the maximum transfer limit of ${formatCurrency(LIMITS.MAX_TRANSFER_SUBUNITS)} NX`);
  }
  const oneMinuteAgo = Date.now() - 60 * 1000;
  const recentCount = get(db, `
    SELECT COUNT(*) AS c FROM wallet_transactions
    WHERE sender_wallet_id = ? AND created_at > ? AND status != 'FAILED'
  `, [senderWalletDbId, oneMinuteAgo]);
  if (recentCount && recentCount.c >= LIMITS.MAX_TRANSFERS_PER_MINUTE) {
    throw new WalletError('RATE_LIMITED', 'Too many transfers, slow down and try again shortly', 429);
  }
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const dailyTotal = get(db, `
    SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transactions
    WHERE sender_wallet_id = ? AND created_at > ? AND status IN ('COMPLETED', 'ESCROW')
  `, [senderWalletDbId, oneDayAgo]);
  if (dailyTotal && (dailyTotal.total + amountSubunits) > LIMITS.MAX_DAILY_TRANSFER_SUBUNITS) {
    throw new WalletError('DAILY_LIMIT_EXCEEDED', 'This transfer would exceed your daily transfer limit');
  }
}

// ── Core ledger primitive ───────────────────────────────────────────
// Writes a transaction row + matching double-entry ledger rows, and
// updates cached wallet balances, all inside one BEGIN/COMMIT block.
// `legs` is an array of { walletDbId, amount, direction } that MUST sum
// to zero net movement for money that isn't entering/leaving the system
// (system credit/debit and deposits/withdrawals are the deliberate
// exceptions — a single-leg entry against the system).
function writeTransaction(db, { type, status, senderWalletDbId, receiverWalletDbId, amount, description, metadata, idempotencyKey, legs }) {
  const now = Date.now();
  const txId = crypto.randomUUID();
  const reference = generateTransactionRef();

  run(db, 'BEGIN TRANSACTION');
  try {
    run(db, `
      INSERT INTO wallet_transactions
        (id, reference, type, status, sender_wallet_id, receiver_wallet_id, amount, currency, description, metadata, idempotency_key, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'NX', ?, ?, ?, ?, ?)
    `, [txId, reference, type, status, senderWalletDbId || null, receiverWalletDbId || null, amount,
        description || null, metadata ? JSON.stringify(metadata) : null, idempotencyKey || null, now,
        status === 'COMPLETED' ? now : null]);

    for (const leg of legs) {
      run(db, `
        INSERT INTO ledger_entries (id, transaction_id, wallet_id, amount, direction, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [crypto.randomUUID(), txId, leg.walletDbId, leg.amount, leg.direction, now]);

      const delta = leg.direction === 'CREDIT' ? leg.amount : -leg.amount;
      run(db, 'UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE id = ?', [delta, now, leg.walletDbId]);
    }

    run(db, 'COMMIT');
  } catch (e) {
    try { run(db, 'ROLLBACK'); } catch (e2) { /* best-effort */ }
    throw e;
  }

  return get(db, 'SELECT * FROM wallet_transactions WHERE id = ?', [txId]);
}

// ── Transfer (send money) — section 5 ───────────────────────────────
// amount is already validated/converted to integer subunits by the caller.
async function transfer(db, { senderUserId, recipientIdentifier, amountSubunits, note, pin, idempotencyKey }) {
  ensureWalletTables(db);

  const existing = findByIdempotencyKey(db, idempotencyKey);
  if (existing) return existing;

  if (!Number.isInteger(amountSubunits) || amountSubunits <= 0) {
    throw new WalletError('INVALID_AMOUNT', 'Invalid amount');
  }

  const senderWallet = getOrCreateWallet(db, senderUserId);
  if (senderWallet.status !== 'ACTIVE') {
    throw new WalletError('WALLET_FROZEN', 'Your wallet is frozen and cannot send money');
  }

  const recipientWallet = resolveRecipientWallet(db, recipientIdentifier);
  if (!recipientWallet) throw new WalletError('RECIPIENT_NOT_FOUND', 'Recipient not found');
  if (recipientWallet.user_id === senderUserId) {
    throw new WalletError('SELF_TRANSFER', 'You cannot send money to yourself');
  }

  // Async step (bcrypt) happens before any balance check/mutation.
  await verifyPin(db, senderWallet.id, pin);

  // From here on: synchronous only, no awaits, until the transaction
  // is committed — see concurrency note at the top of this file.
  checkRateLimits(db, senderWallet.id, amountSubunits);

  const freshSender = get(db, 'SELECT * FROM wallets WHERE id = ?', [senderWallet.id]);
  if (freshSender.balance < amountSubunits) {
    throw new WalletError('INSUFFICIENT_BALANCE', 'Insufficient balance');
  }

  const tx = writeTransaction(db, {
    type: 'TRANSFER',
    status: 'COMPLETED',
    senderWalletDbId: senderWallet.id,
    receiverWalletDbId: recipientWallet.id,
    amount: amountSubunits,
    description: note || null,
    metadata: { senderWalletId: senderWallet.wallet_id, receiverWalletId: recipientWallet.wallet_id },
    idempotencyKey,
    legs: [
      { walletDbId: senderWallet.id, amount: amountSubunits, direction: 'DEBIT' },
      { walletDbId: recipientWallet.id, amount: amountSubunits, direction: 'CREDIT' },
    ],
  });

  audit(db, senderUserId, 'TRANSFER_COMPLETED', tx.reference, { amount: amountSubunits });
  return tx;
}

// ── Deposit (dev faucet only) — section 33 ──────────────────────────
function devFaucet(db, { userId, amountSubunits, actorId }) {
  if (process.env.NODE_ENV === 'production') {
    throw new WalletError('FORBIDDEN', 'Not available in production', 403);
  }
  ensureWalletTables(db);
  if (!Number.isInteger(amountSubunits) || amountSubunits <= 0) {
    throw new WalletError('INVALID_AMOUNT', 'Invalid amount');
  }
  const wallet = getOrCreateWallet(db, userId);
  const tx = writeTransaction(db, {
    type: 'SYSTEM_CREDIT',
    status: 'COMPLETED',
    receiverWalletDbId: wallet.id,
    amount: amountSubunits,
    description: 'Development test funds',
    legs: [{ walletDbId: wallet.id, amount: amountSubunits, direction: 'CREDIT' }],
  });
  audit(db, actorId || userId, 'DEV_FAUCET_CREDIT', tx.reference, { amount: amountSubunits, userId });
  return tx;
}

// ── Withdrawal request — section 18 ─────────────────────────────────
// No real money moves. We record WITHDRAWAL_REQUESTED and let an admin
// (or, later, a real PaymentProvider) resolve it. Funds are held by
// debiting the wallet immediately into a PENDING transaction so the
// user can't spend the same balance twice while the request is open;
// a cancelled/failed withdrawal issues a REFUND back.
function requestWithdrawal(db, { userId, amountSubunits, destination }) {
  ensureWalletTables(db);
  if (!Number.isInteger(amountSubunits) || amountSubunits <= 0) {
    throw new WalletError('INVALID_AMOUNT', 'Invalid amount');
  }
  const wallet = getOrCreateWallet(db, userId);
  if (wallet.status !== 'ACTIVE') throw new WalletError('WALLET_FROZEN', 'Your wallet is frozen');
  if (wallet.balance < amountSubunits) throw new WalletError('INSUFFICIENT_BALANCE', 'Insufficient balance');

  const now = Date.now();
  const tx = writeTransaction(db, {
    type: 'WITHDRAW',
    status: 'PENDING',
    senderWalletDbId: wallet.id,
    amount: amountSubunits,
    description: `Withdrawal to ${destination || 'unspecified destination'}`,
    legs: [{ walletDbId: wallet.id, amount: amountSubunits, direction: 'DEBIT' }],
  });

  const reqId = crypto.randomUUID();
  run(db, `
    INSERT INTO payment_requests (id, wallet_id, type, amount, currency, provider, destination, status, transaction_id, created_at, updated_at)
    VALUES (?, ?, 'WITHDRAW', ?, 'NX', 'demo', ?, 'REQUESTED', ?, ?, ?)
  `, [reqId, wallet.id, amountSubunits, destination || null, tx.id, now, now]);

  audit(db, userId, 'WITHDRAWAL_REQUESTED', tx.reference, { amount: amountSubunits, destination });
  return { transaction: tx, requestId: reqId };
}

// ── Admin: freeze / unfreeze ─────────────────────────────────────────
function setWalletStatus(db, walletId, status, actorId) {
  ensureWalletTables(db);
  if (!['ACTIVE', 'FROZEN', 'SUSPENDED'].includes(status)) {
    throw new WalletError('INVALID_STATUS', 'Invalid wallet status');
  }
  const wallet = getWalletByWalletId(db, walletId);
  if (!wallet) throw new WalletError('WALLET_NOT_FOUND', 'Wallet not found', 404);
  run(db, 'UPDATE wallets SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), wallet.id]);
  audit(db, actorId, status === 'FROZEN' ? 'ADMIN_FREEZED_WALLET' : status === 'ACTIVE' ? 'ADMIN_UNFROZED_WALLET' : 'ADMIN_SET_WALLET_STATUS', walletId, { status });
  return get(db, 'SELECT * FROM wallets WHERE id = ?', [wallet.id]);
}

// ── Transaction history (section 16) ────────────────────────────────
function listTransactionsForUser(db, userId, { filter = 'all', limit = 50, offset = 0 } = {}) {
  const wallet = getOrCreateWallet(db, userId);
  let where = '(sender_wallet_id = ? OR receiver_wallet_id = ?)';
  const params = [wallet.id, wallet.id];

  if (filter === 'sent') { where = 'sender_wallet_id = ?'; params.length = 0; params.push(wallet.id); }
  else if (filter === 'received') { where = 'receiver_wallet_id = ?'; params.length = 0; params.push(wallet.id); }
  else if (filter === 'marketplace') { where += " AND type IN ('MARKETPLACE_PURCHASE','MARKETPLACE_SALE')"; }
  else if (filter === 'deposits') { where += " AND type IN ('DEPOSIT','SYSTEM_CREDIT')"; }
  else if (filter === 'withdrawals') { where += " AND type = 'WITHDRAW'"; }

  const rows = all(db, `
    SELECT * FROM wallet_transactions WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  return rows.map(tx => decorateTransactionForUser(db, tx, wallet));
}

function decorateTransactionForUser(db, tx, wallet) {
  const direction = tx.sender_wallet_id === wallet.id ? 'OUT' : 'IN';
  let counterpartyUsername = null;
  const counterpartyWalletDbId = direction === 'OUT' ? tx.receiver_wallet_id : tx.sender_wallet_id;
  if (counterpartyWalletDbId) {
    const cp = get(db, `
      SELECT u.username FROM wallets w JOIN users u ON u.id = w.user_id WHERE w.id = ?
    `, [counterpartyWalletDbId]);
    counterpartyUsername = cp ? cp.username : null;
  }
  return {
    id: tx.id,
    reference: tx.reference,
    type: tx.type,
    status: tx.status,
    amount: tx.amount,
    amountDisplay: formatCurrency(tx.amount),
    direction,
    counterpartyUsername,
    description: tx.description,
    createdAt: tx.created_at,
    completedAt: tx.completed_at,
  };
}

function getTransactionForUser(db, userId, transactionId) {
  const wallet = getOrCreateWallet(db, userId);
  const tx = get(db, 'SELECT * FROM wallet_transactions WHERE id = ?', [transactionId]);
  if (!tx) return null;
  if (tx.sender_wallet_id !== wallet.id && tx.receiver_wallet_id !== wallet.id) return null;
  return decorateTransactionForUser(db, tx, wallet);
}

module.exports = {
  WalletError,
  generateWalletId,
  generateTransactionRef,
  getOrCreateWallet,
  getWalletByUserId,
  getWalletByWalletId,
  computeLedgerBalance,
  walletSummary,
  resolveRecipientWallet,
  setPin,
  verifyPin,
  pinRecord,
  findByIdempotencyKey,
  writeTransaction,
  transfer,
  devFaucet,
  requestWithdrawal,
  setWalletStatus,
  listTransactionsForUser,
  getTransactionForUser,
  decorateTransactionForUser,
  audit,
  LIMITS,
};