// scripts/setProfileEffect.js — authorise or revoke the animated profile
// effect (ring + sparks) for a user from the CLI. Handy for authorising
// yourself the first time; admins can also toggle it from any user's
// profile card ("⋯" menu).
//
// IMPORTANT: stop the server first (or restart it afterwards), otherwise
// its in-memory DB copy overwrites this on the next persist tick.
//
// Usage: node scripts/setProfileEffect.js <username> <on|off>

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getUserDb, get, run } = require('../server/database/userDb');

const username = process.argv[2];
const mode = (process.argv[3] || '').toLowerCase();
if (!username || !['on', 'off'].includes(mode)) {
  console.error('Usage: node scripts/setProfileEffect.js <username> <on|off>');
  process.exit(1);
}

(async () => {
  const db = await getUserDb();
  const user = get(db, 'SELECT id, username FROM users WHERE username = ?', [username]);
  if (!user) { console.error(`No user named "${username}" found.`); process.exit(1); }
  run(db, 'UPDATE users SET profile_effect = ? WHERE id = ?', [mode === 'on' ? 1 : 0, user.id]);
  console.log(`@${user.username}: profile effect ${mode === 'on' ? 'ENABLED' : 'disabled'}.`);
  process.exit(0);
})();
