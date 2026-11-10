// Functional tests for 0.12.0: friend requests by username, DM restrictions,
// Message Requests (create/list/accept/ignore/deny/cancel), permissions,
// blocking, WebSocket delivery and persistence across a restart.
// Everything private is real ciphertext produced the way the browser does it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, registerUser, openWs, client, befriend, ensureKeys, encryptFor, decryptFrom, sleep } = require('./helpers');

async function setup(n = 3) {
  const s = await startServer();
  const users = [];
  for (let i = 0; i < n; i++) { const u = await registerUser(s.base, 'mr'); await ensureKeys(u); users.push(u); }
  return { s, users };
}
// An encrypted request body from `from` to `to`, built like the app does.
async function requestBody(from, to, text) {
  const p = await encryptFor(from, [to], text);
  return { recipient_id: to.id, ...p, sender_public_key: from.keys.pub, recipient_public_key: to.keys.pub };
}
const dmIds = async u => ((await u.get('/rooms')).body.rooms || []).filter(r => r.is_dm).map(r => r.id);

test('friend requests: by username, note limit, self, duplicates, existing friends, blocked', async () => {
  const { s, users: [a, b, c] } = await setup();
  try {
    assert.equal((await a.post('/friends/request', { username: a.username })).status, 400);                 // self
    assert.equal((await a.post('/friends/request', { username: 'nobody-here-xyz' })).status, 404);
    assert.equal((await a.post('/friends/request', { username: b.username, message: 'x'.repeat(121) })).status, 400);
    const ok = await a.post('/friends/request', { username: '@' + b.username.toUpperCase(), message: 'hi, it is Alice' });
    assert.equal(ok.status, 201);
    const dup = await a.post('/friends/request', { username: b.username });
    assert.equal(dup.status, 409); assert.equal(dup.body.code, 'REQUEST_PENDING');
    const inc = (await b.get('/friends/requests')).body.incoming;
    assert.equal(inc.length, 1); assert.equal(inc[0].message, 'hi, it is Alice');
    assert.equal((await a.get('/friends/requests')).body.outgoing.length, 1);                              // cancel is possible
    assert.equal((await b.post(`/friends/requests/${inc[0].id}/accept`)).status, 200);
    const again = await a.post('/friends/request', { username: b.username });
    assert.equal(again.status, 409); assert.equal(again.body.code, 'ALREADY_FRIENDS');
    // blocked users cannot send friend requests (either direction), generic refusal
    await c.post(`/friends/block/${a.id}`);
    assert.equal((await a.post('/friends/request', { username: c.username })).status, 403);
    assert.equal((await c.post('/friends/request', { username: a.username })).status, 403);
  } finally { await s.stop(); }
});

test('profile "Message" to a non-friend is a request: no DM exists, recipient sees ciphertext only', async () => {
  const { s, users: [a, b] } = await setup(2);
  try {
    const wsB = await openWs(s.base, b.token);
    const text = 'Hello from a stranger — PLAINTEXT-CANARY-1';
    const r = await a.post('/message-requests', await requestBody(a, b, text));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // real time, to the recipient only, as ciphertext
    const ev = await wsB.waitFor(m => m.type === 'message_request');
    assert.equal(ev.pending_count, 1);
    assert.ok(!JSON.stringify(ev).includes('PLAINTEXT-CANARY-1'));
    assert.equal(decryptFrom(b, a, ev.request), text);                                                      // recipient decrypts locally
    // no conversation for either side; sender cannot create one
    assert.deepEqual(await dmIds(a), []); assert.deepEqual(await dmIds(b), []);
    const direct = await a.post('/rooms/dm', { target_user_id: b.id });
    assert.equal(direct.status, 403); assert.equal(direct.body.code, 'NOT_FRIENDS');
    // one request only
    const dup = await a.post('/message-requests', await requestBody(a, b, 'second'));
    assert.equal(dup.status, 409); assert.equal(dup.body.code, 'REQUEST_PENDING');
    assert.deepEqual((await b.get('/message-requests')).body.requests.map(x => x.sender.id), [a.id]);
    assert.equal((await a.get('/message-requests?box=outgoing')).body.requests.length, 1);
    wsB.close();
  } finally { await s.stop(); }
});

