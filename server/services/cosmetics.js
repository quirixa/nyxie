// server/services/cosmetics.js — the NX cosmetics shop (avatar + profile
// card decorations).
//
// RULES THIS FILE ENFORCES (the routes are thin wrappers around it):
//   1. Decorations are ONLY obtainable by paying NX. The one write path to
//      `user_cosmetics` is purchaseItem() below, which debits the wallet in
//      the same DB transaction.
//   2. A user can only EQUIP an item they own (or 'none'). users.js calls
//      assertCanEquip() before saving avatar_decoration / card_decoration.
//   3. Price is always taken from the server-side catalog, never the client.
//
// Money model: same ledger as everything else (walletService). A shop
// purchase is a single DEBIT leg with no receiver — NX leaves circulation,
// exactly like a withdrawal does — recorded as type SHOP_PURCHASE.
//
// CONCURRENCY: purchaseItem() is one synchronous block (no `await`
// between its first read and its COMMIT), same isolation argument as
// walletService.js's header comment. Do not add an await inside it.

const path = require('path');
const fs = require('fs');
const { get, all, run } = require('../database/userDb');
const { ensureWalletTables } = require('../database/walletDb');
const wallet = require('./walletService');
const { toMinorUnits, formatCurrency } = require('./currency');

class CosmeticsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const TYPES = ['avatar_decoration', 'card_decoration'];
// users-table column each item type equips into.
const TYPE_COLUMN = { avatar_decoration: 'avatar_decoration', card_decoration: 'card_decoration' };

// ── Catalog ─────────────────────────────────────────────────────────
// Loaded once and validated up front so a typo in the JSON fails at boot
// rather than at someone's checkout.
function loadCatalog() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'cosmetics_catalog.json'), 'utf8'));
  const seen = new Set();
  return (raw.items || []).map(item => {
    if (!/^[a-z0-9_-]{1,32}$/.test(item.id) || item.id === 'none') throw new Error(`cosmetics catalog: bad id "${item.id}"`);
    if (!TYPES.includes(item.type)) throw new Error(`cosmetics catalog: bad type for "${item.id}"`);
    if (seen.has(item.id)) throw new Error(`cosmetics catalog: duplicate id "${item.id}"`);
    seen.add(item.id);
    const price = toMinorUnits(item.price_nx);
    if (price === null || price <= 0) throw new Error(`cosmetics catalog: bad price for "${item.id}"`);
    return Object.freeze({ id: item.id, type: item.type, name: item.name, description: item.description || '', price });
  });
}
const CATALOG = loadCatalog();
const BY_ID = new Map(CATALOG.map(i => [i.id, i]));

function getItem(id) { return BY_ID.get(id) || null; }

// ── Ownership ───────────────────────────────────────────────────────
function ownedIds(db, userId) {
  return new Set(all(db, 'SELECT item_id FROM user_cosmetics WHERE user_id = ?', [userId]).map(r => r.item_id));
}
function ownsItem(db, userId, itemId) {
  return !!get(db, 'SELECT 1 AS x FROM user_cosmetics WHERE user_id = ? AND item_id = ?', [userId, itemId]);
}

// Throws unless `userId` may equip `value` into slot `type`. 'none' is
// always allowed (unequip). Used by PATCH /users/me.
function assertCanEquip(db, userId, type, value) {
  if (value === 'none') return;
  const item = getItem(value);
  if (!item || item.type !== type) throw new CosmeticsError('INVALID_ITEM', `Invalid ${type.replace('_', ' ')}`, 400);
  if (!ownsItem(db, userId, item.id)) {
    throw new CosmeticsError('NOT_OWNED', `You don't own "${item.name}" yet. Buy it in the shop first.`, 403);
  }
}

// ── Shop listing ────────────────────────────────────────────────────
function listShop(db, userId) {
  ensureWalletTables(db);
  const w = wallet.getOrCreateWallet(db, userId);
  const owned = ownedIds(db, userId);
  const me = get(db, 'SELECT avatar_decoration, card_decoration FROM users WHERE id = ?', [userId]) || {};
  return {
    balance: w.balance,
    balanceDisplay: formatCurrency(w.balance),
    walletStatus: w.status,
    equipped: {
      avatar_decoration: me.avatar_decoration || 'none',
      card_decoration: me.card_decoration || 'none',
    },
    items: CATALOG.map(i => ({
      id: i.id,
      type: i.type,
      name: i.name,
      description: i.description,
      price: i.price,
      priceDisplay: formatCurrency(i.price),
      owned: owned.has(i.id),
    })),
  };
}

// ── Purchase ────────────────────────────────────────────────────────
function purchaseItem(db, userId, itemId) {
  ensureWalletTables(db);
  const item = getItem(itemId);
  if (!item) throw new CosmeticsError('ITEM_NOT_FOUND', 'Item not found', 404);

  // Anything that may write (wallet creation) happens BEFORE the
  // transaction so no DDL/lazy inserts run inside it.
  wallet.getOrCreateWallet(db, userId);

  run(db, 'BEGIN TRANSACTION');
  try {
    // Re-read everything inside the transaction: this is the authoritative check.
    if (ownsItem(db, userId, item.id)) {
      throw new CosmeticsError('ALREADY_OWNED', 'You already own this item', 409);
    }
    const w = wallet.getWalletByUserId(db, userId);
    if (w.status !== 'ACTIVE') throw new CosmeticsError('WALLET_FROZEN', 'Your wallet is frozen', 403);
    if (w.balance < item.price) {
      throw new CosmeticsError('INSUFFICIENT_BALANCE',
        `Not enough NX. ${item.name} costs ${formatCurrency(item.price)} NX and you have ${formatCurrency(w.balance)} NX.`, 402);
    }

    const tx = wallet.writeTransactionInline(db, {
      type: 'SHOP_PURCHASE',
      status: 'COMPLETED',
      senderWalletDbId: w.id,
      amount: item.price,
      description: `Shop: ${item.name} (${item.type === 'avatar_decoration' ? 'avatar' : 'card'} decoration)`,
      metadata: { itemId: item.id, type: item.type },
      legs: [{ walletDbId: w.id, amount: item.price, direction: 'DEBIT' }],
    });
    run(db, 'INSERT INTO user_cosmetics (user_id, item_id, transaction_id, acquired_at) VALUES (?, ?, ?, ?)',
      [userId, item.id, tx.id, Date.now()]);
    wallet.audit(db, userId, 'SHOP_PURCHASE', tx.reference, { itemId: item.id, amount: item.price });
    run(db, 'COMMIT');
    return { item: { id: item.id, type: item.type, name: item.name }, transaction: tx };
  } catch (e) {
    try { run(db, 'ROLLBACK'); } catch (e2) { /* best-effort */ }
    throw e;
  }
}

module.exports = {
  CosmeticsError, TYPES, TYPE_COLUMN, CATALOG,
  getItem, ownedIds, ownsItem, assertCanEquip, listShop, purchaseItem,
};
