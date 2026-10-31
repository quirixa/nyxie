// 0.11.0: view isolation in the REAL dashboard (public/index.html + public/js/*.js
// inside jsdom, against a live server). Exactly one main-area view may be visible at
// a time; leaving Developer must hide and tear down the whole workspace; returning
// must rebuild it exactly once; browser back/forward and repeated switching must not
// leak views, listeners or timers. jsdom = DOM simulation: no layout or CSS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { JSDOM, requestInterceptor, VirtualConsole } = require('jsdom');
const { startServer, registerUser, client } = require('./helpers');
const nacl = require('tweetnacl');

// Accounts created through the REST API have no encryption keys yet, so the
// app would stop at its "back up your encryption key" password prompt (correct
// behaviour for a keyless account). Give each test user the key material a
// normally-registered user has: a local key pair plus the public key and a
// wrapped private key on the server.
async function giveKeys(user) {
  const kp = nacl.box.keyPair();
  const b64 = u8 => Buffer.from(u8).toString('base64');
  user.keys = { priv: b64(kp.secretKey), pub: b64(kp.publicKey) };
  const r = await user.patch('/users/me', { public_key: user.keys.pub, encrypted_private_key: b64(nacl.randomBytes(48)), key_salt: b64(nacl.randomBytes(16)), key_nonce: b64(nacl.randomBytes(24)) });
  assert.ok(r.status < 300, 'could not store test keys: ' + JSON.stringify(r.body));
}

const NM = path.join(__dirname, '..', 'node_modules');
let s;
const U = {};
const DM = {}, SRV = {};

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


const PW = 'correct-horse-battery';
async function login(username) {
  const res = await fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
  const b = await res.json();
  const c = client(s.base, b.token); c.id = b.user.id; c.username = username;
  return c;
}
async function setAdmin(dir, id) {
  const SQL = await initSqlJs();
  const file = path.join(dir, 'nyxie_users.db');
  const db = new SQL.Database(fs.readFileSync(file));
  db.run("UPDATE users SET role = 'ADMIN' WHERE id = ?", [id]);
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
}

test.before(async () => {
  s = await startServer();
  for (const n of ['uiadmin', 'uidev', 'uiuser', 'uirep']) U[n] = await registerUser(s.base, n);
  const dir = s.dir;
  await s.stop();
  await setAdmin(dir, U.uiadmin.id);
  s = await startServer({ dataDir: dir });
  for (const n of Object.keys(U)) U[n] = await login(U[n].username);
  assert.equal((await U.uiadmin.post(`/admin/badges/users/${U.uidev.id}/badges`, { badge_id: 'developer' })).status, 201);
  for (const n of Object.keys(U)) await giveKeys(U[n]);
  // The Overview only draws its statistic cards when reports exist (an empty database shows
  // "No reports yet."), so seed a few. A developer cannot see SECURITY reports, so these are 3 visible ones.
  for (const [title, category] of [['Crash when opening settings', 'BUG'], ['Please add dark mode scheduling', 'FEATURE'], ['General thoughts about Nyxie', 'GENERAL']]) {
    assert.equal((await U.uirep.post('/reports', { title, description: 'It does not work the way I expect it to.', category })).status, 201);
  }
  // A DM for the developer and for the admin, and a server (with its default channel) the developer owns.
  DM.dev = (await U.uidev.post('/rooms/dm', { target_user_id: U.uiuser.id })).body.room_id;
  DM.admin = (await U.uiadmin.post('/rooms/dm', { target_user_id: U.uiuser.id })).body.room_id;
  const sv = await U.uidev.post('/servers', { name: 'Nav Server' });
  SRV.id = sv.body.server.id; SRV.channel = sv.body.default_channel_id;
});
test.after(async () => { if (s) await s.stop(); });

// Opens the app and waits until the dashboard has finished initialising for this user.
async function openReady(user) {
  const ui = await openApp(user);
  await until(() => ui.w.eval('typeof currentUser !== "undefined" && !!currentUser && !!currentUser.role') && ui.$('#up-name') && ui.$('#up-name').textContent.trim() !== '');
  await new Promise(r => setTimeout(r, 150));
  return ui;
}

const PANELS = ['welcome-view', 'friends-panel', 'wallet-panel', 'marketplace-panel', 'admin-panel', 'developer-panel', 'discover-panel', 'notifications-panel', 'chat-view'];
const visible = ui => PANELS.filter(id => ui.$('#' + id) && ui.$('#' + id).style.display !== 'none');
const settle = (ms = 150) => new Promise(r => setTimeout(r, ms));

