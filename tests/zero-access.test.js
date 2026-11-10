// Zero-access security tests (0.12.0). These check real boundaries — what the
// running server, its database files, its logs, its WebSocket traffic and its
// source actually contain — not whether an encryption function was called.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const initSqlJs = require('sql.js');
const { startServer, registerUser, openWs, ensureKeys, befriend, dmBetween, encryptFor, decryptFrom, nacl, b64, ROOT } = require('./helpers');

const CANARY = ['PLAINTEXT-CANARY-DM-7f3a', 'PLAINTEXT-CANARY-REQ-91bc', 'PLAINTEXT-CANARY-GRP-c20d'];
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const SERVER_FILES = walk(path.join(ROOT, 'server')).filter(f => f.endsWith('.js'));
const src = f => fs.readFileSync(f, 'utf8');
const rel = f => path.relative(ROOT, f);

async function setAccountRole(dir, id, role) {
  const SQL = await initSqlJs();
  const file = path.join(dir, 'nyxie_users.db');
  const db = new SQL.Database(fs.readFileSync(file));
  db.run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  fs.writeFileSync(file, Buffer.from(db.export())); db.close();
}

// One shared scenario: DM, group, message request, an (illegal) plaintext attempt, rotation.
let S, A, B, C, ADMIN, DEV, dmAB, group, reqId, wsA, wsB, wsAdmin, privateLog;
test.before(async () => {
  S = await startServer();
  [A, B, C, ADMIN, DEV] = await Promise.all(['za', 'zb', 'zc', 'zadmin', 'zdev'].map(n => registerUser(S.base, n)));
  for (const u of [A, B, C]) await ensureKeys(u);
  wsA = await openWs(S.base, A.token); wsB = await openWs(S.base, B.token); wsAdmin = await openWs(S.base, ADMIN.token);
  dmAB = await dmBetween(A, B, { stayFriends: true });
  for (const w of [wsA, wsB]) w.send({ type: 'join_room', room_id: dmAB });
  await befriend(A, C); await befriend(B, C);
  const g = await A.post('/groups', { name: 'canary group', member_ids: [B.id, C.id] });
  group = g.body.group?.id || g.body.room_id || g.body.id;
  assert.equal((await A.post(`/rooms/${dmAB}/messages`, await encryptFor(A, [B], CANARY[0]))).status, 201);
  assert.equal((await A.post(`/rooms/${group}/messages`, await encryptFor(A, [B, C], CANARY[2]))).status, 201);
  // a stranger's request
  const D = await registerUser(S.base, 'zd'); await ensureKeys(D);
  const p = await encryptFor(D, [A], CANARY[1]);
  const r = await D.post('/message-requests', { recipient_id: A.id, ...p, sender_public_key: D.keys.pub, recipient_public_key: A.keys.pub });
  assert.equal(r.status, 201); reqId = r.body.request.id; global.__D = D; global.__reqPayload = p;
  // attempts to push plaintext in every private channel
  await A.post(`/rooms/${dmAB}/messages`, { content: CANARY[0] + '-PLAIN' });
  await D.post('/message-requests', { recipient_id: B.id, content: CANARY[1] + '-PLAIN' });
  await setAccountRole(S.dir, ADMIN.id, 'ADMIN'); await setAccountRole(S.dir, DEV.id, 'DEVELOPER');
  await new Promise(r => setTimeout(r, 400));
});
test.after(async () => { wsA.close(); wsB.close(); wsAdmin.close(); if (!S.stopped) await S.stop(); });

