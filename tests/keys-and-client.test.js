// 0.12.0: key substitution/rotation (server) and the client-side logic that
// protects against it, plus DM-search / profile-messaging / UI structure.
// Client functions are extracted from the real public/js/dashboard.js source
// and executed — nothing here re-implements them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { startServer, registerUser, openWs, ensureKeys, befriend, nacl, b64, unb64, ROOT } = require('./helpers');

const JS = fs.readFileSync(path.join(ROOT, 'public/js/dashboard.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
function fnSource(name) {
  const m = new RegExp('\\n  (async )?function ' + name + '\\(').exec(JS);
  assert.ok(m, 'function ' + name + ' not found');
  let i = JS.indexOf('{', JS.indexOf(')', m.index)), d = 0, j = i;
  for (;; j++) { if (JS[j] === '{') d++; else if (JS[j] === '}' && --d === 0) break; }
  return JS.slice(m.index, j + 1);
}

test('key substitution is blocked: no silent key swap, rotation needs the password, history is recorded, peers are told', async () => {
  const s = await startServer();
  try {
    const a = await registerUser(s.base, 'ka'), b = await registerUser(s.base, 'kb'), mallory = await registerUser(s.base, 'km');
    await ensureKeys(a); await ensureKeys(b);
    await befriend(a, b);
    const evil = b64(nacl.box.keyPair().publicKey);
    // a stolen session / the server API cannot swap an existing key through the profile endpoint
    const swap = await a.patch('/users/me', { public_key: evil });
    assert.equal(swap.status, 409); assert.equal(swap.body.code, 'KEY_CHANGE_USE_ROTATE');
    assert.equal((await a.patch('/users/me', { public_key: 'AAAA' })).status, 400);                       // not a 32-byte key
    assert.equal((await b.get(`/keys/${a.id}`)).body.public_key, a.keys.pub);
    // rotation needs the account password
    const kp = nacl.box.keyPair();
    const body = { new_public_key: b64(kp.publicKey), encrypted_private_key: b64(nacl.randomBytes(48)), key_salt: b64(nacl.randomBytes(16)), key_nonce: b64(nacl.randomBytes(24)) };
    assert.equal((await a.post('/keys/rotate', { ...body, current_password: 'wrong-password' })).status, 401);
    assert.equal((await a.post('/keys/rotate', body)).status, 401);
    assert.equal((await mallory.post('/keys/rotate', { ...body, current_password: 'correct-horse-battery' })).status, 200); // only ever changes the caller's OWN key
    assert.equal((await a.get(`/keys/${a.id}`)).body.public_key, a.keys.pub);
    const wsB = await openWs(s.base, b.token);
    const ok = await a.post('/keys/rotate', { ...body, current_password: 'correct-horse-battery' });
    assert.equal(ok.status, 200);
    await wsB.waitFor(m => m.type === 'key_changed' && m.user_id === a.id);                               // contacts are warned
    const k = (await b.get(`/keys/${a.id}`)).body;
    assert.equal(k.public_key, body.new_public_key);
    assert.deepEqual(k.history.map(h => [h.public_key, !!h.retired_at]), [[a.keys.pub, true], [body.new_public_key, false]]);
    // a request built for the retired key is refused rather than silently mis-encrypted
    const stale = await b.post('/message-requests', { recipient_id: mallory.id, ciphertext: 'AAAA', nonce: 'AAAA', key_envelopes: {}, sender_public_key: b.keys.pub, recipient_public_key: a.keys.pub });
    assert.ok(stale.status >= 400);
    wsB.close();
  } finally { await s.stop(); }
});

test('client key pinning: first key is pinned, a changed key blocks encryption until reviewed, safety numbers are symmetric', () => {
  const store = {};
  let prompts = 0;
  const ctx = {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    currentUser: { id: 'me' }, nacl, Uint8Array, Date, JSON, String, Error, Math,
    base64ToUint8Array: s => { try { return unb64(s); } catch { return null; } },
    openKeyVerification: () => { prompts++; }, setTimeout: fn => fn(),
    toast() {}
  };
  const code = ['_readPins', '_writePins', 'keyPinStatus', 'pinKey', 'enforceKeyPin', 'safetyNumber'].map(fnSource).join('\n') + '\nthis.api = { _readPins, keyPinStatus, pinKey, enforceKeyPin, safetyNumber };';
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const { keyPinStatus, pinKey, enforceKeyPin, safetyNumber } = ctx.api;
  const k1 = b64(nacl.box.keyPair().publicKey), k2 = b64(nacl.box.keyPair().publicKey), me = b64(nacl.box.keyPair().publicKey);
  assert.equal(keyPinStatus('bob', k1), 'new');
  enforceKeyPin({ id: 'bob', public_key: k1, display_name: 'Bob' });                    // first sight: pinned, allowed
  assert.equal(keyPinStatus('bob', k1), 'match');
  enforceKeyPin({ id: 'bob', public_key: k1 });                                          // same key: fine
  assert.throws(() => enforceKeyPin({ id: 'bob', public_key: k2, display_name: 'Bob' }), e => e.code === 'KEY_CHANGED');
  assert.equal(prompts, 1, 'the review dialog must open');
  assert.equal(keyPinStatus('bob', k2), 'changed');
  assert.throws(() => enforceKeyPin({ id: 'bob', public_key: k2 }), e => e.code === 'KEY_CHANGED'); // still blocked until the person confirms
  pinKey('bob', k2, true);                                                               // explicit trust
  assert.equal(keyPinStatus('bob', k2), 'verified');
  const n1 = safetyNumber(me, k1), n2 = safetyNumber(k1, me);
  assert.equal(n1, n2); assert.match(n1, /^(\d{5} ){11}\d{5}$/);
  assert.notEqual(n1, safetyNumber(me, k2));
});

test('#search-inner only filters existing conversations (by name, @username, group) with no API calls', () => {
  assert.ok(/id="search-inner"/.test(HTML) && /id="search-input"/.test(HTML));
  const dom = new JSDOM(`<div id="dm-list">
    <div class="dm-item" data-room-id="r1"><span class="dm-name">Alice Wonder</span></div>
    <div class="dm-item" data-room-id="r2"><span class="dm-name">Bob</span></div>
    <div class="dm-item" data-room-id="r3"><span class="dm-name">Study group</span></div></div>`);
  let apiCalls = 0;
  const ctx = { document: dom.window.document, dms: [
    { id: 'r1', display_name: 'Alice Wonder', _username: 'alice99' }, { id: 'r2', display_name: 'Bob', _username: 'builder' },
    { id: 'r3', display_name: 'Study group', is_group: 1, name: 'Study group' }],
    api: () => { apiCalls++; }, fetch: () => { apiCalls++; }, String };
  vm.createContext(ctx);
  vm.runInContext(fnSource('filterSidebar') .replace('function filterSidebar', 'let _sidebarQuery = "";\nfunction filterSidebar') + '\n' + fnSource('applySidebarFilter'), ctx);
  const visible = () => [...dom.window.document.querySelectorAll('.dm-item')].filter(e => e.style.display !== 'none').map(e => e.dataset.roomId);
  ctx.filterSidebar('ali'); assert.deepEqual(visible(), ['r1']);
  ctx.filterSidebar('@BUILDER'); assert.deepEqual(visible(), ['r2']);                    // by username, not just display name
  ctx.filterSidebar('study'); assert.deepEqual(visible(), ['r3']);
  ctx.filterSidebar('someone-who-has-no-dm');
  assert.deepEqual(visible(), []);                                                       // an unknown person is not offered as a new DM
  assert.equal(dom.window.document.querySelectorAll('.dm-item').length, 3);              // nothing created
  assert.match(dom.window.document.querySelector('.dm-filter-empty').textContent, /No matching conversations/);
  ctx.filterSidebar(''); assert.deepEqual(visible(), ['r1', 'r2', 'r3']);
  assert.equal(apiCalls, 0);
  assert.ok(!/api\(|fetch\(/.test(fnSource('filterSidebar') + fnSource('applySidebarFilter')));
});

test('new-message modal can no longer start arbitrary 1:1 DMs; group creation is untouched', () => {
  const modal = fnSource('showNewDmModal') + fnSource('searchUsers');
  assert.ok(!/users\/search/.test(modal), 'the new-message modal must not search every user');
  assert.ok(/friends\.filter/.test(fnSource('searchUsers')), 'it lists friends only');
  assert.ok(/function showNewGroupModal|showNewGroup/.test(JS), 'New Group functionality still present');
  assert.ok(/id="new-dm-modal"/.test(HTML));
});

test('profile messaging: non-friends create a Message Request and never a DM; friends keep the normal flow', () => {
  const fn = fnSource('startDMFromProfile');
  const idxRequest = fn.indexOf('sendMessageRequest(userId, text)');
  assert.ok(idxRequest > fn.indexOf('existing || isFriend'), 'request path comes after the friend/existing-DM branch');
  assert.ok(/if \(existing \|\| isFriend\)/.test(fn));
  const sendReq = fnSource('sendMessageRequest');
  assert.ok(sendReq.includes("'/message-requests'") && !sendReq.includes("'/rooms/dm'"), 'a request never touches /rooms/dm');
  assert.ok(/_requestSending/.test(sendReq) && /outgoing\.some/.test(sendReq), 'repeat submissions are prevented');
  assert.ok(/nacl\.secretbox\(/.test(sendReq), 'encrypted on the sender\'s device before sending');
  assert.ok(/input\.value = ''/.test(sendReq) && /toast\(/.test(sendReq), 'composer cleared and confirmation shown');
  // every profile entry point (member list, popouts, message authors) opens the same popout
  const entry = (JS.match(/showUserProfile\(/g) || []).length;
  assert.ok(entry >= 3, 'profile entry points: ' + entry);
  assert.ok(!/startDM\([^)]*\)[^\n]*sendMessageFromProfile|sendMessageFromProfile[^\n]*\/rooms\/dm/.test(JS));
});

test('UI structure: Friends tabs, Add Friend view, requests panel and sidebar entries', () => {
  const dom = new JSDOM(HTML);
  const appRoot = dom.window.document.querySelector('#tpl-app').content;      // the app lives inside a <template>
  const $ = sel => appRoot.querySelector(sel);
  for (const id of ['ftab-online', 'ftab-all', 'ftab-add', 'add-friend-view', 'add-friend-input', 'add-friend-note', 'add-friend-note-count', 'add-friend-send', 'add-friend-status', 'requests-panel', 'nav-requests', 'nav-requests-badge', 'nav-add-friend', 'nav-friends', 'search-inner', 'dm-list']) assert.ok($('#' + id), '#' + id + ' missing');
  assert.equal($('#add-friend-note').getAttribute('maxlength'), '120');
  assert.match($('#add-friend-view').textContent, /Other Places to Make Friends/);
  assert.match($('#add-friend-view').textContent, /Discover Servers/);
  assert.equal($('#add-friend-send').textContent.trim(), 'Send Friend Request');
  for (const t of ['Requests', 'Ignored', 'Sent']) assert.ok([...appRoot.querySelectorAll('#requests-panel .ftab')].some(b => b.textContent.includes(t)));
  // Ignore and Deny are separate actions with separate handlers
  assert.ok(/ignoreMessageRequest/.test(JS) && /denyMessageRequest/.test(JS));
  // pending requests are rendered only in their own panel, never as .dm-item entries
  assert.ok(!/requests?[^\n]{0,80}class="dm-item/.test(JS));
  // mobile: panel registered like the other main views
  assert.ok(/requests: 'requests-panel'/.test(JS));
});
