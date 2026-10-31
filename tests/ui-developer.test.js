// 0.9.0: the Developer navigation item and workspace in the REAL dashboard
// (public/index.html + public/js/*.js inside jsdom, against a live server).
// Regular users must not see it, developers and administrators must, report
// text must be rendered as text (never markup), and Admin must keep working.
// jsdom = DOM simulation: no layout or CSS.
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
});
test.after(async () => { if (s) await s.stop(); });

// Opens the app and waits until the dashboard has finished initialising for this user.
async function openReady(user) {
  const ui = await openApp(user);
  await until(() => ui.w.eval('typeof currentUser !== "undefined" && !!currentUser && !!currentUser.role') && ui.$('#up-name') && ui.$('#up-name').textContent.trim() !== '');
  await new Promise(r => setTimeout(r, 150));
  return ui;
}
const display = (ui, id) => ui.$('#' + id).style.display;
const submit = (c, over = {}) => c.post('/reports', { title: 'Something is wrong', description: 'It does not work the way I expect it to.', category: 'BUG', ...over });

test('a regular user sees no Developer item, cannot open the workspace by any route, and gets no developer data', async () => {
  const ui = await openReady(U.uiuser);
  try {
    assert.equal(ui.w.eval('currentUser.role'), 'USER');
    assert.equal(display(ui, 'nav-developer'), 'none');
    assert.equal(display(ui, 'nav-admin'), 'none');
    ui.w.eval("navigateTo('developer')");                    // forced from the console / stale state
    await new Promise(r => setTimeout(r, 200));
    assert.equal(display(ui, 'developer-panel'), 'none', 'panel stays closed');
    assert.equal(ui.$('#developer-panel').innerHTML.trim(), '', 'nothing was even built or fetched');
    assert.doesNotMatch(ui.w.location.pathname, /developer/);
    // forging the client-side role changes only the cosmetics; the API still refuses
    ui.w.eval("currentUser.role = 'ADMIN'");
    assert.equal((await U.uiuser.get('/developer/overview')).status, 403);
    assert.equal((await U.uiuser.get('/developer/reports')).status, 403);
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('the direct /developer URL bounces a regular user back to the app', async () => {
  const user = U.uiuser;
  const vc = new VirtualConsole();
  const dom = await JSDOM.fromURL(s.base + '/developer', {
    runScripts: 'dangerously', resources: loader, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.localStorage.setItem('nyxie_token', user.token);
      w.localStorage.setItem('nyxie_user', JSON.stringify({ id: user.id, username: user.username, role: 'USER' }));
      w.localStorage.setItem('nyxie_private_key_' + user.id, user.keys.priv);
      w.localStorage.setItem('nyxie_public_key_' + user.id, user.keys.pub);
      w.fetch = (u, o) => fetch(new URL(u, s.base), o);
      w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      for (const k of ['IntersectionObserver', 'ResizeObserver', 'MutationObserver']) if (!w[k]) w[k] = class { observe() {} unobserve() {} disconnect() {} };
      w.Element.prototype.scrollIntoView = function () {}; w.HTMLElement.prototype.scrollTo = function () {}; w.scrollTo = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null;
    }
  });
  try {
    await until(() => !/developer/.test(dom.window.location.pathname));
    assert.match(dom.window.location.pathname, /^\/(app|login)?$/);
  } finally { dom.window.close(); }
});

test('a developer gets the Developer item next to Admin, and it opens the real workspace', async () => {
  const ui = await openReady(U.uidev);
  try {
    assert.equal(ui.w.eval('currentUser.role'), 'DEVELOPER');
    assert.equal(display(ui, 'nav-developer'), 'flex');
    assert.equal(display(ui, 'nav-admin'), 'none', 'a developer does not get the Admin item');
    assert.equal(ui.$('#nav-admin').nextElementSibling.id, 'nav-developer', 'placed right after Admin in the Home navigation');
    assert.equal(ui.$('#nav-developer span').textContent.trim(), 'Developer');
    assert.ok(ui.$('#nav-developer svg'), 'uses the same inline-SVG icon system');

    // empty database: honest empty state, no invented tickets
    ui.clickInline('#nav-developer');
    await until(() => display(ui, 'developer-panel') === 'flex' && /No reports yet/.test(ui.$('#dev-body').textContent));
    assert.ok(ui.$('#nav-developer').classList.contains('active'));
    assert.ok(!ui.$('#nav-admin').classList.contains('active'));
    assert.equal(ui.w.location.pathname, '/developer');
    assert.equal(ui.$$('#dev-body .dev-row').length, 0);
    assert.equal(ui.$$('#dev-tabs .dev-tab').some(t => /Security/.test(t.textContent)), false, 'no Security tab without permission');

    // switching to another section updates the active state and hides the panel
    ui.clickInline('.nav-item[onclick*="friends"]');
    await until(() => display(ui, 'developer-panel') === 'none');
    assert.ok(!ui.$('#nav-developer').classList.contains('active'));
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('workspace shows real reports; report text is rendered as text, never as markup', async () => {
  const evilTitle = '<img src=x onerror=window.__pwned=1> bug';
  const evilBody = '<script>window.__pwned=1</script> long enough description here';
  await submit(U.uirep, { title: evilTitle, description: evilBody, category: 'BUG', app_version: '0.9.0', platform: 'Linux' });
  await submit(U.uirep, { title: 'Please add dark mode scheduling', category: 'FEATURE' });
  await submit(U.uirep, { title: 'General thoughts about Nyxie', category: 'GENERAL' });
  const sec = await submit(U.uirep, { title: 'Private vulnerability report', category: 'SECURITY' });
  assert.equal(sec.status, 201);

  const ui = await openReady(U.uidev);
  try {
    ui.clickInline('#nav-developer');
    await until(() => ui.$$('#dev-body .dev-card').length === 6);
    const text = ui.$('#dev-body').textContent;
    assert.match(text, /Total reports/);
    const cards = Object.fromEntries(ui.$$('#dev-body .dev-card').map(c => [c.querySelector('.dev-card-label').textContent.trim(), Number(c.querySelector('.dev-card-value').textContent)]));
    assert.equal(cards['Total reports'], 3, 'the security report is not counted for a developer without access');
    assert.equal(ui.$$('#dev-tabs .dev-tab').some(t => /Security/.test(t.textContent)), false);
    assert.doesNotMatch(ui.$('#developer-panel').textContent, /vulnerability/i);

    // All Reports queue lists the real rows, with counts on the tabs
    ui.click(ui.$$('#dev-tabs .dev-tab').find(t => /All Reports/.test(t.textContent)));
    await until(() => ui.$$('#dev-body .dev-row').length === 3);
    assert.match(ui.$$('#dev-tabs .dev-tab').find(t => /All Reports/.test(t.textContent)).textContent, /3/);
    assert.equal(ui.$('#developer-panel img'), null, 'a title containing <img> was not turned into an element');
    assert.equal(ui.$('#developer-panel script'), null);
    assert.ok([...ui.$$('#dev-body .dev-title')].some(e => e.textContent === evilTitle), 'shown as literal text');
    assert.equal(ui.w.__pwned, undefined);

    // search filters (debounced) and stays in the queue
    const search = ui.$('#dev-search');
    search.value = 'dark mode';
    search.dispatchEvent(new ui.w.Event('input', { bubbles: true }));
    await until(() => ui.$$('#dev-body .dev-row').length === 1);
    assert.match(ui.$('#dev-body .dev-title').textContent, /dark mode/);
    search.value = 'zzz-no-match';
    search.dispatchEvent(new ui.w.Event('input', { bubbles: true }));
    await until(() => /No reports match these filters/.test(ui.$('#dev-body').textContent));
    search.value = '';
    search.dispatchEvent(new ui.w.Event('input', { bubbles: true }));
    await until(() => ui.$$('#dev-body .dev-row').length === 3);

    // open the hostile report: persisted details, escaped
    ui.click([...ui.$$('#dev-body .dev-row')].find(r => r.textContent.includes('onerror')));
    await until(() => ui.$('#dev-body .dev-detail'));
    assert.equal(ui.$('#developer-panel img'), null);
    assert.equal(ui.$('#developer-panel script'), null);
    assert.ok(ui.$('#dev-body .admin-note-box').textContent.startsWith('<script>'), 'description shown literally');
    assert.match(ui.$('#dev-body .dev-meta').textContent, /0\.9\.0/);
    assert.match(ui.$('#dev-body .dev-meta').textContent, /identity hidden/);
    assert.equal(ui.w.__pwned, undefined);

    // real actions: status, priority, assignee, internal note, development link
    const number = Number(ui.$('#dev-body .dev-detail').dataset.n);
    const setField = async (field, value, check) => {
      const sel = ui.$(`#dev-body [data-field="${field}"]`);
      sel.value = value;
      sel.dispatchEvent(new ui.w.Event('change', { bubbles: true }));
      await until(check);
    };
    await setField('status', 'IN_PROGRESS', () => /In progress/.test(ui.$('#dev-body .dev-detail-head').textContent));
    await setField('priority', 'URGENT', () => /Urgent/.test(ui.$('#dev-body .dev-detail-head').textContent));
    await setField('assignee_id', U.uidev.id, () => ui.$('#dev-body [data-field="assignee_id"]').value === U.uidev.id);
    ui.$('#dev-note-input').value = 'Reproduced on Linux <b>twice</b>';
    ui.click('#dev-body [data-act="add-note"]');
    await until(() => ui.$('#dev-body .dev-note-body'));
    assert.equal(ui.$('#dev-body .dev-note-body b'), null, 'note rendered as text');
    ui.$('#dev-link-input').value = 'https://github.com/nyxie/nyxie/issues/42';
    ui.click('#dev-body [data-act="save-link"]');
    await until(() => ui.$('#dev-body a[href^="https://github.com"]'));
    assert.equal(ui.$('#dev-body a[href^="https://github.com"]').getAttribute('rel'), 'noopener noreferrer');

    const persisted = (await U.uidev.get(`/developer/reports/${number}`)).body.report;
    assert.equal(persisted.status, 'IN_PROGRESS'); assert.equal(persisted.priority, 'URGENT');
    assert.equal(persisted.assignee.id, U.uidev.id);
    assert.equal(persisted.linked.kind, 'ISSUE');
    assert.ok(persisted.events.some(e => e.type === 'NOTE' && e.body.includes('<b>twice</b>')));
    // the status select only offers legal next states
    assert.deepEqual([...ui.$$('#dev-body [data-field="status"] option')].map(o => o.value).sort(), ['IN_PROGRESS', ...persisted.allowed_transitions].sort());

    // back to the list; the overview now reflects persisted data
    ui.click('#dev-body [data-act="back"]');
    await until(() => ui.$$('#dev-body .dev-row').length === 3);
    ui.click(ui.$$('#dev-tabs .dev-tab').find(t => /Overview/.test(t.textContent)));
    await until(() => ui.$$('#dev-body .dev-card').length === 6);
    const c2 = Object.fromEntries(ui.$$('#dev-body .dev-card').map(c => [c.querySelector('.dev-card-label').textContent.trim(), Number(c.querySelector('.dev-card-value').textContent)]));
    assert.equal(c2['In progress'], 1);
    assert.equal(c2['Awaiting review'], 2);
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('an administrator sees both Admin and Developer, the security queue, and Admin still works', async () => {
  const ui = await openReady(U.uiadmin);
  try {
    assert.equal(ui.w.eval('currentUser.role'), 'ADMIN');
    assert.equal(display(ui, 'nav-admin'), 'flex');
    assert.equal(display(ui, 'nav-developer'), 'flex');
    ui.clickInline('#nav-developer');
    await until(() => display(ui, 'developer-panel') === 'flex' && ui.$$('#dev-body .dev-card').length === 6);
    assert.ok(ui.$$('#dev-tabs .dev-tab').some(t => /Security Reports/.test(t.textContent)), 'administrators get the security queue');
    ui.click(ui.$$('#dev-tabs .dev-tab').find(t => /Security Reports/.test(t.textContent)));
    await until(() => ui.$$('#dev-body .dev-row').length === 1);
    assert.match(ui.$('#dev-body .dev-title').textContent, /vulnerability/);

    // regression: the Admin panel opens, the developer panel closes, active state follows
    ui.clickInline('#nav-admin');
    await until(() => display(ui, 'admin-panel') === 'flex');
    assert.equal(display(ui, 'developer-panel'), 'none');
    assert.ok(ui.$('#nav-admin').classList.contains('active'));
    assert.ok(!ui.$('#nav-developer').classList.contains('active'));
    assert.ok(ui.$$('.admin-tab-btn').length >= 3, 'Disputes / Badges / Wallet tabs are intact');
    assert.deepEqual(notDefinedErrors(ui), []);
  } finally { ui.close(); }
});

test('the Settings → Feedback form is opt-in for diagnostics and sends no hidden data', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const box = /<input[^>]*id="feedback-diagnostics"[^>]*>/.exec(html)[0];
  assert.doesNotMatch(box, /\bchecked\b/, 'diagnostics are off by default');
  for (const id of ['feedback-title', 'feedback-message', 'feedback-version', 'feedback-platform', 'feedback-files', 'feedback-diagnostics-preview']) assert.ok(html.includes(`id="${id}"`), id);
  for (const cat of ['BUG', 'FEATURE', 'GENERAL', 'SECURITY']) assert.ok(html.includes(`data-cat="${cat}"`), cat);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings.js'), 'utf8');
  const feedback = js.slice(js.indexOf('// ---- Feedback ----'), js.indexOf('// ---- Changelogs ----'));
  assert.ok(feedback.length > 500);
  const uaLines = feedback.split('\n').filter(l => /navigator\.userAgent/.test(l));
  assert.equal(uaLines.length, 1);
  assert.match(feedback, /\.exec\(ua\)/, 'the user agent is only used to pick out the browser name, never sent whole');
  assert.doesNotMatch(feedback, /join\(\s*['"]\s*\|\s*['"]\s*\)[\s\S]*\bua\b[\s\S]*\]/, 'ua itself is not part of the sent text');
  assert.match(feedback, /diagnostics_consent:\s*withDiagnostics/);
  assert.doesNotMatch(feedback, /nyxie_token|nyxie_private|nyxie_public|\btoken\b(?!\s*[,}])[^\n]*localStorage/, 'no keys or tokens are read for a report');
  assert.doesNotMatch(feedback, /messages?\b.*(innerText|textContent|chat-messages)/, 'no chat content is read');
});
