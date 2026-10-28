// 0.8.0 privacy tests: "Last seen" is gone everywhere, Invisible users do not
// leak through REST or WebSocket presence, and normal presence still works.
// Every test boots the real server on a throwaway data dir (see helpers.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');
const helpers = require('./helpers');
const { startServer, registerUser, sleep, client, ROOT } = helpers;

// Every socket a test opens is terminated when the server stops, so a failing
// assertion fails the test promptly instead of leaving sockets open and
// hanging the whole file until the timeout.
const OPEN_SOCKETS = [];
async function openWs(base, token) {
  const w = await helpers.openWs(base, token);
  OPEN_SOCKETS.push(w);
  return w;
}
function closeAllSockets() { for (const w of OPEN_SOCKETS.splice(0)) { try { w.ws.terminate(); } catch (_) {} } }

const QUIET_MS = 600;           // how long we wait to prove "nothing was sent"
const LAST_SEEN_KEY = /last[_-]?(seen|active|online|login|activity|connected)/i;

// Every object key found anywhere in a JSON value.
function allKeys(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach(v => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.add(k); allKeys(v, out); }
  }
  return out;
}
function assertNoLastSeen(label, json) {
  const bad = [...allKeys(json)].filter(k => LAST_SEEN_KEY.test(k));
  assert.deepEqual(bad, [], `${label} exposes ${bad.join(', ')}`);
}
const presenceOf = (msgs, userId, from = 0) =>
  msgs.slice(from).filter(m => m.type === 'presence_update' && m.user_id === userId);

async function readDb(dir) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(path.join(dir, 'nyxie_users.db')));
  const q = (sql, p = []) => { const st = db.prepare(sql); st.bind(p); const r = []; while (st.step()) r.push(st.getAsObject()); st.free(); return r; };
  return { db, q };
}

