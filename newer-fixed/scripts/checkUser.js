// scripts/checkUser.js — read-only diagnostic. Shows a user's real
// internal id and their wallet row (if any) side by side, so you can
// see whether a manually-edited wallets.user_id actually matches.
//
// Usage: node scripts/checkUser.js <username>

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '..', 'data', 'nyxie_users.db');
const username = process.argv[2];

if (!username) {
  console.error('Usage: node scripts/checkUser.js <username>');
  process.exit(1);
}

(async () => {
  if (!fs.existsSync(DB_PATH)) {
    console.error('No database file found at', DB_PATH);
    process.exit(1);
  }
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));

  const userRes = db.exec('SELECT id, username, created_at FROM users WHERE username = ?', [username]);
  if (!userRes.length) {
    console.log(`No user named "${username}" found.`);
    process.exit(0);
  }
  const [id, uname, created] = userRes[0].values[0];
  console.log(`User: @${uname}`);
  console.log(`  id:         ${id}`);
  console.log(`  created_at: ${new Date(created).toISOString()}`);

  let hasWalletTables = true;
  try {
    db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wallets'");
    const check = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='wallets'");
    hasWalletTables = check.length > 0;
  } catch (e) { hasWalletTables = false; }

  if (!hasWalletTables) {
    console.log('\nThe wallets table doesn\'t exist yet — nobody has opened the wallet panel or hit a wallet API endpoint on this DB yet.');
    console.log('Log in and open the Wallet tab once (or POST to /api/wallet) to create it, then re-run this script.');
    process.exit(0);
  }

  const walletRes = db.exec('SELECT id, wallet_id, user_id, balance, status FROM wallets WHERE user_id = ?', [id]);
  if (!walletRes.length) {
    console.log('\nNo wallet row is linked to this user_id.');
  } else {
    const [wid, walletId, uid, balance, status] = walletRes[0].values[0];
    console.log(`\nLinked wallet:`);
    console.log(`  wallet row id: ${wid}`);
    console.log(`  wallet_id:     ${walletId}`);
    console.log(`  balance:       ${balance} subunits (${(balance / 100).toFixed(2)} NX)`);
    console.log(`  status:        ${status}`);
  }

  // Also show ALL wallet rows, in case an edit created an orphaned one
  // (e.g. user_id typo'd as the username string instead of the real id).
  const allWallets = db.exec('SELECT wallet_id, user_id, balance FROM wallets');
  if (allWallets.length) {
    console.log(`\nAll wallets in the database (${allWallets[0].values.length}):`);
    for (const [walletId, uid, balance] of allWallets[0].values) {
      const flag = uid === id ? '  <- matches this user' : (uid.includes(username) ? '  <- SUSPICIOUS: user_id looks wrong' : '');
      console.log(`  ${walletId}  user_id=${uid}  balance=${balance}${flag}`);
    }
  }
})();