// Counts add/removeEventListener calls made on the Developer panel, to prove nothing is attached twice
// and everything that was attached is detached again.
function spyListeners(ui) {
  ui.w.eval(`(function () {
    const T = window.EventTarget.prototype, add = T.addEventListener, rem = T.removeEventListener;
    window.__lst = { added: 0, removed: 0, live: new Set() };
    T.addEventListener = function (type, fn, o) { if (this.id === 'developer-panel') { window.__lst.added++; window.__lst.live.add(type + ':' + (fn.name || 'anon')); } return add.call(this, type, fn, o); };
    T.removeEventListener = function (type, fn, o) { if (this.id === 'developer-panel') window.__lst.removed++; return rem.call(this, type, fn, o); };
  })()`);
}
const openDev = async ui => {
  ui.clickInline('#nav-developer');
  await until(() => visible(ui).join() === 'developer-panel' && ui.$$('#dev-body .dev-card').length > 0);
};
const assertDevGone = ui => {
  assert.deepEqual(visible(ui).includes('developer-panel'), false, 'Developer panel hidden');
  assert.equal(ui.$$('#dev-view').length, 0, 'no Developer markup left behind');
  assert.equal(ui.$$('#dev-tabs, #dev-toolbar, #dev-body, .dev-card').length, 0, 'no Developer tabs, toolbar or statistics in the DOM');
  assert.ok(!ui.$('#nav-developer').classList.contains('active'), 'Developer nav item is no longer active');
};

