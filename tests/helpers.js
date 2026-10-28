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
      await new Promise(r => proc.on('exit', r));
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
module.exports = { startServer, client, registerUser, openWs, sleep, ROOT };
