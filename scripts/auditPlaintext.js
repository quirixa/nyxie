#!/usr/bin/env node
// Counts (never prints) private-conversation messages that were stored as plaintext.
// Messages sent before 0.12.0 could be plaintext in one-to-one DMs; the server cannot
// encrypt them for you (it has no keys, by design), so this only reports how many exist.
// Usage: NYXIE_DATA_DIR=/path/to/data node scripts/auditPlaintext.js
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
(async () => {
  const dir = process.env.NYXIE_DATA_DIR || path.join(__dirname, '..', 'data');
  const users = path.join(dir, 'nyxie_users.db');
  if (!fs.existsSync(dir)) { console.error('Data directory not found:', dir); process.exit(1); }
  const msgs = fs.readdirSync(dir).find(f => /message/i.test(f) && f.endsWith('.db'));
  if (!fs.existsSync(users) || !msgs) { console.error('Could not find the databases in', dir); process.exit(1); }
  const SQL = await initSqlJs();
  const u = new SQL.Database(fs.readFileSync(users));
  const m = new SQL.Database(fs.readFileSync(path.join(dir, msgs)));
  const rooms = u.exec('SELECT id, COALESCE(is_group,0) FROM rooms WHERE is_dm = 1');
  const kind = new Map((rooms[0]?.values || []).map(([id, g]) => [id, g ? 'group' : 'direct']));
  const counts = { direct: { total: 0, plaintext: 0 }, group: { total: 0, plaintext: 0 } };
  const rows = m.exec("SELECT room_id, nonce, COALESCE(content,'') FROM messages")[0]?.values || [];
  for (const [room, nonce, content] of rows) {
    const k = kind.get(room); if (!k) continue;
    counts[k].total++;
    if (!nonce && content) counts[k].plaintext++;
  }
  console.log('Private conversation messages (counts only):');
  for (const k of ['direct', 'group']) console.log(`  ${k}: ${counts[k].plaintext} plaintext of ${counts[k].total}`);
  console.log('Server channels are not end-to-end encrypted and are not counted here.');
})();
