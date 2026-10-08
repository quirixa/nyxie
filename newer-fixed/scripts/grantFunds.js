// scripts/grantFunds.js — safely credit an existing user's wallet using
// the real wallet service (same code path as the dev faucet), so the
// ledger and the cached balance stay in sync. Use this instead of
// hand-editing wallets.balance in a DB browser — a raw edit skips
// ledger_entries, which computeLedgerBalance()/future audits would then
// flag as inconsistent.
//
// IMPORTANT: make sure the server is NOT running when you run this
// (or restart the server afterward) — otherwise the running process's
// in-memory DB copy will overwrite this on its next 5-second persist
// tick and your credit will appear to "disappear".
//
// Usage: node scripts/grantFunds.js <username> <amountNX>
// Example: node scripts/grantFunds.js rose 11000000

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run in production — this is a dev-only tool.');
  process.exit(1);
}

const { getUserDb, get } = require('../server/database/userDb');
const { getOrCreateWallet, devFaucet, walletSummary } = require('../server/services/walletService');
const { toMinorUnits } = require('../server/services/currency');

const username = process.argv[2];
const amountNX = process.argv[3];

if (!username || !amountNX) {
  console.error('Usage: node scripts/grantFunds.js <username> <amountNX>');
  process.exit(1);
}

(async () => {
  const db = await getUserDb();
  const user = get(db, 'SELECT id, username FROM users WHERE username = ?', [username]);
  if (!user) {
    console.error(`No user named "${username}" found. Check spelling / that they registered.`);
    process.exit(1);
  }

  const amountSubunits = toMinorUnits(amountNX);
  if (amountSubunits === null || amountSubunits <= 0) {
    console.error('Invalid amount:', amountNX);
    process.exit(1);
  }

  const wallet = getOrCreateWallet(db, user.id);
  devFaucet(db, { userId: user.id, amountSubunits, actorId: 'grantFunds-script' });
  const updated = walletSummary(db, getOrCreateWallet(db, user.id));

  console.log(`Credited @${user.username} (wallet ${wallet.wallet_id})`);
  console.log(`New balance: ${updated.balanceDisplay} NX`);
  console.log('\nIMPORTANT: if the server is currently running, restart it now so it reloads this from disk.');
  process.exit(0);
})().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
