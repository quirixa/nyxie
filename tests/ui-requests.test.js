// 0.12.0: the REAL dashboard (public/index.html + public/js/*.js in jsdom) against a live server:
// Add Friend, profile messaging as a Message Request, the Message Requests view, Accept, and the
// sidebar search. jsdom simulates the DOM only — it does not do layout, CSS or mobile viewports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, requestInterceptor, VirtualConsole } = require('jsdom');
const { startServer, registerUser, ensureKeys, befriend, encryptFor } = require('./helpers');
const nacl = require('tweetnacl');

const NM = path.join(__dirname, '..', 'node_modules');
let s;
const U = {};

async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting: ' + fn.toString().slice(0, 140));
    await new Promise(r => setTimeout(r, 40));
  }
}

// The page loads tweetnacl / qrcode / jsqr from a CDN; serve local copies (or
// empty stubs for the QR libraries, which the flows under test never use).
const js = body => new Response(body, { headers: { 'Content-Type': 'application/javascript' } });
const loader = {
  interceptors: [requestInterceptor(request => {
    const url = request.url;
    if (/tweetnacl-util@/.test(url)) return js(fs.readFileSync(path.join(NM, 'tweetnacl-util', 'nacl-util.min.js')));
    if (/tweetnacl@/.test(url)) return js(fs.readFileSync(path.join(NM, 'tweetnacl', 'nacl-fast.min.js')));
    if (/cdn\.jsdelivr\.net|cdnjs|fonts\.g/.test(url)) return js('');
    return undefined; // everything else (the app's own files) loads from the live server
  })]
};

async function openApp(user) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e.detail && e.detail.message || e.message)));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  const dom = await JSDOM.fromURL(s.base + '/app', {
    runScripts: 'dangerously', resources: loader, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.localStorage.setItem('nyxie_token', user.token);
      w.localStorage.setItem('nyxie_private_key_' + user.id, user.keys.priv);
      w.localStorage.setItem('nyxie_public_key_' + user.id, user.keys.pub);
      w.localStorage.setItem('nyxie_user', JSON.stringify({ id: user.id, username: user.username, display_name: user.username }));
      w.fetch = (u, o) => fetch(new URL(u, s.base), o);   // jsdom has no fetch; browsers do
      w.matchMedia = w.matchMedia || (q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
      for (const k of ['IntersectionObserver', 'ResizeObserver', 'MutationObserver']) if (!w[k]) w[k] = class { observe() {} unobserve() {} disconnect() {} };
      w.Element.prototype.scrollIntoView = function () {};
      w.HTMLElement.prototype.scrollTo = function () {};
      w.scrollTo = () => {};
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.HTMLMediaElement.prototype.pause = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null;
      w.Notification = w.Notification || class { static get permission() { return 'denied'; } static requestPermission() { return Promise.resolve('denied'); } };
      w.addEventListener('error', e => errors.push(e.message));
      w.addEventListener('unhandledrejection', e => errors.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
    }
  });
  const w = dom.window, doc = w.document;
  return {
    w, doc, errors, dom,
    $: sel => doc.querySelector(sel), $$: sel => [...doc.querySelectorAll(sel)],
    click: el => (typeof el === 'string' ? doc.querySelector(el) : el).dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    // jsdom only wires inline on* attributes for elements whose attribute was set after creation, not for
    // static markup cloned out of a <template> (real browsers do wire those). For such buttons, run the
    // button's own onclick code — the exact function the browser would call.
    clickInline(sel) {
      const el = doc.querySelector(sel);
      if (typeof el.onclick === 'function') return el.click();
      new w.Function('event', el.getAttribute('onclick')).call(el, new w.MouseEvent('click'));
    },
    close: () => w.close()
  };
}

const notDefinedErrors = ui => ui.errors.filter(e => /is not defined|is not a function/.test(e));
const settle = (ms = 150) => new Promise(r => setTimeout(r, ms));
async function openReady(user) {
  const ui = await openApp(user);
  await until(() => ui.w.eval('typeof currentUser !== "undefined" && !!currentUser') && ui.$('#up-name') && ui.$('#up-name').textContent.trim() !== '');
  await settle();
  return ui;
}
test.before(async () => {
  s = await startServer();
  for (const n of ['alice', 'bob', 'carol', 'dave']) { U[n] = await registerUser(s.base, 'ui' + n); await ensureKeys(U[n]); }
  await befriend(U.carol, U.dave);          // a friend for the new-message modal
});
test.after(async () => { if (s) await s.stop(); });

