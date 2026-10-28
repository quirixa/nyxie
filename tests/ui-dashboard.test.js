// End-to-end check of the REAL dashboard: the actual public/index.html and
// all public/js/*.js files run inside jsdom, logged in against a live
// server. Guards the member list / toggle (regression: they were once
// deleted from dashboard.js by mistake), the real-data-only usernames, the
// category-grouped channel list, live updates, and that Server Settings
// opens from the dashboard. jsdom = DOM simulation: no layout or CSS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, requestInterceptor, VirtualConsole } = require('jsdom');
const { startServer, registerUser } = require('./helpers');
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
let s, owner, alice, bob, sid, general;

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

test.before(async () => {
  s = await startServer();
  owner = await registerUser(s.base, 'dashowner'); alice = await registerUser(s.base, 'dashalice'); bob = await registerUser(s.base, 'dashbob');
  const r = await owner.post('/servers', { name: 'Dash Server' });
  sid = r.body.server.id; general = r.body.default_channel_id;
  for (const u of [owner, alice, bob]) await giveKeys(u);
  for (const u of [alice, bob]) { const inv = (await owner.post(`/servers/${sid}/invites`, {})).body.invite.code; await u.post(`/invites/${inv}/join`); }
});
test.after(async () => { if (s) await s.stop(); });

test('dashboard boots without undefined-function errors; opening a channel shows the real member list; toggle works', async () => {
  const ui = await openApp(owner);
  try {
    await until(() => ui.$('#server-rail-list') && ui.$$('#server-rail-list [onclick*="selectServer"]').length >= 1);
    assert.equal(typeof ui.w.toggleMemberList, 'function', 'toggleMemberList is defined');
    assert.equal(typeof ui.w.selectServer, 'function');
    ui.w.selectServer(sid);
    await until(() => ui.$$('#channel-list .channel-item').length === 1);
    ui.w.openChannel(general);
    await until(() => ui.$$('#member-list .ml-row').length === 3);
    const names = ui.$$('#member-list .ml-name').map(e => e.firstChild.textContent.trim()).sort()  // first text node: the crown icon adds a <title>;
    assert.deepEqual(names, [alice.username, bob.username, owner.username].sort(), 'only real usernames from the API');
    assert.ok(!/>@username</.test(ui.doc.body.innerHTML), 'no static placeholder username anywhere in the page');
    assert.equal(ui.$('#chat-room-name-text').textContent.trim(), '# general');
    assert.match(ui.$('#member-list-count').textContent, /3 Members/);
    // the owner is marked as such, and online/offline grouping comes from real presence
    assert.ok(ui.$$('#member-list .ml-row').some(r => r.querySelector('.owner-crown')));
    assert.ok(ui.$$('.ml-group-label').some(l => /Offline/.test(l.textContent)), 'members who are not connected are listed offline');
    // toggle button flips the panel
    const panel = ui.$('#member-list-panel');
    // wide layout (> 1100px): plain show/hide
    const setWidth = n => Object.defineProperty(ui.w, 'innerWidth', { value: n, configurable: true, writable: true });
    setWidth(1400);
    assert.equal(panel.style.display, 'flex', 'opening a server channel shows the member list');
    ui.clickInline('#member-list-toggle-btn');
    assert.equal(panel.style.display, 'none');
    ui.clickInline('#member-list-toggle-btn');
    assert.equal(panel.style.display, 'flex');
    // narrow layout (<= 1100px): floating overlay via the force-open class
    setWidth(900);
    ui.clickInline('#member-list-toggle-btn');
    assert.ok(panel.classList.contains('force-open'));
    ui.clickInline('#member-list-toggle-btn');
    assert.ok(!panel.classList.contains('force-open'));
    assert.equal(panel.style.display, 'none');
    assert.deepEqual(notDefinedErrors(ui), [], 'no "not defined" errors: ' + JSON.stringify(notDefinedErrors(ui)));
  } finally { ui.close(); }
});

