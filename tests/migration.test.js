// Verifies the 0.2.0 migrations against a disposable copy of a
// "pre-0.2.0" database: data is preserved, migrations apply once, and a
// restart does not re-apply them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');
const { startServer, registerUser } = require('./helpers');

test('upgrading a pre-0.2.0 database preserves data and migrates safely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxie-mig-'));
  // 1. create a fresh DB with the current server, then rewind it to look like 0.1.0
  let s = await startServer({ dataDir: dir });
  const owner = await registerUser(s.base, 'migowner');
  const member = await registerUser(s.base, 'migmember');
  const sid = (await owner.post('/servers', { name: 'Legacy' })).body.server.id;
  const inv = (await owner.post(`/servers/${sid}/invites`, {})).body.invite.code;
  await member.post(`/invites/${inv}/join`);
  await s.stop();

  const SQL = await initSqlJs();
  const file = path.join(dir, 'nyxie_users.db');
  const db = new SQL.Database(fs.readFileSync(file));
  const q = (sql, p = []) => { const st = db.prepare(sql); st.bind(p); const r = []; while (st.step()) r.push(st.getAsObject()); st.free(); return r; };
  // legacy permission bits only (original 11), two custom roles tied at position 10, one tied with Moderator
  db.run("UPDATE server_roles SET permissions = 3 | 32 WHERE is_default = 1");               // view|send|invites
  db.run("UPDATE server_roles SET permissions = 1|2|32|64|256 WHERE name = 'Moderator'");   // + kick, manage msgs
  const now = Date.now();
  db.run("INSERT INTO server_roles (id, server_id, name, permissions, position, is_default, display_separately, created_at) VALUES ('r-a', ?, 'CustomA', 8, 10, 0, 0, ?)", [sid, now + 1]);
  db.run("INSERT INTO server_roles (id, server_id, name, permissions, position, is_default, display_separately, created_at) VALUES ('r-b', ?, 'CustomB', 1, 10, 0, 0, ?)", [sid, now + 2]);
  // orphan assignment: a user who is no longer a member still has Admin
  const adminId = q("SELECT id FROM server_roles WHERE name='Admin'")[0].id;
  db.run("INSERT INTO server_member_roles (server_id, user_id, role_id, assigned_at) VALUES (?, 'ghost', ?, ?)", [sid, adminId, now]);
  db.run("DROP TABLE schema_migrations");
  fs.writeFileSync(file, Buffer.from(db.export()));
  const usersBefore = q('SELECT COUNT(*) AS c FROM users')[0].c;
  const membersBefore = q('SELECT COUNT(*) AS c FROM server_members')[0].c;
  db.close();

  // 2. start on the old data
  s = await startServer({ dataDir: dir });
  await s.stop(); // flush
  const db2 = new SQL.Database(fs.readFileSync(file));
  const q2 = (sql, p = []) => { const st = db2.prepare(sql); st.bind(p); const r = []; while (st.step()) r.push(st.getAsObject()); st.free(); return r; };
  assert.equal(q2('SELECT COUNT(*) AS c FROM users')[0].c, usersBefore, 'users preserved');
  assert.equal(q2('SELECT COUNT(*) AS c FROM server_members')[0].c, membersBefore, 'memberships preserved');
  const roles = q2('SELECT * FROM server_roles WHERE server_id = ? ORDER BY position DESC', [sid]);
  const byName = Object.fromEntries(roles.map(r => [r.name, r]));
  assert.equal(byName.Member.position, 0);
  assert.deepEqual(roles.map(r => r.position), [4, 3, 2, 1, 0], 'unique contiguous positions');
  assert.equal(byName.Admin.position, 4, 'relative order kept');
  assert.equal(byName.CustomA.position > byName.CustomB.position, true, 'ties broken older-first');
  assert.equal(byName.Member.permissions & 8192, 8192, 'default role gained READ_MESSAGE_HISTORY');
  assert.equal(byName.Member.permissions & 16384, 16384, 'default role gained ATTACH_FILES');
  assert.equal(byName.Moderator.permissions & 4096, 4096, 'kick holders gained TIMEOUT');
  assert.equal(byName.CustomA.permissions & 2048, 2048, 'manage-server holders gained VIEW_AUDIT_LOG');
  assert.equal(q2("SELECT COUNT(*) AS c FROM server_member_roles WHERE user_id = 'ghost'")[0].c, 0, 'orphan role rows removed');
  assert.equal(q2('SELECT COUNT(*) AS c FROM schema_migrations')[0].c, 4);
  assert.ok(fs.existsSync(file + '.pre-0.2.0.bak'), 'safety copy written before migrating');
  const stamp = q2('SELECT applied_at FROM schema_migrations ORDER BY id')[0].applied_at;
  db2.close();

  // 3. restart: migrations are not applied again
  s = await startServer({ dataDir: dir });
  await s.stop();
  const db3 = new SQL.Database(fs.readFileSync(file));
  const st = db3.prepare('SELECT applied_at FROM schema_migrations ORDER BY id'); st.step();
  assert.equal(st.getAsObject().applied_at, stamp);
  st.free(); db3.close();
});
