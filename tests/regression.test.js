// Regression checks for existing, non-server-settings features, plus
// release-metadata consistency.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, registerUser, openWs, client } = require('./helpers');
const ROOT = path.join(__dirname, '..');

test('startup refuses a missing/weak JWT_SECRET', async () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: { ...process.env, JWT_SECRET: 'short', NYXIE_DATA_DIR: require('os').tmpdir() + '/nyxie-x' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /JWT_SECRET/);
});

test('auth, DMs, live messaging, servers listing and static app still work', async () => {
  const s = await startServer();
  try {
    const a = await registerUser(s.base, 'alice');
    const b = await registerUser(s.base, 'bob');
    // login
    const login = await fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: a.username, password: 'correct-horse-battery' }) });
    assert.equal(login.status, 200);
    assert.ok((await login.json()).token);
    assert.equal((await fetch(s.base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + a.token } })).status, 200);
    assert.equal((await client(s.base).get('/servers')).status, 401);
    // DM + live message over WS
    const dmRes = (await a.post('/rooms/dm', { target_user_id: b.id })).body;
    const dm = { id: dmRes.room_id || (dmRes.room && dmRes.room.id) };
    assert.ok(dm.id, JSON.stringify(dmRes));
    const wsB = await openWs(s.base, b.token);
    wsB.send({ type: 'join_room', room_id: dm.id });
    await wsB.waitFor(m => m.type === 'joined_room');
    const sent = await a.post(`/rooms/${dm.id}/messages`, { content: 'hello bob' });
    assert.equal(sent.status, 201);
    await wsB.waitFor(m => m.type === 'new_message' && m.message.room_id === dm.id);
    assert.equal((await b.get(`/rooms/${dm.id}/messages`)).body.messages.length, 1);
    // a stranger can't read the DM
    const c = await registerUser(s.base, 'carol');
    assert.equal((await c.get(`/rooms/${dm.id}/messages`)).status, 403);
    wsB.close();
    // server channel flow for ordinary members
    const srv = (await a.post('/servers', { name: 'Reg' })).body;
    const inv = (await a.post(`/servers/${srv.server.id}/invites`, {})).body.invite.code;
    assert.equal((await b.post(`/invites/${inv}/join`)).status, 200);
    assert.equal((await b.post(`/channels/${srv.default_channel_id}/messages`, { content: 'hi' })).status, 201);
    assert.equal((await a.get(`/channels/${srv.default_channel_id}/messages`)).body.messages.length, 1);
    assert.equal((await b.get('/servers')).body.servers.length, 1);
    // upload + serve still work
    const fd = new FormData(); fd.append('file', new Blob(['hello']), 'a.txt');
    const up = await (await fetch(s.base + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: fd })).json();
    assert.ok(up.url);
    assert.equal((await fetch(s.base + up.url)).status, 200);
    // SPA shell, health
    assert.equal((await fetch(s.base + '/')).status, 200);
    assert.equal((await fetch(s.base + '/health')).status, 200);
    // wallet routes are untouched and still guarded
    assert.equal((await client(s.base).get('/wallet/balance')).status, 401);
  } finally { await s.stop(); }
});

test('release metadata: one version everywhere (and it is the newest entry)', () => {
  const pkg = require(path.join(ROOT, 'package.json')).version;
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, new RegExp(`nyxie beta v${pkg.replace(/\./g, '\\.')} — 2026`));
  const settings = fs.readFileSync(path.join(ROOT, 'public', 'js', 'settings.js'), 'utf8');
  assert.equal(/version: '([0-9.]+)'/.exec(settings)[1], pkg, 'newest in-app changelog entry');
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.equal(/^## \[([0-9.]+)\]/m.exec(changelog)[1], pkg, 'newest CHANGELOG.md entry');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(pkg));
  const lock = require(path.join(ROOT, 'package-lock.json'));
  assert.equal(lock.version, pkg);
});

// Static guards for mistakes that once shipped: a function defined twice in a
// closure (the later, stale copy silently wins) and `window.x = x` exports of
// something that is not defined (throws at load and aborts the exports after it).
const JS_DIR = path.join(ROOT, 'public', 'js');
// Only the files that are one big closure: other files (auth.js, notifications.js)
// legitimately reuse helper names inside separate closures.
test('frontend: no function is defined twice at closure level', () => {
  for (const f of ['dashboard.js', 'settings.js', 'serverSettings.js', 'serverSettingsPanels.js']) {
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    const seen = new Map();
    for (const m of src.matchAll(/^  (?:async )?function ([A-Za-z0-9_$]+)/gm)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    const dups = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    assert.deepEqual(dups, [], `${f} defines these twice: ${dups.join(', ')}`);
  }
});
test('frontend: every window.x = x export refers to a defined function', () => {
  const all = fs.readdirSync(JS_DIR).filter(x => x.endsWith('.js')).map(f => fs.readFileSync(path.join(JS_DIR, f), 'utf8')).join('\n');
  for (const f of fs.readdirSync(JS_DIR).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    const missing = [];
    for (const m of src.matchAll(/^\s*window\.([A-Za-z0-9_$]+)\s*=\s*([A-Za-z0-9_$]+)\s*;/gm)) {
      const name = m[2];
      if (['null', 'undefined', 'true', 'false'].includes(name) || /^[0-9]/.test(name)) continue;
      // may be defined in another script that shares the page's globals
      const defined = new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b|\\b${name}\\s*=\\s*(?:async\\s+)?function)`).test(all);
      if (!defined) missing.push(`window.${m[1]} = ${name}`);
    }
    assert.deepEqual(missing, [], `${f}: ${missing.join('; ')}`);
  }
});

// No sample/placeholder usernames anywhere in what ships. The word is built
// from pieces so this file does not contain it itself.
test('no placeholder or sample usernames in the project', () => {
  const banned = new RegExp(['zu', 'ko'].join(''), 'i');
  const hits = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'data', '.git'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(js|html|css|json|md|txt|example)$/.test(e.name) && e.name !== '.env.example') continue;
      if (banned.test(fs.readFileSync(full, 'utf8'))) hits.push(path.relative(ROOT, full));
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, [], 'sample username found in: ' + hits.join(', '));
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.equal(/>@username</.test(html), false, 'static @username text in index.html');
});