test('Developer → DM: only the DM is visible and the whole Developer workspace is gone', async () => {
  const ui = await openReady(U.uidev);
  try {
    await until(() => ui.$(`[data-room-id="${DM.dev}"]`));
    await openDev(ui);
    assert.match(ui.$('#developer-panel').textContent, /Overview/);
    ui.w.openRoom(DM.dev);
    await until(() => visible(ui).join() === 'chat-view');
    assert.deepEqual(visible(ui), ['chat-view'], 'exactly one main view');
    assertDevGone(ui);
    assert.equal(ui.$('#chat-room-name-text').textContent.trim(), '@' + U.uiuser.username);
    assert.equal(ui.w.location.pathname, `/app/rooms/${DM.dev}`);
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('DM → Developer: the workspace is restored in full and the DM is hidden', async () => {
  const ui = await openReady(U.uidev);
  try {
    await until(() => ui.$(`[data-room-id="${DM.dev}"]`));
    ui.w.openRoom(DM.dev);
    await until(() => visible(ui).join() === 'chat-view');
    await openDev(ui);
    assert.deepEqual(visible(ui), ['developer-panel']);
    assert.equal(ui.$$('#dev-view').length, 1);
    assert.equal(ui.$$('#dev-tabs .dev-tab').length, 5, 'every tab is back');
    assert.equal(ui.$$('#dev-body .dev-card').length, 6, 'report statistics are back');
    assert.ok(ui.$('#nav-developer').classList.contains('active'));
    assert.equal(ui.w.location.pathname, '/developer');
    assert.equal(ui.$('#chat-view').style.display, 'none');
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('Developer → Home, Friends, Marketplace, Wallet: each leaves exactly one view', async () => {
  const ui = await openReady(U.uidev);
  try {
    const targets = [['home', 'welcome-view'], ['friends', 'friends-panel'], ['marketplace', 'marketplace-panel'], ['wallet', 'wallet-panel']];
    for (const [section, panel] of targets) {
      await openDev(ui);
      ui.w.navigateTo(section);
      await until(() => visible(ui).join() === panel);
      assert.deepEqual(visible(ui), [panel], `Developer → ${section}`);
      assertDevGone(ui);
    }
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('Developer → Admin: only Admin is visible (administrator)', async () => {
  const ui = await openReady(U.uiadmin);
  try {
    await openDev(ui);
    ui.clickInline('#nav-admin');
    await until(() => visible(ui).join() === 'admin-panel');
    assert.deepEqual(visible(ui), ['admin-panel']);
    assertDevGone(ui);
    assert.equal(ui.w.location.pathname, '/admin/disputes');
    // and back again
    await openDev(ui);
    assert.equal(ui.$('#admin-panel').style.display, 'none');
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('Developer → server → DM: no Developer or server-less view bleeds through', async () => {
  const ui = await openReady(U.uidev);
  try {
    await until(() => ui.$(`[data-room-id="${DM.dev}"]`) && ui.$$('#server-rail-list [onclick*="selectServer"]').length >= 1);
    await openDev(ui);
    ui.w.selectServer(SRV.id);
    await until(() => ui.$$('#channel-list .channel-item').length === 1);
    await until(() => visible(ui).join() === 'chat-view');   // selectServer() opens the first channel itself
    assert.deepEqual(visible(ui), ['chat-view'], 'the channel is the only main view: no Developer, Home or other panel');
    assertDevGone(ui);
    ui.w.openChannel(SRV.channel);
    await until(() => visible(ui).join() === 'chat-view');
    assert.equal(ui.$('#chat-room-name-text').textContent.trim(), '# general');
    assertDevGone(ui);
    ui.w.showDMView();
    await until(() => visible(ui).join() === 'welcome-view');
    ui.w.openRoom(DM.dev);
    await until(() => visible(ui).join() === 'chat-view');
    assert.deepEqual(visible(ui), ['chat-view']);
    assert.equal(ui.$('#chat-room-name-text').textContent.trim(), '@' + U.uiuser.username);
    assertDevGone(ui);
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('Developer → Discover → DM: every other main view is also isolated', async () => {
  const ui = await openReady(U.uidev);
  try {
    await until(() => ui.$(`[data-room-id="${DM.dev}"]`));
    await openDev(ui);
    ui.w.showDiscoverView();
    await until(() => visible(ui).join() === 'discover-panel');
    assertDevGone(ui);
    ui.w.showDMView();
    await until(() => visible(ui).join() === 'welcome-view');
    ui.w.navigateTo('friends');
    await until(() => visible(ui).join() === 'friends-panel');
    ui.w.openRoom(DM.dev);
    await until(() => visible(ui).join() === 'chat-view');
    assert.deepEqual(visible(ui), ['chat-view']);
  } finally { ui.close(); }
});

test('repeated Developer ↔ DM switching: one view at a time, no duplicate DOM, no duplicate or leaked listeners', async () => {
  const ui = await openReady(U.uidev);
  try {
    await until(() => ui.$(`[data-room-id="${DM.dev}"]`));
    spyListeners(ui);
    const ROUNDS = 8;
    for (let i = 0; i < ROUNDS; i++) {
      await openDev(ui);
      assert.deepEqual(visible(ui), ['developer-panel'], `round ${i}: Developer`);
      assert.equal(ui.$$('#dev-view').length, 1, `round ${i}: Developer markup exists once`);
      assert.equal(ui.$$('#dev-tabs').length, 1);
      ui.w.openRoom(DM.dev);
      await until(() => visible(ui).join() === 'chat-view');
      assertDevGone(ui);
      assert.equal(ui.$('#chat-room-name-text').textContent.trim(), '@' + U.uiuser.username, `round ${i}: DM state intact`);
    }
    const l = ui.w.__lst;
    assert.equal(l.added, ROUNDS * 4, 'four listeners attached per visit, never more');
    assert.equal(l.removed, ROUNDS * 4, 'every one of them detached on leaving');
    // double-clicking the Developer item must not stack a second copy either
    ui.clickInline('#nav-developer'); ui.clickInline('#nav-developer');
    await until(() => ui.$$('#dev-body .dev-card').length > 0);
    await settle();
    assert.equal(ui.$$('#dev-view').length, 1);
    assert.equal(ui.w.__lst.added - ui.w.__lst.removed, 4, 'exactly one live set of listeners');
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('leaving Developer cancels pending work: a debounced search or slow load cannot repaint a hidden/rebuilt panel', async () => {
  const ui = await openReady(U.uidev);
  try {
    await until(() => ui.$(`[data-room-id="${DM.dev}"]`));
    await openDev(ui);
    ui.click(ui.$$('#dev-tabs .dev-tab').find(t => /All Reports/.test(t.textContent)));
    await until(() => ui.$('#dev-search'));
    const search = ui.$('#dev-search');
    search.value = 'abc';
    search.dispatchEvent(new ui.w.Event('input', { bubbles: true }));   // arms the 250ms debounce timer
    ui.w.openRoom(DM.dev);                                              // leave before it fires
    await settle(450);
    assertDevGone(ui);
    assert.deepEqual(visible(ui), ['chat-view']);
    assert.equal(ui.errors.filter(e => /Cannot read prop|TypeError|unhandledrejection/.test(e)).length, 0, 'no late callbacks hit a missing panel: ' + ui.errors.join(' | '));
  } finally { ui.close(); }
});

test('browser back/forward between Developer and a DM restores the right view each time', async () => {
  const ui = await openReady(U.uidev);
  try {
    await until(() => ui.$(`[data-room-id="${DM.dev}"]`));
    await openDev(ui);                                   // /developer (replaces /app)
    ui.w.openRoom(DM.dev);                               // pushes /app/rooms/<id>
    await until(() => visible(ui).join() === 'chat-view');
    for (let i = 0; i < 3; i++) {
      ui.w.history.back();
      await until(() => ui.w.location.pathname === '/developer' && visible(ui).join() === 'developer-panel' && ui.$$('#dev-body .dev-card').length > 0, 8000);
      assert.equal(ui.$$('#dev-view').length, 1, `back #${i}: workspace rebuilt into the new panel exactly once`);
      assert.equal(ui.$$('#dev-tabs .dev-tab').length, 5);
      ui.w.history.forward();
      await until(() => ui.w.location.pathname === `/app/rooms/${DM.dev}` && visible(ui).join() === 'chat-view', 8000);
      assertDevGone(ui);
    }
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('access is unchanged: a regular user can never reveal the workspace through any switch, and an admin can still open it', async () => {
  const ui = await openReady(U.uiuser);
  try {
    await until(() => ui.$(`[data-room-id="${DM.dev}"]`));
    ui.w.navigateTo('developer');
    await settle(250);
    assert.equal(ui.$('#developer-panel').innerHTML.trim(), '');
    assert.ok(!visible(ui).includes('developer-panel'));
    ui.w.openRoom(DM.dev);
    await until(() => visible(ui).join() === 'chat-view');
    assert.deepEqual(visible(ui), ['chat-view']);
    assert.equal((await U.uiuser.get('/developer/overview')).status, 403);
  } finally { ui.close(); }
  const adm = await openReady(U.uiadmin);
  try {
    await openDev(adm);
    assert.deepEqual(visible(adm), ['developer-panel']);
  } finally { adm.close(); }
});