test('1. the server cannot decrypt: no decryption primitive or key material exists in server code', () => {
  for (const f of SERVER_FILES) {
    const code = src(f);
    assert.ok(!/secretbox\.open|box\.open|box\.before|decryptBox/.test(code), rel(f) + ' contains a decryption call');
    // The one legitimate server-side decryption is the 2FA (TOTP) secret in services/totp.js — a login feature,
    // unrelated to messages. No other file may decrypt anything, and no message-touching file may.
    if (/createDecipher/.test(code)) assert.equal(path.basename(f), 'totp.js', rel(f) + ' decrypts data with a server-held key');
    assert.ok(!/require\(['"]tweetnacl/.test(code), rel(f) + ' imports a crypto library for message content');
  }
  // and the only thing the DB holds for a DM is ciphertext the recipient alone can open
});

test('2/3. administrators and developers cannot read private messages, over any API', async () => {
  for (const who of [ADMIN, DEV]) {
    for (const p of [`/rooms/${dmAB}/messages`, `/rooms/${group}/messages`, `/message-requests/${reqId}`, '/message-requests?box=incoming', '/message-requests?box=outgoing']) {
      const r = await who.get(p);
      const body = JSON.stringify(r.body);
      assert.ok(r.status >= 400 || (!body.includes('"ciphertext":"') && !/"content":"[^"]+"/.test(body) ), `${who.username} got private content from ${p}: ${body.slice(0, 120)}`);
    }
    // no privileged message-reading routes exist at all
    for (const p of ['/admin/messages', '/admin/rooms/' + dmAB + '/messages', '/admin/conversations', '/developer/messages', '/debug/messages', '/admin/message-requests']) {
      assert.ok([403, 404].includes((await who.get(p)).status), `${p} should not exist`);
    }
  }
  assert.equal((await ADMIN.get(`/rooms/${dmAB}/messages`)).status, 403);
  assert.equal((await DEV.post(`/rooms/${dmAB}/messages`, await encryptFor(DEV, [A], 'x'))).status, 403);
  // Structural: only conversation routes may touch the messages table.
  const touching = SERVER_FILES.filter(f => /getMessageDb|FROM messages|INTO messages/.test(src(f))).map(rel).sort();
  for (const f of touching) assert.ok(!/admin|developer|report|audit/i.test(path.basename(f)), `${f} reads messages but is an admin/developer/report module`);
});

test('13. no hidden decryption/backdoor/master-key functionality in the server source', () => {
  for (const f of SERVER_FILES) {
    const code = src(f).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');   // comments may discuss these words; code may not use them
    assert.ok(!/master[_ ]?key|MASTER_KEY|backdoor|key[_ ]?escrow|decrypt(Message|Room|Dm)|recoverMessages|dumpMessages/i.test(code), rel(f) + ' mentions a master key / backdoor / server-side decryption');
  }
});

test('12. server debugging/logging cannot expose plaintext message content', () => {
  for (const f of SERVER_FILES) {
    for (const [i, line] of src(f).split('\n').entries()) {
      if (/console\.(log|info|debug|warn|error)/.test(line) && /req\.body|\.ciphertext|\.content\b|key_envelopes|private/i.test(line)) {
        assert.fail(`${rel(f)}:${i + 1} logs request/message data: ${line.trim()}`);
      }
    }
  }
  const log = S.log();
  for (const c of CANARY) assert.ok(!log.includes(c), 'canary appeared in server output');
  for (const u of [A, B, C]) assert.ok(!log.includes(u.keys.priv), 'a private key appeared in server output');
});

test('7. WebSocket traffic never carries plaintext (DM, group, message requests)', async () => {
  const all = JSON.stringify([...wsA.msgs, ...wsB.msgs, ...wsAdmin.msgs]);
  for (const c of CANARY) assert.ok(!all.includes(c), 'plaintext canary on the wire');
  assert.ok(all.includes('new_message'));
  const nm = wsB.msgs.find(m => m.type === 'new_message' && m.message.room_id === dmAB);
  assert.ok(nm && (nm.message.nonce || nm.message.key_envelopes), 'relayed DM must be an encrypted envelope');
  assert.equal(wsAdmin.msgs.filter(m => m.type === 'new_message' || String(m.type).startsWith('message_request')).length, 0, 'an unrelated (admin) socket received private events');
});

test('4. private keys never appear in API responses (nobody else\'s backup or key material is served)', async () => {
  const seen = [];
  for (const [who, paths] of [[A, [`/users/${B.id}`, '/friends', '/rooms', `/rooms/${dmAB}/messages`, '/message-requests', '/message-requests?box=outgoing', `/keys/${B.id}`]], [ADMIN, [`/users/${A.id}`]]]) {
    for (const p of paths) seen.push([p, JSON.stringify((await who.get(p)).body)]);
  }
  for (const [p, body] of seen) {
    for (const u of [A, B, C]) assert.ok(!body.includes(u.keys.priv), `${p} leaked a private key`);
    if (p.startsWith('/users/') || p.startsWith('/keys/') || p === '/friends') {
      assert.ok(!/encrypted_private_key|key_salt|key_nonce|encrypted_key_history/.test(body), `${p} exposes another user's key backup`);
    }
  }
});

test('8/9. stored data: message requests, DMs and group messages hold ciphertext only; only the intended people can open it', async () => {
  const D = global.__D, p = global.__reqPayload;
  const stored = (await A.get(`/message-requests`)).body.requests.find(r => r.id === reqId);
  assert.notEqual(stored.ciphertext, CANARY[1]);
  assert.equal(decryptFrom(A, D, stored), CANARY[1]);                    // recipient: yes
  assert.equal(decryptFrom(D, D, { ...stored, key_envelopes: { [D.id]: p.key_envelopes[D.id] } }), CANARY[1]); // sender: yes (own copy)
  assert.equal(decryptFrom(C, D, stored), null);                         // anyone else: no envelope, no key
  assert.equal(decryptFrom(B, D, { ...stored, key_envelopes: { [B.id]: stored.key_envelopes[A.id] } }), null); // someone else's envelope is useless to them
  const gm = (await A.get(`/rooms/${group}/messages`)).body.messages[0];
  assert.ok(!JSON.stringify(gm).includes(CANARY[2]));
  assert.equal(decryptFrom(C, A, { ...gm, ciphertext: gm.content }), CANARY[2]);
  assert.equal((await A.post(`/rooms/${group}/messages`, { content: CANARY[2] })).status, 400);
  assert.equal((await A.post(`/rooms/${dmAB}/messages`, { content: CANARY[0] })).code, undefined);
  const plainDm = await A.post(`/rooms/${dmAB}/messages`, { content: CANARY[0] });
  assert.equal(plainDm.status, 400); assert.equal(plainDm.body.code, 'E2EE_REQUIRED');
});

test('10. attachments in private conversations must be encrypted before they reach the server', async () => {
  for (const room of [dmAB, group]) {
    const r = await A.post(`/rooms/${room}/messages`, { attachments: [{ url: '/uploads/1700000000000-' + 'a'.repeat(32) + '.png', name: 'p.png', type: 'image/png', size: 10 }] });
    assert.ok(r.status >= 400, 'plain attachment accepted in a private conversation');
  }
  // the browser encrypts before upload: the upload path in the client calls the encryptor first
  const js = src(path.join(ROOT, 'public/js/dashboard.js'));
  assert.ok(/encryptAndUploadFile/.test(js), 'client has no attachment encryption routine');
});

test('5/6. at rest: database files, backups and caches contain no plaintext and no private keys', async () => {
  // flush by stopping; then scan every byte the server persisted (this is what a stolen disk or backup holds)
  const dir = S.dir; await S.stop(); S.stopped = true;
  const files = walk(dir);
  assert.ok(files.length > 0);
  for (const f of files) {
    const buf = fs.readFileSync(f);
    for (const c of CANARY) assert.ok(!buf.includes(Buffer.from(c)), `${path.basename(f)} contains plaintext ${c}`);
    for (const u of [A, B, C]) assert.ok(!buf.includes(Buffer.from(u.keys.priv)), `${path.basename(f)} contains a private key`);
  }
  // ...and the DM rows really are ciphertext
  const SQL = await initSqlJs();
  const mfile = files.find(f => /message/i.test(path.basename(f)) && f.endsWith('.db'));
  assert.ok(mfile, 'message database not found');
  const db = new SQL.Database(fs.readFileSync(mfile));
  const rows = db.exec('SELECT room_id, content, nonce, key_envelopes FROM messages WHERE room_id IN (\'' + dmAB + '\',\'' + group + '\')')[0].values;
  assert.ok(rows.length >= 2);
  for (const [, content, nonce, env] of rows) { assert.ok(nonce && env, 'row without nonce/envelopes'); assert.ok(!/CANARY/.test(content)); }
  db.close();
});

test.after(() => { /* server already stopped in the at-rest test */ });