test('Add Friend view: validation, success, pending and already-friends feedback, 120-character counter', async () => {
  const ui = await openReady(U.carol);
  try {
    await ui.w.openAddFriend();
    await until(() => ui.$('#add-friend-view').style.display === 'block');
    assert.equal(ui.$('#friends-list').style.display, 'none');
    const send = async (name, note = '') => {
      ui.$('#add-friend-input').value = name; ui.$('#add-friend-note').value = note; ui.w.updateFriendNoteCount();
      await ui.w.sendFriendRequest(); await settle(50);
      return [ui.$('#add-friend-status').className, ui.$('#add-friend-status').textContent];
    };
    ui.$('#add-friend-note').value = 'héllo'; ui.w.updateFriendNoteCount();
    assert.equal(ui.$('#add-friend-note-count').textContent, '5/120');
    let [cls, txt] = await send('');                         assert.match(cls, /error/);   assert.match(txt, /Enter a username/);
    [cls, txt] = await send(U.carol.username);               assert.match(cls, /error/);   assert.match(txt, /yourself/);
    [cls, txt] = await send('definitely-not-a-user');        assert.match(cls, /error/);   assert.match(txt, /No user/);
    [cls, txt] = await send('@' + U.alice.username, 'hi, Carol here');
    assert.match(cls, /success/); assert.match(txt, /Friend request sent/);
    assert.equal(ui.$('#add-friend-input').value, '');       // form reset after success
    [cls, txt] = await send(U.alice.username);               assert.match(cls, /pending/); assert.match(txt, /already sent/);
    [cls, txt] = await send(U.dave.username);                assert.match(cls, /pending/); assert.match(txt, /already friends/);
    assert.equal((await U.alice.get('/friends/requests')).body.incoming[0].message, 'hi, Carol here');
    assert.match(ui.$('#add-friend-view').textContent, /Discoverable Servers/);
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('new-message modal lists friends only and never offers a stranger', async () => {
  const ui = await openReady(U.carol);
  try {
    await ui.w.showNewDmModal();
    await until(() => ui.$$('#dm-search-results .search-result-item').length === 1);
    assert.match(ui.$('#dm-search-results').textContent, new RegExp(U.dave.username));
    ui.w.searchUsers(U.alice.username);                      // a non-friend, typed exactly
    assert.equal(ui.$$('#dm-search-results .search-result-item').length, 0);
    assert.match(ui.$('#dm-search-results').textContent, /No friends match/);
  } finally { ui.close(); }
});

test('profile message to a non-friend becomes a request: Bob sees it live (badge, decrypted preview), nothing is a DM until Accept', async () => {
  const bob = await openReady(U.bob);
  const alice = await openReady(U.alice);
  try {
    await alice.w.showUserProfile({ stopPropagation() {}, currentTarget: alice.$('#up-name') }, U.bob.id);
    await until(() => alice.$('#user-profile-popout').style.display !== 'none' && /request/i.test(alice.$('#up-message-input').placeholder));
    assert.match(alice.$('#up-message-hint').textContent, /message request/i);
    alice.$('#up-message-input').value = 'Hi Bob, we share a server';
    alice.w.sendMessageFromProfile(); alice.w.sendMessageFromProfile();      // a double submit must not send twice
    await until(async () => (await U.bob.get('/message-requests')).body.requests.length === 1);
    await settle(200);
    assert.equal((await U.bob.get('/message-requests')).body.requests.length, 1);
    assert.equal(alice.$('#up-message-input').value, '');                     // composer cleared
    assert.equal(alice.$$('#dm-list .dm-item').length, 0);                    // no conversation created for the sender
    // reopening the profile shows the request is waiting and blocks repeat submissions
    await alice.w.showUserProfile({ stopPropagation() {}, currentTarget: alice.$('#up-name') }, U.bob.id);
    await until(() => alice.$('#up-message-input').disabled);
    assert.match(alice.$('#up-message-hint').textContent, /Waiting for/);
    // Bob, live
    await until(() => bob.$('#inbox-badge').style.display !== 'none');
    assert.equal(bob.$('#inbox-badge').textContent, '1');
    assert.equal(bob.$$('#dm-list .dm-item').length, 0);                      // never an ordinary DM entry
    bob.w.navigateTo('requests');
    await until(() => bob.$$('#requests-list .req-card').length === 1);
    const card = bob.$('#requests-list .req-card');
    assert.match(card.textContent, /Hi Bob, we share a server/);              // decrypted locally
    assert.match(card.textContent, new RegExp('@' + U.alice.username));
    for (const b of ['Accept', 'Ignore', 'Deny']) assert.ok([...card.querySelectorAll('button')].some(x => x.textContent.trim() === b), b);
    // Deny needs a second click
    const deny = card.querySelector('[data-deny]'); deny.click();
    assert.equal(deny.textContent, 'Confirm deny');
    // Accept → a real DM appears, badge clears, chat opens
    bob.w.acceptMessageRequest(card.dataset.requestId);
    await until(() => bob.$$('#dm-list .dm-item').length === 1 && bob.$('#chat-view').style.display !== 'none');
    assert.equal(bob.$('#inbox-badge').style.display, 'none');
    await until(() => alice.$$('#dm-list .dm-item').length === 1);            // the sender is notified and gets the DM too
    assert.deepEqual(notDefinedErrors(bob), []); assert.deepEqual(notDefinedErrors(alice), []);
  } finally { bob.close(); alice.close(); }
});

test('sidebar search filters existing conversations only and never creates one', async () => {
  const ui = await openReady(U.bob);
  try {
    await until(() => ui.$$('#dm-list .dm-item').length === 1);
    const before = (await U.bob.get('/rooms')).body.rooms.length;
    const input = ui.$('#search-input');
    input.value = U.alice.username.slice(0, 6); input.dispatchEvent(new ui.w.Event('input', { bubbles: true }));
    ui.w.filterSidebar(input.value);
    assert.equal(ui.$$('#dm-list .dm-item').filter(e => e.style.display !== 'none').length, 1);
    ui.w.filterSidebar(U.dave.username);                                      // a real user with no conversation with Bob
    assert.equal(ui.$$('#dm-list .dm-item').filter(e => e.style.display !== 'none').length, 0);
    assert.match(ui.$('#dm-list').textContent, /No matching conversations/);
    await settle(200);
    assert.equal((await U.bob.get('/rooms')).body.rooms.length, before);      // nothing was created
    assert.equal((await U.dave.get('/message-requests?box=outgoing')).body.requests.length, 0);
  } finally { ui.close(); }
});
