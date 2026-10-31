// 0.10.0: long messages (> 2,000 characters) become an encrypted message.txt
// attachment; text-file cards + viewer; multi-line composer; attachment
// validation; and permission-checked downloads of encrypted attachments.
//
// Server rules are tested over HTTP against a real server. The client flow
// runs the REAL dashboard (public/index.html + public/js/*.js) in jsdom
// (no layout or CSS), including the browser-side encryption.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const { JSDOM, requestInterceptor, VirtualConsole } = require('jsdom');
const { startServer, registerUser } = require('./helpers');

const NM = path.join(__dirname, '..', 'node_modules');
const b64 = u8 => Buffer.from(u8).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
let s, owner, alice, bob, carol, sid, general;

async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting: ' + fn.toString().slice(0, 160));
    await new Promise(r => setTimeout(r, 40));
  }
}

async function giveKeys(user) {
  const kp = nacl.box.keyPair();
  user.keys = { priv: b64(kp.secretKey), pub: b64(kp.publicKey), raw: kp };
  const r = await user.patch('/users/me', { public_key: user.keys.pub, encrypted_private_key: b64(nacl.randomBytes(48)), key_salt: b64(nacl.randomBytes(16)), key_nonce: b64(nacl.randomBytes(24)) });
  assert.ok(r.status < 300, JSON.stringify(r.body));
}

// Uploads ciphertext-looking bytes the way the app does (random name, .nx).
async function uploadNx(user, bytes, name = 'message.txt') {
  const fd = new FormData(); fd.append('file', new Blob([bytes]), name + '.nx');
  const res = await fetch(s.base + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + user.token }, body: fd });
  const body = await res.json();
  assert.ok(body.url, JSON.stringify(body));
  return body.url;
}
const getFile = (url, user) => fetch(s.base + url, { headers: user ? { Authorization: 'Bearer ' + user.token } : {} });
const att = (url, extra = {}, uid) => ({ name: 'message.txt', url, type: 'text/plain', size: 1, encrypted: true, nonce: 'bm9uY2U=', key_envelopes: { [uid]: { ciphertext: 'Y2lwaGVy', nonce: 'bm9uY2U=' } }, ...extra });

test.before(async () => {
  s = await startServer();
  owner = await registerUser(s.base, 'lmowner'); alice = await registerUser(s.base, 'lmalice'); bob = await registerUser(s.base, 'lmbob'); carol = await registerUser(s.base, 'lmcarol');
  const r = await owner.post('/servers', { name: 'LM Server' });
  sid = r.body.server.id; general = r.body.default_channel_id;
  for (const u of [owner, alice, bob, carol]) await giveKeys(u);
  for (const u of [alice, bob]) { const inv = (await owner.post(`/servers/${sid}/invites`, {})).body.invite.code; await u.post(`/invites/${inv}/join`); }
});
test.after(async () => { if (s) await s.stop(); });

// ─── Server: limits ──────────────────────────────────────────────
test('text limit is exactly 2,000 characters (code points); edits follow the same rule', async () => {
  const ch = `/channels/${general}/messages`;
  assert.equal((await owner.post(ch, { content: 'a'.repeat(2000) })).status, 201, '2000 is fine');
  const over = await owner.post(ch, { content: 'a'.repeat(2001) });
  assert.equal(over.status, 400); assert.match(over.body.error, /2000/);
  assert.equal((await owner.post(ch, { content: '😀'.repeat(2000) })).status, 201, 'an emoji counts as one character');
  assert.equal((await owner.post(ch, { content: '😀'.repeat(2001) })).status, 400);
  // encrypted text: the largest ciphertext 2,000 characters can produce is accepted, one more character is not
  const nonce = b64(nacl.randomBytes(24)), env = { [owner.id]: { ciphertext: 'Y2lwaGVy', nonce } };
  assert.equal((await owner.post(ch, { ciphertext: 'A'.repeat(10688), nonce, key_envelopes: env })).status, 201);
  assert.equal((await owner.post(ch, { ciphertext: 'A'.repeat(10689), nonce, key_envelopes: env })).status, 400);
  const m = (await owner.post(ch, { content: 'edit me' })).body.message;
  assert.equal((await owner.patch(`${ch}/${m.id}`, { content: 'b'.repeat(2000) })).status, 200);
  assert.equal((await owner.patch(`${ch}/${m.id}`, { content: 'b'.repeat(2001) })).status, 400);
});