test('member list stays in sync live: role change, kick, and rejoin come from the server, not stale state', async () => {
  const ui = await openApp(owner);
  try {
    await until(() => ui.$$('#server-rail-list [onclick*="selectServer"]').length >= 1);
    ui.w.selectServer(sid);
    await until(() => ui.$$('#channel-list .channel-item').length === 1);
    ui.w.openChannel(general);
    await until(() => ui.$$('#member-list .ml-row').length === 3);
    // give bob the Moderator role (display_separately) → he moves under a "Moderator" heading
    const roles = (await owner.get(`/servers/${sid}/roles`)).body.roles;
    await owner.patch(`/servers/${sid}/members/${bob.id}`, { add_role_ids: [roles.find(r => r.name === 'Moderator').id] });
    // bob is offline here, so the role shows in the Offline group's row sub-label
    await until(() => ui.$$('#member-list .ml-row').some(r => /Moderator/.test(r.textContent) && r.textContent.includes(bob.username)));
    // kick alice → row disappears without a reload
    await owner.del(`/servers/${sid}/members/${alice.id}`);
    await until(() => ui.$$('#member-list .ml-row').length === 2);
    assert.ok(!ui.$('#member-list').textContent.includes(alice.username));
    assert.match(ui.$('#member-list-count').textContent, /2 Members/);
    // she rejoins → back again, with only the default role
    const inv = (await owner.post(`/servers/${sid}/invites`, {})).body.invite.code;
    await alice.post(`/invites/${inv}/join`);
    await until(() => ui.$$('#member-list .ml-row').length === 3);
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('channel list groups channels under categories and updates live; Server Settings opens from the dashboard', async () => {
  const ui = await openApp(owner);
  try {
    await until(() => ui.$$('#server-rail-list [onclick*="selectServer"]').length >= 1);
    ui.w.selectServer(sid);
    await until(() => ui.$$('#channel-list .channel-item').length === 1);
    assert.equal(ui.$$('.channel-category').length, 0);
    const cat = (await owner.post(`/servers/${sid}/categories`, { name: 'Projects' })).body.category;
    const ch = (await owner.post(`/servers/${sid}/channels`, { name: 'builds', category_id: cat.id })).body.channel;
    await until(() => ui.$$('.channel-category').some(e => /Projects/.test(e.textContent)));
    const names = ui.$$('#channel-list > *').map(e => e.textContent.replace(/\s+/g, ' ').trim());
    assert.deepEqual(names, ['#general', 'Projects', '#builds'], 'uncategorised first, then each category with its channels');
    // hide the channel from the default role: it disappears from the live list
    const memberRole = (await owner.get(`/servers/${sid}/roles`)).body.roles.find(r => r.is_default).id;
    const ui2 = await openApp(bob);
    try {
      await until(() => ui2.$$('#server-rail-list [onclick*="selectServer"]').length >= 1);
      ui2.w.selectServer(sid);
      await until(() => ui2.$$('#channel-list .channel-item').length === 2);
      await owner.put(`/servers/${sid}/channels/${ch.id}/overrides/${memberRole}`, { allow: 0, deny: 1 });
      await until(() => ui2.$$('#channel-list .channel-item').length === 1);
      assert.ok(!ui2.$('#channel-list').textContent.includes('builds'));
    } finally { ui2.close(); }
    // Server Settings opens from the settings button and closes cleanly
    ui.w.showServerSettingsModal();
    await until(() => ui.$('#server-settings-view'));
    assert.deepEqual([...ui.$$('.ssv-nav-item')].map(b => b.textContent.trim()), ['Overview', 'Members', 'Roles', 'Channels', 'Moderation', 'Audit Log']);
    await until(() => ui.$('#ov-name') && ui.$('#ov-name').value === 'Dash Server');
    ui.click('[data-close]');
    await until(() => !ui.$('#server-settings-view'));
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('settings view and friends refresh handlers referenced from index.html exist', async () => {
  const ui = await openApp(owner);
  try {
    await until(() => ui.$$('#server-rail-list [onclick*="selectServer"]').length >= 1);
    // Friends "Refresh" button: onclick="loadFriendsData().then(renderFriendsList)"
    assert.equal(typeof ui.w.loadFriendsData, 'function');
    assert.equal(typeof ui.w.renderFriendsList, 'function');
    await ui.w.loadFriendsData().then(ui.w.renderFriendsList);
    // Settings mobile back button: onclick="showSettingsList()" (defined once the settings view is initialised)
    ui.w.eval("router.navigate('/settings')");
    await until(() => ui.$('.settings-container'));
    assert.equal(typeof ui.w.showSettingsList, 'function');
    ui.w.showSettingsList();
    // Revealing the email shows the account's real address; with none on file it shows a dash, never a made-up one
    const realEmail = (await owner.get('/auth/me')).body.user.email;
    assert.ok(realEmail, 'test account has an email');
    ui.w.eval('toggleEmailVisibility()');
    assert.equal(ui.$('#settings-email').textContent, realEmail);
    ui.w.eval('toggleEmailVisibility()');                       // hide again
    ui.w.eval('currentUser.email = undefined');
    ui.w.eval('toggleEmailVisibility()');
    assert.equal(ui.$('#settings-email').textContent, '—');
    assert.ok(!/user@example\.com/.test(ui.doc.body.textContent));
    // Settings account fields come from the logged-in user, not static text
    await until(() => ui.$('#settings-username') && ui.$('#settings-username').textContent === '@' + owner.username);
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('ownership transfer is reflected live in the real dashboard: crown moves, old owner loses the settings button', async () => {
  const r = await owner.post('/servers', { name: 'Swap Live' });
  const sid3 = r.body.server.id, ch3 = r.body.default_channel_id;
  const inv = (await owner.post(`/servers/${sid3}/invites`, {})).body.invite.code; await bob.post(`/invites/${inv}/join`);
  const ui = await openApp(owner);
  try {
    await until(() => ui.$$('#server-rail-list [onclick*="selectServer"]').length >= 2);
    ui.w.selectServer(sid3);
    await until(() => ui.$$('#channel-list .channel-item').length === 1);
    ui.w.openChannel(ch3);
    await until(() => ui.$$('#member-list .ml-row').length === 2);
    const rowOf = u => ui.$$('#member-list .ml-row').find(x => x.textContent.includes(u.username));
    assert.ok(rowOf(owner).querySelector('.owner-crown'), 'crown starts on the owner');
    assert.equal(ui.$('#server-settings-btn').style.display, '', 'owner sees the settings button');
    // transfer over REST (as the owner), exactly what the Members page calls
    assert.equal((await owner.post(`/servers/${sid3}/transfer-ownership`, { user_id: bob.id, confirm_name: 'Swap Live' })).status, 200);
    await until(() => rowOf(bob) && rowOf(bob).querySelector('.owner-crown'));
    assert.equal(rowOf(owner).querySelector('.owner-crown'), null, 'crown left the old owner');
    // the old owner still holds the Admin role created with the server, so the button stays until it is removed
    const adminRole = (await bob.get(`/servers/${sid3}/roles`)).body.roles.find(x => x.name === 'Admin').id;
    await bob.patch(`/servers/${sid3}/members/${owner.id}`, { remove_role_ids: [adminRole] });
    await until(() => ui.$('#server-settings-btn').style.display === 'none');
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});
