// scripts/setRole.js — promote or demote a user's role from the CLI.
// This is the supported way to make someone an ADMIN: it's the only
// non-technical path onto the admin marketplace dashboard, since
// requireAdmin (server/middleware/auth.js) checks `req.user.role`,
// which only ever comes from the `users.role` column — there is no
// API endpoint that lets a user grant themselves (or anyone else)
// admin, by design.
//
// Same pattern as scripts/grantFunds.js: goes through the real
// getUserDb()/run() code path (not a raw sql.js handle) so the write
// persists the same way the server itself persists.
//
// IMPORTANT: make sure the server is NOT running when you run this
// (or restart the server afterward) — otherwise the running process's
// in-memory DB copy will overwrite this on its next 5-second persist
// tick and your change will appear to "disappear".
//
// Usage: node scripts/setRole.js <username> <ADMIN|USER>
// Example: node scripts/setRole.js rose ADMIN

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getUserDb, get, run } = require('../server/database/userDb');

const VALID_ROLES = ['ADMIN', 'USER'];

const username = process.argv[2];
const role = (process.argv[3] || '').trim().toUpperCase();

if (!username || !VALID_ROLES.includes(role)) {
  console.error('Usage: node scripts/setRole.js <username> <ADMIN|USER>');
  process.exit(1);
}

(async () => {
  const db = await getUserDb();
  const user = get(db, 'SELECT id, username, role FROM users WHERE username = ?', [username]);
  if (!user) {
    console.error(`No user named "${username}" found. Check spelling / that they registered.`);
    process.exit(1);
  }

  const currentRole = user.role || 'USER';
  if (currentRole === role) {
    console.log(`@${user.username} is already ${role}. Nothing to do.`);
    process.exit(0);
  }

  run(db, 'UPDATE users SET role = ? WHERE id = ?', [role, user.id]);

  console.log(`@${user.username} is now ${role} (was ${currentRole}).`);
  console.log('\nIMPORTANT: if the server is currently running, restart it now so it reloads this from disk.');
  process.exit(0);
})().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