// ─── Server: attachment validation ───────────────────────────────
test('attachments: only files this server stored; encrypted size comes from the file; names are cleaned', async () => {
  const ch = `/channels/${general}/messages`;
  const bad = u => owner.post(ch, { attachments: [att(u, {}, owner.id)] });
  assert.equal((await bad('/uploads/../../etc/passwd')).status, 400);
  assert.equal((await bad('https://evil.test/x.nx')).status, 400);
  assert.equal((await bad('/uploads/not-ours.nx')).status, 400);
  assert.equal((await bad('/uploads/1700000000000-' + 'a'.repeat(32) + '.nx')).status, 400, 'well-formed name but no such file');
  const url = await uploadNx(owner, Buffer.alloc(116, 7));
  assert.equal((await owner.post(ch, { attachments: [att(url, { encrypted: true, nonce: '' }, owner.id)] })).status, 400, 'encrypted attachment without a nonce');
  assert.equal((await owner.post(ch, { attachments: [{ ...att(url, {}, owner.id), key_envelopes: {} }] })).status, 400, 'encrypted attachment without key envelopes');
  const ok = await owner.post(ch, { attachments: [att(url, { name: 'my\u0000/\\notes.txt', size: 999999, type: 'text/html' }, owner.id)] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const a = ok.body.message.attachments[0];
  assert.equal(a.size, 100, 'plaintext size = stored size - 16, not the client number');
  assert.equal(a.type, 'text/plain', '.txt is always text/plain');
  assert.ok(!/[\u0000/\\]/.test(a.name), 'control characters and separators removed: ' + a.name);
  assert.equal(ok.body.message.content, '', 'a converted long message has no text part');
});

// ─── Server: permissions on download ─────────────────────────────
test('encrypted attachments: sign-in + current access to the room are required on every download', async () => {
  const dm = (await owner.post('/rooms/dm', { target_user_id: alice.id })).body;
  const roomId = dm.room_id || dm.room?.id;
  const bytes = Buffer.from(nacl.randomBytes(300));
  const url = await uploadNx(owner, bytes);
  // uploaded but not attached to any message: nobody can fetch it, not even the uploader
  assert.equal((await getFile(url, owner)).status, 404);
  const sent = await owner.post(`/rooms/${roomId}/messages`, { attachments: [att(url, {}, owner.id)] });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal((await getFile(url)).status, 401, 'no session');
  assert.equal((await getFile(url, { token: 'garbage' })).status, 401, 'bad session');
  assert.equal((await getFile(url, carol)).status, 404, 'signed in but not in the DM');
  assert.equal((await getFile(url, bob)).status, 404, 'bob is not in this DM');
  for (const u of [owner, alice]) {
    const r = await getFile(url, u);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    assert.match(r.headers.get('cache-control'), /no-cache/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
  }
  // same in a server channel: members yes, outsiders no
  const cu = await uploadNx(owner, Buffer.alloc(64, 1));
  assert.equal((await owner.post(`/channels/${general}/messages`, { attachments: [att(cu, {}, owner.id)] })).status, 201);
  assert.equal((await getFile(cu, bob)).status, 200);
  assert.equal((await getFile(cu, carol)).status, 404);
  // once the message is deleted the file is gone for everyone
  const del = await owner.del(`/rooms/${roomId}/messages/${sent.body.message.id}`);
  assert.ok(del.status < 300, JSON.stringify(del.body));
  assert.equal((await getFile(url, alice)).status, 404);
  // plain (legacy, non-.nx) uploads are unchanged and still public
  const fd = new FormData(); fd.append('file', new Blob(['hello']), 'a.txt');
  const up = await (await fetch(s.base + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token }, body: fd })).json();
  const pub = await getFile(up.url);
  assert.equal(pub.status, 200); assert.equal(await pub.text(), 'hello');
});

test('channel permissions: no Attach Files means no .txt; losing access cuts off downloads immediately', async () => {
  const P = { VIEW: 1, SEND: 2, HISTORY: 8192, ATTACH: 16384 };
  const made = await owner.post('/servers', { name: 'LM Perms' });
  const psid = made.body.server.id, ch = `/channels/${made.body.default_channel_id}/messages`;
  const memberRole = (await owner.get(`/servers/${psid}/roles`)).body.roles.find(r => r.name === 'Member');
  const joinSrv = async u => { const inv = (await owner.post(`/servers/${psid}/invites`, {})).body.invite.code; assert.equal((await u.post(`/invites/${inv}/join`)).status, 200); };
  await joinSrv(alice); await joinSrv(bob);
  // baseline for everyone: view + send + read history, but NOT attach
  await owner.patch(`/servers/${psid}/roles/${memberRole.id}`, { permissions: P.VIEW | P.SEND | P.HISTORY });
  const url = await uploadNx(alice, Buffer.alloc(80, 3));
  const denied = await alice.post(ch, { attachments: [att(url, {}, alice.id)] });
  assert.equal(denied.status, 403, 'a long message cannot be sent as a file without Attach Files');
  assert.match(denied.body.error, /attach/i);
  assert.equal((await getFile(url, alice)).status, 404, 'rejected, so the file is not reachable');
  // allowed once Attach Files is granted
  await owner.patch(`/servers/${psid}/roles/${memberRole.id}`, { permissions: P.VIEW | P.SEND | P.HISTORY | P.ATTACH });
  const sent = await alice.post(ch, { attachments: [att(url, {}, alice.id)] });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal((await getFile(url, bob)).status, 200);
  // bob loses message history: his next download is refused even though the file name is unchanged
  await owner.patch(`/servers/${psid}/roles/${memberRole.id}`, { permissions: P.VIEW | P.SEND | P.ATTACH });
  assert.equal((await getFile(url, bob)).status, 404, 'no Read Message History');
  assert.equal((await getFile(url, alice)).status, 404);
  // and a member who left can no longer read it either
  await owner.patch(`/servers/${psid}/roles/${memberRole.id}`, { permissions: P.VIEW | P.SEND | P.HISTORY | P.ATTACH });
  assert.equal((await getFile(url, bob)).status, 200);
  assert.equal((await bob.post(`/servers/${psid}/leave`)).status < 300, true);
  assert.equal((await getFile(url, bob)).status, 404, 'left the server');
});

// ─── Real dashboard in jsdom ─────────────────────────────────────
const js = body => new Response(body, { headers: { 'Content-Type': 'application/javascript' } });
const loader = {
  interceptors: [requestInterceptor(request => {
    const url = request.url;
    if (/tweetnacl-util@/.test(url)) return js(fs.readFileSync(path.join(NM, 'tweetnacl-util', 'nacl-util.min.js')));
    if (/tweetnacl@/.test(url)) return js(fs.readFileSync(path.join(NM, 'tweetnacl', 'nacl-fast.min.js')));
    if (/cdn\.jsdelivr\.net|cdnjs|fonts\.g/.test(url)) return js('');
    return undefined;
  })]
};

async function openApp(user) {
  const errors = [], toasts = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e.detail && e.detail.message || e.message)));
  const dom = await JSDOM.fromURL(s.base + '/app', {
    runScripts: 'dangerously', resources: loader, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.localStorage.setItem('nyxie_token', user.token);
      w.localStorage.setItem('nyxie_private_key_' + user.id, user.keys.priv);
      w.localStorage.setItem('nyxie_public_key_' + user.id, user.keys.pub);
      w.localStorage.setItem('nyxie_user', JSON.stringify({ id: user.id, username: user.username, display_name: user.username }));
      // jsdom's fetch does not exist and its FormData is not Node's: hand the upload over as Node would see it.
      w.fetch = async (u, o = {}) => {
        if (o.body && o.body instanceof w.FormData) {
          const fd = new FormData();
          for (const [k, v] of o.body.entries()) {
            if (v && typeof v === 'object' && typeof v.arrayBuffer === 'function') fd.append(k, new Blob([Buffer.from(await v.arrayBuffer())]), v.name);
            else fd.append(k, v);
          }
          o = { ...o, body: fd };
        }
        return fetch(new URL(u, s.base), o);
      };
      let n = 0; w.URL.createObjectURL = () => 'blob:test/' + (++n); w.URL.revokeObjectURL = () => {};
      w.matchMedia = w.matchMedia || (q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
      for (const k of ['IntersectionObserver', 'ResizeObserver', 'MutationObserver']) if (!w[k]) w[k] = class { observe() {} unobserve() {} disconnect() {} };
      w.Element.prototype.scrollIntoView = function () {}; w.HTMLElement.prototype.scrollTo = function () {}; w.scrollTo = () => {};
      w.HTMLMediaElement.prototype.play = () => Promise.resolve(); w.HTMLMediaElement.prototype.pause = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null;
      w.Notification = w.Notification || class { static get permission() { return 'denied'; } static requestPermission() { return Promise.resolve('denied'); } };
      w.addEventListener('error', e => errors.push(e.message));
      w.addEventListener('unhandledrejection', e => errors.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
    }
  });
  const w = dom.window, doc = w.document;
  return { w, doc, errors, dom, $: q => doc.querySelector(q), $$: q => [...doc.querySelectorAll(q)], close: () => w.close() };
}