test('accept: creates exactly one DM, keeps the ciphertext decryptable, both can keep talking, sender is told', async () => {
  const { s, users: [a, b] } = await setup(2);
  try {
    const wsA = await openWs(s.base, a.token);
    const req = (await a.post('/message-requests', await requestBody(a, b, 'first contact'))).body.request;
    const acc = await b.post(`/message-requests/${req.id}/accept`);
    assert.equal(acc.status, 200);
    await wsA.waitFor(m => m.type === 'message_request_updated' && m.status === 'accepted' && m.room_id === acc.body.room_id);
    await wsA.waitFor(m => m.type === 'dm_created');
    assert.deepEqual(await dmIds(a), [acc.body.room_id]); assert.deepEqual(await dmIds(b), [acc.body.room_id]);
    const again = await b.post(`/message-requests/${req.id}/accept`);                                       // idempotent: no duplicate DM
    assert.equal(again.body.room_id, acc.body.room_id);
    assert.equal((await dmIds(b)).length, 1);
    const msgs = (await b.get(`/rooms/${acc.body.room_id}/messages`)).body.messages;
    assert.equal(msgs.length, 1);
    assert.equal(decryptFrom(b, a, { ...msgs[0], ciphertext: msgs[0].content }), 'first contact');         // still E2EE after accept
    assert.equal((await b.post(`/rooms/${acc.body.room_id}/messages`, await encryptFor(b, [a], 'hi back'))).status, 201);
    assert.equal((await a.post(`/rooms/${acc.body.room_id}/messages`, await encryptFor(a, [b], 'thanks'))).status, 201);
    // the request itself no longer holds a copy and is gone from lists
    assert.equal((await b.get('/message-requests')).body.requests.length, 0);
    const detail = (await a.get(`/message-requests/${req.id}`)).body.request;
    assert.equal(detail.ciphertext, null); assert.equal(detail.status, 'accepted');
    wsA.close();
  } finally { await s.stop(); }
});

test('ignore: hidden, sender not notified and still sees "pending", no DM; later accept still works', async () => {
  const { s, users: [a, b] } = await setup(2);
  try {
    const wsA = await openWs(s.base, a.token);
    const req = (await a.post('/message-requests', await requestBody(a, b, 'ignore me'))).body.request;
    assert.equal((await b.post(`/message-requests/${req.id}/ignore`)).status, 200);
    await sleep(300);
    assert.equal(wsA.msgs.filter(m => String(m.type).startsWith('message_request_updated')).length, 0);     // sender not told
    assert.equal((await b.get('/message-requests')).body.requests.length, 0);
    assert.equal((await b.get('/message-requests?box=ignored')).body.requests.length, 1);
    assert.equal((await a.get(`/message-requests/${req.id}`)).body.request.status, 'pending');             // indistinguishable for the sender
    assert.deepEqual(await dmIds(a), []); assert.deepEqual(await dmIds(b), []);
    // ignoring does not let the sender send another
    assert.equal((await a.post('/message-requests', await requestBody(a, b, 'again'))).status, 409);
    assert.equal((await b.post(`/message-requests/${req.id}/accept`)).status, 200);
    wsA.close();
  } finally { await s.stop(); }
});

