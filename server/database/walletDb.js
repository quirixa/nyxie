// server/database/walletDb.js — schema for the NX wallet + marketplace,
// created lazily on the same sql.js database handle used by userDb.js
// (see server/services/blocks.js for the precedent this follows: a
// small `ensureXTables(db)` guarded by a module-level `ready` flag,
// called defensively at the top of every route handler).
//
// Living on the *same* db handle as `users` (rather than a separate
// sql.js Database, the way messages get their own nyxie_messages.db)
// matters here: every money-moving operation in this app is written as
// a block of synchronous sql.js calls with no `await` in between, which
// is what gives us atomicity/isolation (Node's single-threaded event
// loop can't interleave another request's callback into the middle of
// a synchronous block — see walletService.js's header comment). That
// only works if sender wallet, receiver wallet, ledger entries and the
// transaction row are all on one connection.

const { run } = require('./userDb');

let ready = false;

function ensureWalletTables(db) {
  if (ready) return;

  // ── Wallets ────────────────────────────────────────────────────
  run(db, `
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,           -- internal row id (never exposed)
      user_id TEXT UNIQUE NOT NULL,
      wallet_id TEXT UNIQUE NOT NULL, -- public-facing "NX-XXXX-XXXX-XXXX"
      balance INTEGER NOT NULL DEFAULT 0, -- cached subunits; ledger is source of truth
      currency TEXT NOT NULL DEFAULT 'NX',
      status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | FROZEN | SUSPENDED
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  run(db, 'CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets (user_id)');
  run(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_walletid ON wallets (wallet_id)');

  // ── Wallet PIN (separate from account password) ──────────────────
  run(db, `
    CREATE TABLE IF NOT EXISTS wallet_pins (
      wallet_id TEXT PRIMARY KEY,     -- FK -> wallets.id
      pin_hash TEXT NOT NULL,
      fail_count INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // ── Immutable transaction ledger (human-facing record) ────────────
  run(db, `
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id TEXT PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,       -- "NX-TX-XXXXXXXX"
      type TEXT NOT NULL,                   -- TRANSFER | MARKETPLACE_PURCHASE | ...
      status TEXT NOT NULL,                 -- PENDING | COMPLETED | FAILED | CANCELLED | REFUNDED | ESCROW
      sender_wallet_id TEXT,                -- nullable (deposits/system credit have no sender wallet)
      receiver_wallet_id TEXT,              -- nullable (withdrawals have no receiver wallet)
      amount INTEGER NOT NULL,              -- subunits, always positive
      currency TEXT NOT NULL DEFAULT 'NX',
      description TEXT,
      metadata TEXT,                        -- JSON blob (order id, item id, etc.)
      idempotency_key TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);
  run(db, 'CREATE INDEX IF NOT EXISTS idx_tx_sender ON wallet_transactions (sender_wallet_id)');
  run(db, 'CREATE INDEX IF NOT EXISTS idx_tx_receiver ON wallet_transactions (receiver_wallet_id)');
  run(db, 'CREATE INDEX IF NOT EXISTS idx_tx_created ON wallet_transactions (created_at)');
  run(db, 'CREATE INDEX IF NOT EXISTS idx_tx_status ON wallet_transactions (status)');
  run(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_idempotency ON wallet_transactions (idempotency_key)');

  // ── Double-entry ledger (source of truth for balances) ─────────────
  run(db, `
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      wallet_id TEXT NOT NULL,       -- wallets.id
      amount INTEGER NOT NULL,       -- always positive; direction says which way
      direction TEXT NOT NULL,       -- DEBIT | CREDIT
      created_at INTEGER NOT NULL
    )
  `);
  run(db, 'CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries (wallet_id)');
  run(db, 'CREATE INDEX IF NOT EXISTS idx_ledger_tx ON ledger_entries (transaction_id)');

  // ── Marketplace ─────────────────────────────────────────────────
  run(db, `
    CREATE TABLE IF NOT EXISTS marketplace_items (
      id TEXT PRIMARY KEY,
      seller_id TEXT NOT NULL,       -- users.id
      title TEXT NOT NULL,
      description TEXT,
      images TEXT,                   -- JSON array of URLs
      price INTEGER NOT NULL,        -- subunits
      currency TEXT NOT NULL DEFAULT 'NX',
      category TEXT,
      condition TEXT,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | SOLD | REMOVED
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  run(db, 'CREATE INDEX IF NOT EXISTS idx_items_seller ON marketplace_items (seller_id)');
  run(db, 'CREATE INDEX IF NOT EXISTS idx_items_status ON marketplace_items (status)');

  run(db, `
    CREATE TABLE IF NOT EXISTS marketplace_orders (
      id TEXT PRIMARY KEY,
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      amount INTEGER NOT NULL,       -- subunits, snapshot of price at purchase time
      currency TEXT NOT NULL DEFAULT 'NX',
      status TEXT NOT NULL DEFAULT 'PAID', -- PENDING|PAID|SHIPPED|COMPLETED|CANCELLED|REFUNDED|DISPUTED
      purchase_transaction_id TEXT,   -- escrow-in transaction
      payout_transaction_id TEXT,     -- escrow-out to seller
      refund_transaction_id TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);
  run(db, 'CREATE INDEX IF NOT EXISTS idx_orders_buyer ON marketplace_orders (buyer_id)');
  run(db, 'CREATE INDEX IF NOT EXISTS idx_orders_seller ON marketplace_orders (seller_id)');
  run(db, 'CREATE INDEX IF NOT EXISTS idx_orders_item ON marketplace_orders (item_id)');
  run(db, 'CREATE INDEX IF NOT EXISTS idx_orders_status ON marketplace_orders (status)');

  // ── Deposits / withdrawals (abstraction only — see paymentProvider.js) ─
  run(db, `
    CREATE TABLE IF NOT EXISTS payment_requests (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      type TEXT NOT NULL,            -- DEPOSIT | WITHDRAW
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NX',
      provider TEXT NOT NULL,        -- 'demo' for MVP
      destination TEXT,              -- withdrawal destination string (opaque for MVP)
      status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|COMPLETED|FAILED|REQUESTED
      transaction_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  run(db, 'CREATE INDEX IF NOT EXISTS idx_payreq_wallet ON payment_requests (wallet_id)');

  // ── Audit log ──────────────────────────────────────────────────
  run(db, `
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT,                 -- users.id, nullable for system actions
      action TEXT NOT NULL,
      target TEXT,                   -- free-form: wallet id, tx id, user id, etc.
      metadata TEXT,                 -- JSON, never contains secrets
      created_at INTEGER NOT NULL
    )
  `);
  run(db, 'CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_id)');
  run(db, 'CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at)');

  // Simple per-wallet counters for fraud/abuse limits (section 32).
  // A row per (wallet_id, window) is overkill for the MVP; instead we
  // just query wallet_transactions with a time filter at check-time —
  // see walletService.checkRateLimits(). No extra table needed.

  // ── Role-based access control ─────────────────────────────────────
  // Users table predates the wallet; add `role` defensively the same
  // way userDb.js adds other newer columns to old DB files.
  try { run(db, "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'USER'"); } catch (e) {}

  ready = true;
}

module.exports = { ensureWalletTables };