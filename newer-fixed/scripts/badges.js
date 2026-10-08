// scripts/badges.js — inspect, export and import badge OWNERSHIP from the CLI.
//
// Ownership lives in the `user_badges` table (see server/services/badges.js);
// this script speaks the plain-JSON shape used for seeding/backups:
//
//   { "users": { "<userId or username>": { "badges": ["developer", "tester"] } } }
//
// Usage:
//   node scripts/badges.js list [username]      show badge definitions, or one user's badges
//   node scripts/badges.js export [file]        write ownership as JSON (stdout if no file)
//   node scripts/badges.js import <file>        add badges from a JSON file (never removes any)
//
// Import rules: unknown badge ids and non-assignable badges (e.g. the
// role-derived Administrator badge) are skipped with a warning; existing
// ownership is left alone, so re-running an import is safe.
//
// Same caveat as scripts/setRole.js / grantFunds.js: make sure the server is
// NOT running (or restart it afterwards), otherwise its in-memory copy of the
// database overwrites this change on the next 5-second persist tick.
// To grant or remove badges on a live server, use Admin → Badges in the app.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const { getUserDb, all, get, run } = require('../server/database/userDb');
const { ensureWalletTables } = require('../server/database/walletDb');
const { audit } = require('../server/services/walletService');
const badges = require('../server/services/badges');

const [cmd, arg] = process.argv.slice(2);

function usage() {
  console.error('Usage:\n  node scripts/badges.js list [username]\n  node scripts/badges.js export [file]\n  node scripts/badges.js import <file>');
  process.exit(1);
}

async function main() {
  const db = await getUserDb();

  if (cmd === 'list') {
    if (!arg) {
      for (const d of badges.listDefinitionsForAdmin()) {
        const flags = [d.assignable ? '' : 'automatic', d.hidden ? 'hidden' : ''].filter(Boolean).join(', ');
        console.log(`${String(d.order).padStart(4)}  ${d.id.padEnd(16)} ${d.name}${flags ? `  (${flags})` : ''}`);
      }
      return;
    }
    const user = get(db, 'SELECT id, username FROM users WHERE username = ? OR id = ?', [arg, arg]);
    if (!user) { console.error(`No user "${arg}" found.`); process.exit(1); }
    const ids = badges.getBadgeIdsForUsers(db, [user.id], { includeHidden: true })[user.id];
    console.log(`@${user.username} (${user.id}): ${ids.length ? ids.join(', ') : 'no badges'}`);
    return;
  }

  if (cmd === 'export') {
    const out = { users: {} };
    const rows = all(db, 'SELECT user_id, badge_id FROM user_badges ORDER BY user_id, assigned_at');
    for (const r of rows) {
      const def = badges.getDefinition(r.badge_id);
      if (!def || !def.assignable) continue;
      (out.users[r.user_id] = out.users[r.user_id] || { badges: [] }).badges.push(r.badge_id);
    }
    const json = JSON.stringify(out, null, 2) + '\n';
    if (arg) { fs.writeFileSync(arg, json); console.log(`Wrote ${Object.keys(out.users).length} user(s) to ${arg}`); }
    else process.stdout.write(json);
    return;
  }

  if (cmd === 'import') {
    if (!arg) usage();
    let data;
    try { data = JSON.parse(fs.readFileSync(arg, 'utf8')); }
    catch (e) { console.error(`Could not read ${arg}: ${e.message}`); process.exit(1); }
    if (!data || typeof data.users !== 'object' || data.users === null) {
      console.error('Expected { "users": { "<id>": { "badges": [...] } } }'); process.exit(1);
    }
    ensureWalletTables(db);
    let added = 0, skipped = 0;
    for (const [key, entry] of Object.entries(data.users)) {
      const user = get(db, 'SELECT id, username FROM users WHERE id = ? OR username = ?', [key, key]);
      if (!user) { console.warn(`  skip: no user "${key}"`); skipped++; continue; }
      for (const badgeId of (entry && Array.isArray(entry.badges) ? entry.badges : [])) {
        const def = badges.getDefinition(badgeId);
        if (!def) { console.warn(`  skip: "${badgeId}" is not a defined badge (@${user.username})`); skipped++; continue; }
        if (!def.assignable) { console.warn(`  skip: "${badgeId}" is automatic and can't be assigned (@${user.username})`); skipped++; continue; }
        if (get(db, 'SELECT 1 AS x FROM user_badges WHERE user_id = ? AND badge_id = ?', [user.id, badgeId])) continue;
        run(db, 'INSERT INTO user_badges (user_id, badge_id, assigned_by, assigned_at) VALUES (?, ?, NULL, ?)', [user.id, badgeId, Date.now()]);
        audit(db, null, 'SYSTEM_BADGE_IMPORTED', user.id, { badge: badgeId, source: 'scripts/badges.js' });
        console.log(`  + ${def.name} → @${user.username}`);
        added++;
      }
    }
    console.log(`Done: ${added} added, ${skipped} skipped.`);
    console.log('\nIMPORTANT: if the server is currently running, restart it now so it reloads this from disk.');
    return;
  }

  usage();
}

main().then(() => process.exit(0)).catch(err => { console.error('Failed:', err.message); process.exit(1); });
