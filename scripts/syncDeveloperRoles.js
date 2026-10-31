// scripts/syncDeveloperRoles.js — re-derive every account's DEVELOPER role from
// the official developer badge. Safe to run repeatedly (idempotent); never
// touches ADMIN accounts. The server does the same on every start; this is
// for running it by hand (e.g. after restoring a backup) without a restart.
//
// Usage: node scripts/syncDeveloperRoles.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getUserDb, flush } = require('../server/database/userDb');
const { reconcileDeveloperRoles } = require('../server/services/staff');

(async () => {
  const db = await getUserDb();
  const r = reconcileDeveloperRoles(db);
  if (typeof flush === 'function') flush();
  console.log(`Developer roles reconciled: ${r.promoted} promoted, ${r.demoted} demoted, ${r.developers} developer(s) in total.`);
  console.log('If the server is running, restart it (or let it reconcile on its next start).');
  process.exit(0);
})().catch(err => { console.error('Failed:', err.message); process.exit(1); });
