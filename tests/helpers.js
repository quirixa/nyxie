// Test helpers: boots the real server on a random port against a
// throwaway NYXIE_DATA_DIR (never touches ./data), and offers tiny REST
// and WebSocket clients.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');

async function startServer({ dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'nyxie-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PORT: String(port), NYXIE_DATA_DIR: dir, JWT_SECRET: crypto.randomBytes(32).toString('hex') };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env, cwd: ROOT });
  let out = '';
  proc.stdout.on('data', d => (out += d));
  proc.stderr.on('data', d => (out += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start:\n' + out)), 15000);
    const iv = setInterval(() => {
      if (out.includes('Server running')) { clearTimeout(t); clearInterval(iv); resolve(); }
    }, 50);
    proc.on('exit', code => { clearTimeout(t); clearInterval(iv); reject(new Error('server exited ' + code + '\n' + out)); });
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    dir, port, base, proc, log: () => out,
    async stop() {
      proc.kill('SIGTERM');
      // The server's graceful shutdown flushes both databases synchronously
      // and then waits for every open connection to close. A leftover
      // keep-alive/WebSocket connection from a test client must not hang the
      // whole test run, so escalate after a few seconds (nothing is lost:
      // the flush has already happened by then).
      const killer = setTimeout(() => proc.kill('SIGKILL'), 4000);
      await new Promise(r => proc.on('exit', r));
      clearTimeout(killer);
    }
  };
}

function client(base, token) {
  async function call(method, p, body) {
    const res = await fetch(base + '/api' + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
  }
  return { token, get: p => call('GET', p), post: (p, b) => call('POST', p, b || {}), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: (p, b) => call('DELETE', p, b) };
}

let counter = 0;
async function registerUser(base, name) {
  const username = (name || 'user') + (++counter) + crypto.randomBytes(2).toString('hex');
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: username + '@example.test', password: 'correct-horse-battery', display_name: username })
  });
  const body = await res.json();
  if (!body.token) throw new Error('register failed: ' + JSON.stringify(body));
  const c = client(base, body.token);
  c.id = body.user.id; c.username = username;
  return c;
}

// Minimal WS client collecting every message.
function openWs(base, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + token);
    const msgs = [];
    ws.on('message', d => { try { msgs.push(JSON.parse(d)); } catch (_) {} });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws, msgs,
      send: o => ws.send(JSON.stringify(o)),
      waitFor: (pred, ms = 3000) => new Promise((res, rej) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          const m = msgs.find(pred);
          if (m) { clearInterval(iv); res(m); }
          else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('ws timeout')); }
        }, 25);
      }),
      close: () => ws.close()
    }));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Friends / DMs / E2EE test helpers (0.12.0) ──────────────────────────
// New one-to-one DMs can only be created between friends, and every DM message must
// be real ciphertext. These helpers do the same thing the browser does, using the
// same primitives (tweetnacl box + secretbox, one random key per message wrapped for
// every participant), so tests exercise the genuine encryption boundary.
const nacl = require('tweetnacl');
const b64 = u8 => Buffer.from(u8).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));

async function ensureKeys(user) {
  if (user.keys) return user.keys;
  const kp = nacl.box.keyPair();
  user.keys = { priv: b64(kp.secretKey), pub: b64(kp.publicKey), raw: kp };
  const r = await user.patch('/users/me', { public_key: user.keys.pub, encrypted_private_key: b64(nacl.randomBytes(48)), key_salt: b64(nacl.randomBytes(16)), key_nonce: b64(nacl.randomBytes(24)) });
  if (r.status >= 300) throw new Error('could not register key: ' + JSON.stringify(r.body));
  return user.keys;
}

async function befriend(a, b) {
  const r = await a.post('/friends/request', { to_id: b.id });
  if (r.status === 201) {
    const reqs = (await b.get('/friends/requests')).body.incoming;
    const id = reqs.find(x => x.from_id === a.id).id;
    const ok = await b.post(`/friends/requests/${id}/accept`);
    if (ok.status !== 200) throw new Error('accept failed: ' + JSON.stringify(ok.body));
  } else if (r.status !== 409 && r.status !== 200) throw new Error('friend request failed: ' + JSON.stringify(r.body));
}

// A 1:1 DM between two users. By default they are NOT left as friends — an existing DM
// outliving a friendship is a real state (and a useful one to test).
async function dmBetween(a, b, { stayFriends = false } = {}) {
  await befriend(a, b);
  const r = await a.post('/rooms/dm', { target_user_id: b.id });
  if (!(r.body && r.body.room_id)) throw new Error('dm failed: ' + JSON.stringify(r.body));
  if (!stayFriends) await a.del('/friends/' + b.id);
  return r.body.room_id;
}

// Encrypts `text` on "sender's device" for the given recipients (their public keys are
// looked up the way the app does). Returns the exact body POST /rooms/:id/messages wants.
async function encryptFor(sender, recipients, text) {
  await ensureKeys(sender);
  const key = nacl.randomBytes(32), nonce = nacl.randomBytes(24);
  const ct = nacl.secretbox(new TextEncoder().encode(text), nonce, key);
  const key_envelopes = {};
  for (const m of [sender, ...recipients]) {
    await ensureKeys(m);
    const shared = nacl.box.before(unb64(m.keys.pub), unb64(sender.keys.priv));
    const n = nacl.randomBytes(24);
    key_envelopes[m.id] = { ciphertext: b64(nacl.secretbox(key, n, shared)), nonce: b64(n) };
  }
  return { ciphertext: b64(ct), nonce: b64(nonce), key_envelopes };
}

// Inverse, for tests that prove a RECIPIENT can read it (and, by omission, that nobody else can).
function decryptFrom(reader, sender, payload) {
  const env = payload.key_envelopes[reader.id];
  if (!env) return null;
  const shared = nacl.box.before(unb64(sender.keys.pub), unb64(reader.keys.priv));
  const key = nacl.secretbox.open(unb64(env.ciphertext), unb64(env.nonce), shared);
  if (!key) return null;
  const pt = nacl.secretbox.open(unb64(payload.ciphertext || payload.content), unb64(payload.nonce), key);
  return pt ? new TextDecoder().decode(pt) : null;
}

module.exports = { startServer, client, registerUser, openWs, sleep, ROOT, ensureKeys, befriend, dmBetween, encryptFor, decryptFrom, nacl, b64, unb64 };
