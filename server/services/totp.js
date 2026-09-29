// server/services/totp.js — RFC 6238 TOTP (SHA-1, 6 digits, 30s) with no
// extra dependencies, plus helpers for encrypting the stored secret and
// hashing one-time backup codes.
const crypto = require('crypto');
const { JWT_SECRET } = require('./jwt');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1000000).padStart(6, '0');
}

// Accepts the current 30s step and one step either side for clock drift.
function verifyTotp(secretB32, code) {
  const submitted = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(submitted)) return false;
  const step = Math.floor(Date.now() / 30000);
  for (let w = -1; w <= 1; w++) {
    const expected = hotp(secretB32, step + w);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))) return true;
  }
  return false;
}

function otpauthUri(secretB32, accountName) {
  const issuer = 'Nyxie';
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}` +
    `?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ── secret at rest: AES-256-GCM keyed from JWT_SECRET ─────────────
const KEY = crypto.createHash('sha256').update('nyxie-totp:' + JWT_SECRET).digest();

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}

function decryptSecret(stored) {
  const [iv, tag, enc] = String(stored).split('.').map(p => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ── backup codes: 10 chars from a 32-symbol alphabet (~50 bits) ───
function generateBackupCode() {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (const b of bytes) out += B32[b & 31];
  return out.slice(0, 5) + '-' + out.slice(5);
}

function normalizeBackupCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function hashBackupCode(code) {
  return crypto.createHmac('sha256', JWT_SECRET).update(normalizeBackupCode(code)).digest('hex');
}

// Lightweight in-memory throttle: 5 wrong codes per 10 minutes per user.
const attempts = new Map();
function tooManyAttempts(userId) {
  const now = Date.now();
  const list = (attempts.get(userId) || []).filter(t => now - t < 10 * 60 * 1000);
  attempts.set(userId, list);
  return list.length >= 5;
}
function recordFailure(userId) {
  const list = attempts.get(userId) || [];
  list.push(Date.now());
  attempts.set(userId, list);
}
function clearFailures(userId) { attempts.delete(userId); }

module.exports = {
  generateSecret, verifyTotp, otpauthUri, encryptSecret, decryptSecret,
  generateBackupCode, hashBackupCode, normalizeBackupCode,
  tooManyAttempts, recordFailure, clearFailures,
};