let uiSid, uiCh;
const apiMessages = async (u) => (await u.get(`/channels/${uiCh}/messages?limit=100`)).body.messages;

test('real dashboard: multi-line messages, the 2,000 limit, message.txt card + viewer, nothing lost', async () => {
  // its own server, so messages from the other tests do not interfere
  const made = await owner.post('/servers', { name: 'LM UI' });
  uiSid = made.body.server.id; uiCh = made.body.default_channel_id;
  for (const u of [alice, bob]) { const inv = (await owner.post(`/servers/${uiSid}/invites`, {})).body.invite.code; await u.post(`/invites/${inv}/join`); }
  const ui = await openApp(owner);
  try {
    await until(() => ui.$$('#server-rail-list [onclick*="selectServer"]').length >= 2);
    ui.w.selectServer(uiSid);
    await until(() => ui.$$('#channel-list .channel-item').length === 1);
    ui.w.openChannel(uiCh);
    await until(() => ui.$('#chat-room-name-text') && /general/.test(ui.$('#chat-room-name-text').textContent));
    await until(() => ui.$$('#member-list .ml-row').length === 3);

    const input = ui.$('#msg-input');
    assert.equal(input.tagName, 'TEXTAREA', 'the composer accepts line breaks');
    const send = async (text) => {
      input.value = text;
      input.dispatchEvent(new ui.w.Event('input', { bubbles: true }));
      ui.$('#send-btn').dispatchEvent(new ui.w.MouseEvent('click', { bubbles: true }));
    };
    // the row for the newest message the server holds (waits until it is drawn)
    const newestRow = async () => {
      const id = (await apiMessages(owner)).pop().id;
      return until(() => ui.$(`#messages-container [data-msg-id="${id}"]`));
    };

    // 1) a paragraph message keeps its line breaks and blank lines
    const para = 'First paragraph.\nstill first.\n\n  Second paragraph, indented.\n\nThird.';
    await send(para);
    await until(async () => (await apiMessages(owner)).length === 1);
    const shown = (await newestRow()).querySelector('.msg-text').textContent;
    assert.equal(shown, para, 'text is displayed exactly as typed');
    assert.equal(input.value, '', 'composer cleared after sending');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'dashboard.css'), 'utf8');
    assert.match(css, /#view-app \.msg-text \{[^}]*white-space: pre-wrap/, 'line breaks are rendered, not collapsed');

    // 2) exactly 2,000 characters is still an ordinary text message
    const exact = ('x'.repeat(99) + '\n').repeat(19) + 'x'.repeat(100);
    assert.equal([...exact].length, 2000);
    await send(exact);
    await until(async () => (await apiMessages(owner)).length === 2);
    let last = (await apiMessages(owner)).pop();
    assert.ok(!last.attachments, 'no attachment at 2000 characters');
    assert.ok(last.content && last.nonce, 'sent as encrypted text');
    const exactRow = await newestRow();
    assert.equal(exactRow.querySelector('.msg-txt-card'), null);
    await until(() => exactRow.querySelector('.msg-text').textContent === exact);

    // 3) 2,001 characters becomes message.txt, with every character preserved
    const long = ('Ünïcode ሰላም 😀 line with text\n'.repeat(100) + '\n\n  indented tail ' + 'z'.repeat(20)).slice(0);
    assert.ok([...long].length > 2000);
    await send(long);
    await until(async () => (await apiMessages(owner)).length === 3);
    assert.equal(input.value, '', 'cleared: the text is now in the file');
    last = (await apiMessages(owner)).pop();
    assert.equal(last.content, '', 'no text part');
    assert.equal(last.attachments.length, 1);
    assert.equal(last.attachments[0].name, 'message.txt');
    assert.equal(last.attachments[0].type, 'text/plain');
    assert.equal(last.attachments[0].size, Buffer.byteLength(long, 'utf8'), 'size is the real byte size');
    assert.ok(/\.nx$/.test(last.attachments[0].url));

    const row = await newestRow();
    const card = await until(() => row.querySelector('.msg-txt-card'));
    assert.match(card.querySelector('.msg-file-name').textContent, /^message\.txt$/);
    assert.match(card.querySelector('.msg-file-size').textContent, /KB|B$/);
    assert.ok(card.querySelector('.file-icon'), 'file icon');
    assert.ok(card.querySelector('[data-txt-open]'), 'Open');
    const dl = card.querySelector('a.msg-file-dl');
    assert.ok(dl && dl.getAttribute('download') === 'message.txt', 'Download');
    await until(() => (card.querySelector('.msg-txt-preview') || { textContent: '' }).textContent.includes('Ünïcode'));
    assert.ok(card.querySelector('.msg-txt-preview').textContent.endsWith('…'), 'preview is clipped, not the whole file');

    // Open → full, exact contents in the viewer; Escape closes it
    card.querySelector('[data-txt-open]').dispatchEvent(new ui.w.MouseEvent('click', { bubbles: true }));
    const viewer = ui.$('#nyxie-text-viewer');
    assert.ok(viewer.classList.contains('open'));
    await until(() => viewer.querySelector('.ntv-body').textContent === long);
    assert.equal(viewer.querySelector('.ntv-title').textContent, 'message.txt');
    assert.match(viewer.querySelector('.ntv-meta').textContent, /lines?/);
    ui.doc.dispatchEvent(new ui.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!viewer.classList.contains('open'));

    // 4) another member can fetch and decrypt it; an outsider cannot even download it
    const stored = (await apiMessages(bob)).pop();
    const a = stored.attachments[0];
    const res = await getFile(a.url, bob);
    assert.equal(res.status, 200);
    const env = a.key_envelopes[bob.id];
    const shared = nacl.box.before(unb64(owner.keys.pub), unb64(bob.keys.priv));
    const fileKey = nacl.secretbox.open(unb64(env.ciphertext), unb64(env.nonce), shared);
    const plain = nacl.secretbox.open(new Uint8Array(await res.arrayBuffer()), unb64(a.nonce), fileKey);
    assert.equal(Buffer.from(plain).toString('utf8'), long, 'bob reads the identical text');
    assert.equal((await getFile(a.url, carol)).status, 404);
    assert.equal((await getFile(a.url)).status, 401);

    // 5) when the long message cannot be sent, the text is kept
    const ten = Array.from({ length: 10 }, (_, i) => new ui.w.File(['x'], `f${i}.png`, { type: 'image/png' }));
    ui.w.handleFileUpload(ten);
    const count = (await apiMessages(owner)).length;
    await send(long);
    await new Promise(r => setTimeout(r, 400));
    assert.equal(input.value, long, 'text kept when there is no attachment slot left');
    assert.equal((await apiMessages(owner)).length, count, 'nothing was sent');

    assert.deepEqual(ui.errors.filter(e => /is not defined|is not a function/.test(e)), []);
  } finally { ui.close(); }
});