test('deny: ends it, payload erased, no DM, sender told only "declined", cooldown prevents re-sending', async () => {
  const { s, users: [a, b] } = await setup(2);
  try {
    const wsA = await openWs(s.base, a.token);
    const req = (await a.post('/message-requests', await requestBody(a, b, 'deny me'))).body.request;
    assert.equal((await b.post(`/message-requests/${req.id}/deny`)).status, 200);
    const ev = await wsA.waitFor(m => m.type === 'message_request_updated');
    assert.equal(ev.status, 'declined'); assert.equal(Object.keys(ev).sort().join(), 'request_id,status,type');
    assert.deepEqual(await dmIds(a), []); assert.deepEqual(await dmIds(b), []);
    assert.equal((await b.post(`/message-requests/${req.id}/accept`)).status, 404);                         // cannot be revived
    const detail = (await a.get(`/message-requests/${req.id}`)).body.request;
    assert.equal(detail.ciphertext, null); assert.equal(detail.status, 'declined');
    const retry = await a.post('/message-requests', await requestBody(a, b, 'please?'));
    assert.equal(retry.status, 403); assert.equal(retry.body.code, 'UNAVAILABLE');                          // no hint it was a denial
    wsA.close();
  } finally { await s.stop(); }
});

test('cancel by sender; request manipulation by anyone else is impossible', async () => {
  const { s, users: [a, b, c] } = await setup();
  try {
    const wsB = await openWs(s.base, b.token);
    const wsC = await openWs(s.base, c.token);
    const req = (await a.post('/message-requests', await requestBody(a, b, 'secret'))).body.request;
    // a third user sees and can do nothing with it
    assert.equal((await c.get(`/message-requests/${req.id}`)).status, 404);
    for (const act of ['accept', 'ignore', 'deny']) assert.equal((await c.post(`/message-requests/${req.id}/${act}`)).status, 404);
    assert.equal((await c.del(`/message-requests/${req.id}`)).status, 404);
    // the sender cannot accept/deny their own request; the recipient cannot "cancel" it
    for (const act of ['accept', 'ignore', 'deny']) assert.equal((await a.post(`/message-requests/${req.id}/${act}`)).status, 404);
    assert.equal((await b.del(`/message-requests/${req.id}`)).status, 404);
    assert.equal(wsC.msgs.filter(m => String(m.type).startsWith('message_request')).length, 0);             // never broadcast to unrelated users
    assert.equal((await a.del(`/message-requests/${req.id}`)).status, 200);
    await wsB.waitFor(m => m.type === 'message_request_updated' && m.status === 'cancelled');
    assert.equal((await b.get('/message-requests')).body.requests.length, 0);
    assert.equal((await a.post('/message-requests', await requestBody(a, b, 'new one'))).status, 201);      // allowed again after a cancel
    wsB.close(); wsC.close();
  } finally { await s.stop(); }
});

test('request validation: friends, existing DMs, self, blocked, plaintext, wrong envelopes, stale keys', async () => {
  const { s, users: [a, b, c, d] } = await setup(4);
  try {
    // friends are redirected to the normal DM
    await befriend(a, b);
    const dm = (await a.post('/rooms/dm', { target_user_id: b.id })).body.room_id;
    const f = await a.post('/message-requests', await requestBody(a, b, 'x'));
    assert.equal(f.status, 409); assert.equal(f.body.code, 'ALREADY_FRIENDS'); assert.equal(f.body.room_id, dm);
    // an existing DM that outlived the friendship is reused
    await a.del('/friends/' + b.id);
    assert.equal((await a.post('/message-requests', await requestBody(a, b, 'x'))).body.code, 'DM_EXISTS');
    assert.equal((await a.post('/message-requests', await requestBody(a, a, 'x'))).status, 400);
    // blocked either way
    await c.post(`/friends/block/${a.id}`);
    assert.equal((await a.post('/message-requests', await requestBody(a, c, 'x'))).status, 403);
    assert.equal((await c.post('/message-requests', await requestBody(c, a, 'x'))).status, 403);
    // plaintext / malformed / third-party envelopes / stale keys are all refused
    const good = await requestBody(a, d, 'x');
    assert.equal((await a.post('/message-requests', { recipient_id: d.id, content: 'plain text' })).status, 400);
    assert.equal((await a.post('/message-requests', { ...good, ciphertext: 'not base64 !!' })).status, 400);
    const withThird = await encryptFor(a, [d, c], 'x');
    assert.equal((await a.post('/message-requests', { recipient_id: d.id, ...withThird, sender_public_key: a.keys.pub, recipient_public_key: d.keys.pub })).status, 400);
    const noSelfKey = { ...good, key_envelopes: { [d.id]: good.key_envelopes[d.id] } };
    assert.equal((await a.post('/message-requests', noSelfKey)).status, 400);
    assert.equal((await a.post('/message-requests', { ...good, recipient_public_key: c.keys.pub })).body.code, 'KEY_MISMATCH');
    assert.equal((await a.post('/message-requests', good)).status, 201);
  } finally { await s.stop(); }
});

