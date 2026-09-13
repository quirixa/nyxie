// server/database/marketplaceDb.js — marketplace schema, added on top of
// the `marketplace_items` / `marketplace_orders` tables that walletDb.js
// already scaffolds (see that file's "Marketplace" section). Follows the
// same pattern as ensureWalletTables(db): a module-level `ready` flag and
// a defensive `ensureMarketplaceTables(db)` call at the top of every
// marketplace route/service function, same precedent as blocks.js.
//
// IMPORTANT — schema reality check (read before changing statuses):
// This app has NO separate escrow table. Money movement already flows
// through wallet_transactions/ledger_entries (walletService.js), and that
// table's `status` column already has an 'ESCROW' value reserved for
// exactly this purpose (see walletDb.js's column comment). So "escrow"
// here means: a wallet_transactions row of type MARKETPLACE_ESCROW_HOLD
// with status='ESCROW' (a real DEBIT leg against the buyer's wallet —
// the money has actually left their spendable balance), referenced by
// marketplace_orders.purchase_transaction_id. Releasing/refunding escrow
// means writing a *second* transaction (MARKETPLACE_SALE or
// MARKETPLACE_REFUND, status COMPLETED) with a single CREDIT leg to the
// seller or buyer, and flipping the hold's own status out of 'ESCROW'.
// This reuses the existing ledger instead of inventing a parallel one —
// per the task's explicit instruction not to build a second money system.
//
// marketplace_orders.escrow_status is the authoritative "has this been
// released/refunded yet" guard (prevents double-release/double-refund);
// order.status is the buyer/seller-facing lifecycle state.

const { run, get, all } = require('./userDb');

let ready = false;

function ensureMarketplaceTables(db) {
  if (ready) return;

  // ── Extend marketplace_items (created by walletDb.js) ─────────────
  // ALTER TABLE ADD COLUMN is idempotent-by-try/catch here, same trick
  // userDb.js/walletDb.js use for evolving already-created tables.
  try { run(db, "ALTER TABLE marketplace_items ADD COLUMN stock INTEGER NOT NULL DEFAULT 1"); } catch (e) {}
  try { run(db, "ALTER TABLE marketplace_items ADD COLUMN delivery_type TEXT NOT NULL DEFAULT 'manual'"); } catch (e) {}

  // ── Extend marketplace_orders (created by walletDb.js) ─────────────
  try { run(db, "ALTER TABLE marketplace_orders ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1"); } catch (e) {}
  try { run(db, "ALTER TABLE marketplace_orders ADD COLUMN unit_price INTEGER"); } catch (e) {}
  // held | released | refunded — separate from order.status because a
  // dispute can move order.status around without touching escrow twice.
  try { run(db, "ALTER TABLE marketplace_orders ADD COLUMN escrow_status TEXT NOT NULL DEFAULT 'held'"); } catch (e) {}
  try { run(db, "ALTER TABLE marketplace_orders ADD COLUMN buyer_confirmed INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { run(db, "ALTER TABLE marketplace_orders ADD COLUMN seller_delivered INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { run(db, "ALTER TABLE marketplace_orders ADD COLUMN delivery_data TEXT"); } catch (e) {}
  try { run(db, "ALTER TABLE marketplace_orders ADD COLUMN dispute_id TEXT"); } catch (e) {}
  try { run(db, "ALTER TABLE marketplace_orders ADD COLUMN updated_at INTEGER"); } catch (e) {}

  // ── Vendor stats (one row per seller, lazily created) ──────────────
  run(db, `
    CREATE TABLE IF NOT EXISTS marketplace_vendors (
      user_id TEXT PRIMARY KEY,
      total_sales INTEGER NOT NULL DEFAULT 0,
      completed_sales INTEGER NOT NULL DEFAULT 0,
      total_reviews INTEGER NOT NULL DEFAULT 0,
      rating_sum INTEGER NOT NULL DEFAULT 0,
      completion_rate REAL NOT NULL DEFAULT 100,
      trusted_vendor INTEGER NOT NULL DEFAULT 0,
      elite_vendor INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // ── Reviews — one per completed order ───────────────────────────────
  run(db, `
    CREATE TABLE IF NOT EXISTS marketplace_reviews (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      reviewer_id TEXT NOT NULL,
      vendor_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES marketplace_orders(id),
      FOREIGN KEY (reviewer_id) REFERENCES users(id),
      FOREIGN KEY (vendor_id) REFERENCES users(id)
    )
  `);
  run(db, 'CREATE INDEX IF NOT EXISTS idx_reviews_vendor ON marketplace_reviews (vendor_id)');

  // ── Disputes ────────────────────────────────────────────────────────
  run(db, `
    CREATE TABLE IF NOT EXISTS marketplace_disputes (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      opened_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolution_note TEXT,
      resolved_by TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      FOREIGN KEY (order_id) REFERENCES marketplace_orders(id),
      FOREIGN KEY (opened_by) REFERENCES users(id)
    )
  `);
  run(db, 'CREATE INDEX IF NOT EXISTS idx_disputes_order ON marketplace_disputes (order_id)');

  ready = true;
}

function getOrCreateVendor(db, userId) {
  ensureMarketplaceTables(db);
  let vendor = get(db, 'SELECT * FROM marketplace_vendors WHERE user_id = ?', [userId]);
  if (vendor) return vendor;
  const now = Date.now();
  run(db, `
    INSERT INTO marketplace_vendors (user_id, total_sales, completed_sales, total_reviews, rating_sum, completion_rate, trusted_vendor, elite_vendor, created_at, updated_at)
    VALUES (?, 0, 0, 0, 0, 100, 0, 0, ?, ?)
  `, [userId, now, now]);
  return get(db, 'SELECT * FROM marketplace_vendors WHERE user_id = ?', [userId]);
}

module.exports = { ensureMarketplaceTables, getOrCreateVendor, run, get, all };