// ─── Static: the feature is removed from the code, not just hidden ───────────
test('no last-seen code remains in the server or the frontend', () => {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  // The only server files allowed to name the column: the migration that
  // clears it and the schema line that keeps it (deprecated, always NULL).
  const serverAllowed = new Set(['database/migrations.js', 'database/userDb.js']
    .map(f => path.join(ROOT, 'server', f)));
  for (const f of walk(path.join(ROOT, 'server')).filter(f => f.endsWith('.js'))) {
    if (serverAllowed.has(f)) continue;
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /last_seen|lastSeen|last-seen/, `${path.relative(ROOT, f)} mentions last seen`);
  }
  // userDb.js may only mention it in the deprecated column definition.
  const userDbHits = fs.readFileSync(path.join(ROOT, 'server/database/userDb.js'), 'utf8')
    .split('\n').filter(l => /last_seen/.test(l));
  assert.equal(userDbHits.length, 1);
  assert.match(userDbHits[0], /DEPRECATED/);

  // Frontend: no field access, formatter or "last seen <time>" template.
  // (The in-app changelog legitimately describes the removal in prose.)
  const publicFiles = walk(path.join(ROOT, 'public')).filter(f => /\.(js|html|css)$/.test(f));
  for (const f of publicFiles) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /last_seen|lastSeen|LastSeen|`last seen/, `${path.relative(ROOT, f)} still renders last seen`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), /last seen/i);
});

// ─── Database: nothing writes last_seen any more ─────────────────────────────
test('registering, logging in and connecting/disconnecting never writes last_seen', async () => {
  const s = await startServer();
  try {
    const u = await registerUser(s.base, 'dbpriv');
    const login = await fetch(s.base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u.username, password: 'correct-horse-battery' })
    });
    assert.equal(login.status, 200);
    const body = await login.json();
    assertNoLastSeen('login response', body);
    const w = await openWs(s.base, body.token);
    await w.waitFor(m => m.type === 'connected');
    w.close();
    await sleep(300);
  } finally { closeAllSockets(); await s.stop(); }
  const { db, q } = await readDb(s.dir);
  assert.equal(q('SELECT COUNT(*) AS c FROM users')[0].c, 1);
  assert.equal(q('SELECT COUNT(*) AS c FROM users WHERE last_seen IS NOT NULL')[0].c, 0, 'last_seen stays NULL');
  db.close();
});

test('migration clears stored last_seen values once and keeps session/auth timestamps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxie-privmig-'));
  let s = await startServer({ dataDir: dir });
  const u = await registerUser(s.base, 'migpriv');
  await s.stop();

  // Rewind to a 0.7.0-shaped database: last_seen populated, migration unrecorded.
  const SQL = await initSqlJs();
  const file = path.join(dir, 'nyxie_users.db');
  let db = new SQL.Database(fs.readFileSync(file));
  db.run('UPDATE users SET last_seen = 1700000000000');
  db.run("DELETE FROM schema_migrations WHERE id = '0.8.0-clear-last-seen'");
  const sessBefore = [];
  { const st = db.prepare('SELECT id, last_active, created_at FROM user_sessions'); while (st.step()) sessBefore.push(st.getAsObject()); st.free(); }
  assert.ok(sessBefore.length >= 1);
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();

  s = await startServer({ dataDir: dir });
  try {
    // Login still works on the migrated database (the test helper rotates
    // JWT_SECRET per start, so an old token cannot be reused here).
    const login = await fetch(s.base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u.username, password: 'correct-horse-battery' })
    });
    assert.equal(login.status, 200);
  } finally { await s.stop(); }

  const { db: db2, q } = await readDb(dir);
  assert.equal(q('SELECT COUNT(*) AS c FROM users WHERE last_seen IS NOT NULL')[0].c, 0, 'old values wiped');
  assert.equal(q('SELECT COUNT(*) AS c FROM users')[0].c, 1, 'user preserved');
  assert.equal(q("SELECT COUNT(*) AS c FROM schema_migrations WHERE id = '0.8.0-clear-last-seen'")[0].c, 1);
  for (const row of sessBefore) {
    const after = q('SELECT last_active, created_at FROM user_sessions WHERE id = ?', [row.id])[0];
    assert.ok(after, 'session row kept');
    assert.equal(after.created_at, row.created_at);
    assert.ok(after.last_active >= row.last_active, 'session last_active (expiry) still maintained');
  }
  db2.close();
});

// ─── Shared fixture for the REST / WebSocket tests ───────────────────────────
async function fixture() {
  const s = await startServer();
  const stop = s.stop;
  s.stop = async () => { closeAllSockets(); await stop(); };
  const a = await registerUser(s.base, 'alice');   // the user whose presence we try to leak
  const b = await registerUser(s.base, 'bob');     // friend, shares a DM and a server
  const c = await registerUser(s.base, 'carol');   // not a friend; shares a group + server
  // friends a <-> b
  const fr = await a.post('/friends/request', { to_id: b.id });
  assert.equal(fr.status, 201);
  const reqId = (await b.get('/friends/requests')).body.incoming[0].id;
  assert.equal((await b.post(`/friends/requests/${reqId}/accept`)).status, 200);
  // rooms
  const dmAB = (await a.post('/rooms/dm', { target_user_id: b.id })).body.room_id;
  const dmAC = (await a.post('/rooms/dm', { target_user_id: c.id })).body.room_id;
  const dmBC = (await b.post('/rooms/dm', { target_user_id: c.id })).body.room_id;
  const group = (await a.post('/groups', { name: 'privgroup', member_ids: [b.id, c.id] })).body.group.id;
  // a server with everyone in it
  const sid = (await a.post('/servers', { name: 'PrivServer' })).body.server.id;
  for (const u of [b, c]) { const inv = (await a.post(`/servers/${sid}/invites`, {})).body.invite.code; await u.post(`/invites/${inv}/join`); }
  return { s, a, b, c, dmAB, dmAC, dmBC, group, sid };
}

test('no user-facing endpoint or event exposes a last-seen / last-active timestamp', async () => {
  const f = await fixture();
  const { s, a, b, c, group, sid } = f;
  try {
    // Make A actually connected so any such field would have a value.
    const wa = await openWs(s.base, a.token);
    await wa.waitFor(m => m.type === 'connected');
    assertNoLastSeen('ws connected', wa.msgs.find(m => m.type === 'connected'));

    const responses = {
      'GET /users/:id (other)': await b.get(`/users/${a.id}`),
      'GET /users/:id (self)': await a.get(`/users/${a.id}`),
      'GET /users/search': await b.get(`/users/search?q=${a.username.slice(0, 6)}`),
      'GET /auth/me': await a.get('/auth/me'),
      'GET /friends': await b.get('/friends'),
      'GET /friends/requests': await b.get('/friends/requests'),
      'GET /groups': await b.get('/groups'),
      'GET /groups/:id': await b.get(`/groups/${group}`),
      'GET /rooms': await b.get('/rooms'),
      'GET /servers/:id/members': await b.get(`/servers/${sid}/members`),
      'GET /servers/:id/members (paged)': await a.get(`/servers/${sid}/members?page=1`),
      'GET /servers/:id': await b.get(`/servers/${sid}`),
    };
    for (const [label, r] of Object.entries(responses)) {
      assert.ok(r.status >= 200 && r.status < 300, `${label} -> ${r.status}`);
      assertNoLastSeen(label, r.body);
    }
    // sanity: the profile still has the normal fields (we didn't just break it)
    const prof = responses['GET /users/:id (other)'].body.user;
    assert.equal(prof.username, a.username);
    assert.equal(prof.status, 'online');
    assert.ok(prof.created_at);

    // WebSocket: room_state and the friend_accepted payload.
    const wb = await openWs(s.base, b.token);
    wb.send({ type: 'join_room', room_id: group });
    const state = await wb.waitFor(m => m.type === 'room_state');
    assertNoLastSeen('room_state', state);
    const d = await registerUser(s.base, 'dave');
    await d.post('/friends/request', { to_id: a.id });
    const rid = (await a.get('/friends/requests')).body.incoming[0].id;
    const wd = await openWs(s.base, d.token);
    await a.post(`/friends/requests/${rid}/accept`);
    const accepted = await wd.waitFor(m => m.type === 'friend_accepted');
    assertNoLastSeen('friend_accepted', accepted);
    for (const w of [wa, wb, wd]) assertNoLastSeen('all ws traffic', w.msgs);
    [wa, wb, wd].forEach(w => w.close());
  } finally { await s.stop(); }
});

test('session last_active is only ever shown to the account owner', async () => {
  const f = await fixture();
  const { s, a, b } = f;
  try {
    const mine = (await a.get('/account/sessions')).body.sessions;
    const theirs = (await b.get('/account/sessions')).body.sessions;
    assert.ok(mine.length >= 1 && mine.every(x => typeof x.lastActive === 'number'), 'own device list keeps lastActive');
    const mineIds = new Set(mine.map(x => x.id));
    assert.ok(theirs.every(x => !mineIds.has(x.id)), "B never sees A's sessions");
    assert.equal((await client(s.base).get('/account/sessions')).status, 401);
    assert.equal((await client(s.base).get(`/users/${a.id}`)).status, 401);
  } finally { await s.stop(); }
});

// ─── Invisible never looks online through any endpoint ───────────────────────
test('Invisible user reads as offline on every endpoint but invisible to themself', async () => {
  const f = await fixture();
  const { s, a, b, c, dmAB, group, sid } = f;
  try {
    assert.equal((await a.patch('/users/status', { status: 'invisible' })).status, 200);
    const wa = await openWs(s.base, a.token);                 // connected AND invisible
    await wa.waitFor(m => m.type === 'connected');
    const connected = wa.msgs.find(m => m.type === 'connected');
    assert.equal(connected.user.status, 'invisible', 'own client still told the truth');

    for (const viewer of [b, c]) {
      assert.equal((await viewer.get(`/users/${a.id}`)).body.user.status, 'offline', 'profile popout');
      const found = (await viewer.get(`/users/search?q=${a.username}`)).body.users.find(u => u.id === a.id);
      assert.equal(found.status, 'offline', 'search');
      const mem = (await viewer.get(`/servers/${sid}/members`)).body.members.find(m => m.id === a.id);
      assert.equal(mem.status, 'offline', 'server member list');
      const grp = (await viewer.get(`/groups/${group}`)).body.group.members.find(m => m.user_id === a.id || m.id === a.id);
      assert.equal(grp.status, 'offline', 'group member list');
    }
    assert.equal((await b.get('/friends')).body.friends.find(x => x.id === a.id).status, 'offline', 'friend list');
    assert.equal((await (await client(s.base, b.token)).get(`/servers/${sid}/members?page=1`)).body.members.find(m => m.id === a.id).status, 'offline', 'paged server members');
    const wb = await openWs(s.base, b.token);
    wb.send({ type: 'join_room', room_id: dmAB });
    const st = await wb.waitFor(m => m.type === 'room_state');
    assert.equal(st.members.find(m => m.id === a.id).status, 'offline', 'WS room_state');

    // self view is truthful
    assert.equal((await a.get(`/users/${a.id}`)).body.user.status, 'invisible');
    assert.equal((await a.get('/auth/me')).body.user.status, 'invisible');
    wa.close(); wb.close();
  } finally { await s.stop(); }
});

// ─── No presence traffic from Invisible users (status transitions, reconnects) ─
test('Invisible users emit no presence events on connect, join, re-select, reconnect or disconnect', async () => {
  const f = await fixture();
  const { s, a, b, c, dmAB, group } = f;
  try {
    await a.patch('/users/status', { status: 'invisible' });
    const wb = await openWs(s.base, b.token);
    const wc = await openWs(s.base, c.token);
    wb.send({ type: 'join_room', room_id: dmAB });
    wc.send({ type: 'join_room', room_id: group });
    await wb.waitFor(m => m.type === 'joined_room');
    await wc.waitFor(m => m.type === 'joined_room');
    await sleep(100);
    const markB = wb.msgs.length, markC = wc.msgs.length;

    let wa = await openWs(s.base, a.token);                  // connect
    await wa.waitFor(m => m.type === 'connected');
    wa.send({ type: 'join_room', room_id: dmAB });           // open a conversation
    wa.send({ type: 'join_room', room_id: group });
    await wa.waitFor(m => m.type === 'joined_room');
    wa.send({ type: 'set_status', status: 'invisible' });    // re-pick the same status
    await sleep(QUIET_MS);
    wa.close();                                              // disconnect
    await sleep(QUIET_MS);
    wa = await openWs(s.base, a.token);                      // reconnect
    await wa.waitFor(m => m.type === 'connected');
    await sleep(QUIET_MS);
    wa.close();
    await sleep(QUIET_MS);

    assert.deepEqual(presenceOf(wb.msgs, a.id, markB), [], 'friend + DM room saw nothing');
    assert.deepEqual(presenceOf(wc.msgs, a.id, markC), [], 'group member saw nothing');
    wb.close(); wc.close();
  } finally { await s.stop(); }
});

test('going Invisible announces exactly "offline"; coming back announces the real status', async () => {
  const f = await fixture();
  const { s, a, b, dmAB } = f;
  try {
    const wb = await openWs(s.base, b.token);
    wb.send({ type: 'join_room', room_id: dmAB });
    await wb.waitFor(m => m.type === 'joined_room');
    const wa = await openWs(s.base, a.token);
    await wa.waitFor(m => m.type === 'connected');
    wa.send({ type: 'join_room', room_id: dmAB });
    await wb.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'online');

    let mark = wb.msgs.length;
    wa.send({ type: 'set_status', status: 'invisible' });
    await wb.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'offline');
    assert.ok(presenceOf(wb.msgs, a.id, mark).every(m => m.status === 'offline'), 'never "invisible" on the wire');
    assertNoLastSeen('events', wb.msgs);

    mark = wb.msgs.length;
    wa.send({ type: 'set_status', status: 'dnd' });
    await wb.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'dnd');
    assert.ok(presenceOf(wb.msgs, a.id, mark).every(m => m.status !== 'invisible'));
    wa.close(); wb.close();
  } finally { await s.stop(); }
});

// ─── Stale presence ──────────────────────────────────────────────────────────
test('status change reaches every room across several sockets (no stale "online" after Invisible)', async () => {
  const f = await fixture();
  const { s, a, b, c, dmAB, group } = f;
  try {
    const wb = await openWs(s.base, b.token);
    const wc = await openWs(s.base, c.token);                // c shares only the group with a (not friends)
    wb.send({ type: 'join_room', room_id: dmAB });
    wc.send({ type: 'join_room', room_id: group });
    await wb.waitFor(m => m.type === 'joined_room'); await wc.waitFor(m => m.type === 'joined_room');

    const tab1 = await openWs(s.base, a.token);              // tab 1: DM with b
    const tab2 = await openWs(s.base, a.token);              // tab 2: the group with c
    await tab1.waitFor(m => m.type === 'connected'); await tab2.waitFor(m => m.type === 'connected');
    tab1.send({ type: 'join_room', room_id: dmAB });
    tab2.send({ type: 'join_room', room_id: group });
    await wc.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'online');

    const mark = wc.msgs.length;
    tab1.send({ type: 'set_status', status: 'invisible' });  // changed from tab 1 only
    await wc.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'offline');
    assert.equal(presenceOf(wc.msgs, a.id, mark).pop().status, 'offline', "group room (tab 2's room) updated too");
    await tab2.waitFor(m => m.type === 'self_status' && m.status === 'invisible');
    [tab1, tab2, wb, wc].forEach(w => w.close());
  } finally { await s.stop(); }
});

test('last disconnect marks the user offline in every room, not just the last socket\'s', async () => {
  const f = await fixture();
  const { s, a, b, c, dmAB, group } = f;
  try {
    const wc = await openWs(s.base, c.token);
    wc.send({ type: 'join_room', room_id: group });
    await wc.waitFor(m => m.type === 'joined_room');
    const tab1 = await openWs(s.base, a.token);              // the only tab in the group
    const tab2 = await openWs(s.base, a.token);              // the last tab, only in the DM
    await tab1.waitFor(m => m.type === 'connected'); await tab2.waitFor(m => m.type === 'connected');
    tab1.send({ type: 'join_room', room_id: group });
    tab2.send({ type: 'join_room', room_id: dmAB });
    await wc.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'online');

    const mark = wc.msgs.length;
    tab1.close(); await sleep(300);
    assert.deepEqual(presenceOf(wc.msgs, a.id, mark), [], 'still connected elsewhere: no offline yet');
    tab2.close();
    const off = await wc.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'offline');
    assert.ok(off);
    assert.equal((await c.get(`/users/${a.id}`)).body.user.status, 'offline');
    wc.close();
  } finally { await s.stop(); }
});

test('PATCH /auth/status and PATCH /users/status both notify others', async () => {
  const f = await fixture();
  const { s, a, b, dmAB } = f;
  try {
    const wb = await openWs(s.base, b.token);
    wb.send({ type: 'join_room', room_id: dmAB });
    await wb.waitFor(m => m.type === 'joined_room');
    const wa = await openWs(s.base, a.token);
    await wa.waitFor(m => m.type === 'connected');
    wa.send({ type: 'join_room', room_id: dmAB });
    await wb.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'online');

    let mark = wb.msgs.length;
    assert.equal((await a.patch('/auth/status', { status: 'invisible' })).status, 200);
    await wb.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'offline');
    mark = wb.msgs.length;
    assert.equal((await a.patch('/users/status', { status: 'idle' })).status, 200);
    await wb.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'idle');
    assert.equal((await b.get(`/users/${a.id}`)).body.user.status, 'idle');
    wa.close(); wb.close();
  } finally { await s.stop(); }
});

// ─── Calls must not reveal an Invisible user ─────────────────────────────────
test('calling an Invisible user who is on a call gets no "busy" answer; visible users still do', async () => {
  const f = await fixture();
  const { s, a, b, c, dmAB, dmAC } = f;
  try {
    const wa = await openWs(s.base, a.token), wb = await openWs(s.base, b.token), wc = await openWs(s.base, c.token);
    for (const w of [wa, wb, wc]) await w.waitFor(m => m.type === 'connected');
    const offer = (w, to, room, id) => w.send({ type: 'call_offer', target_user_id: to, room_id: room, call_id: id, sdp: 'x', ephemeral_pubkey: 'k' });

    // A (Invisible) ends up on a call with C ...
    await a.patch('/users/status', { status: 'invisible' });
    offer(wc, a.id, dmAC, 'call-1');
    await wa.waitFor(m => m.type === 'call_offer' && m.call_id === 'call-1');
    // ... B rings A: no call_busy, exactly like ringing an offline user.
    offer(wb, a.id, dmAB, 'call-2');
    await sleep(QUIET_MS);
    assert.equal(wb.msgs.find(m => m.type === 'call_busy'), undefined, 'busy would reveal A is online');
    wc.send({ type: 'call_end', call_id: 'call-1' });
    await wa.waitFor(m => m.type === 'call_end');

    // Control: a visible user who is busy still answers "busy".
    await a.patch('/users/status', { status: 'online' });
    offer(wc, a.id, dmAC, 'call-3');
    await wa.waitFor(m => m.type === 'call_offer' && m.call_id === 'call-3');
    offer(wb, a.id, dmAB, 'call-4');
    const busy = await wb.waitFor(m => m.type === 'call_busy' && m.call_id === 'call-4');
    assert.ok(busy);
    [wa, wb, wc].forEach(w => w.close());
  } finally { await s.stop(); }
});

// ─── Legitimate presence still works ─────────────────────────────────────────
test('Online, Idle, Do Not Disturb and offline are still reported to others', async () => {
  const f = await fixture();
  const { s, a, b, c, dmAB } = f;
  try {
    const wb = await openWs(s.base, b.token);
    wb.send({ type: 'join_room', room_id: dmAB });
    await wb.waitFor(m => m.type === 'joined_room');

    // not connected -> offline
    assert.equal((await b.get(`/users/${a.id}`)).body.user.status, 'offline');
    assert.equal((await b.get('/friends')).body.friends.find(x => x.id === a.id).status, 'offline');

    const wa = await openWs(s.base, a.token);
    await wa.waitFor(m => m.type === 'connected');
    wa.send({ type: 'join_room', room_id: dmAB });
    await wb.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'online');
    const st = await wb.waitFor(m => m.type === 'room_state');
    assert.ok(st);
    assert.equal((await b.get(`/users/${a.id}`)).body.user.status, 'online');
    assert.equal((await b.get('/friends')).body.friends.find(x => x.id === a.id).status, 'online');
    assert.equal((await c.get(`/users/search?q=${a.username}`)).body.users.find(u => u.id === a.id).status, 'online');

    for (const status of ['idle', 'dnd']) {
      wa.send({ type: 'set_status', status });
      await wb.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === status);
      assert.equal((await b.get(`/users/${a.id}`)).body.user.status, status);
    }
    // preference survives a reconnect and is not reset to online
    wa.close();
    await wb.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'offline');
    const wa2 = await openWs(s.base, a.token);
    const hello = await wa2.waitFor(m => m.type === 'connected');
    assert.equal(hello.user.status, 'dnd');
    await wb.waitFor(m => m.type === 'presence_update' && m.user_id === a.id && m.status === 'dnd');
    wa2.close(); wb.close();
  } finally { await s.stop(); }
});