test('blocking removes open requests and erases their payload', async () => {
  const { s, users: [a, b] } = await setup(2);
  try {
    const req = (await a.post('/message-requests', await requestBody(a, b, 'before block'))).body.request;
    assert.equal((await b.post(`/friends/block/${a.id}`)).status, 200);
    assert.equal((await b.get('/message-requests')).body.requests.length, 0);
    assert.equal((await b.post(`/message-requests/${req.id}/accept`)).status, 404);
    assert.equal((await a.get(`/message-requests/${req.id}`)).body.request.ciphertext, null);
  } finally { await s.stop(); }
});

test('new 1:1 DMs are friends-only, existing DMs stay reachable, groups keep working with encrypted messages', async () => {
  const { s, users: [a, b, c] } = await setup();
  try {
    assert.equal((await a.post('/rooms/dm', { target_user_id: b.id })).status, 403);
    await befriend(a, b);
    const first = (await a.post('/rooms/dm', { target_user_id: b.id })).body.room_id;
    assert.equal((await b.post('/rooms/dm', { target_user_id: a.id })).body.room_id, first);                // no duplicate
    await a.del('/friends/' + b.id);
    assert.equal((await a.post('/rooms/dm', { target_user_id: b.id })).body.room_id, first);                // still reachable
    // groups between friends still work, with encrypted messages
    await befriend(a, c); await befriend(b, c);
    const g = await a.post('/groups', { name: 'trio', member_ids: [b.id, c.id] });
    assert.ok(g.status < 300, JSON.stringify(g.body));
    const gid = g.body.group?.id || g.body.room_id || g.body.id;
    assert.ok(gid, JSON.stringify(g.body));
    assert.equal((await a.post(`/rooms/${gid}/messages`, await encryptFor(a, [b, c], 'group hi'))).status, 201);
    assert.equal((await a.post(`/rooms/${gid}/messages`, { content: 'plain group' })).status, 400);
  } finally { await s.stop(); }
});

test('request state survives a server restart', async () => {
  const { s, users: [a, b] } = await setup(2);
  const dir = s.dir;
  const req = (await a.post('/message-requests', await requestBody(a, b, 'persist me'))).body.request;
  const req2 = (await a.post('/friends/request', { username: b.username })).body;
  assert.ok(req2.ok);
  await s.stop();
  const s2 = await startServer({ dataDir: dir });
  try {
    // same JWT secret is random per boot, so log in again
    const login = async u => (await fetch(s2.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.username, password: 'correct-horse-battery' }) })).json();
    const b2 = client(s2.base, (await login(b)).token);
    const list = (await b2.get('/message-requests')).body.requests;
    assert.equal(list.length, 1); assert.equal(list[0].id, req.id);
    assert.equal(decryptFrom(b, a, list[0]), 'persist me');
    assert.equal((await b2.get('/friends/requests')).body.incoming.length, 1);
    assert.equal((await b2.post(`/message-requests/${req.id}/ignore`)).status, 200);
  } finally { await s2.stop(); }
});
