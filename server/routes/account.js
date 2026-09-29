// server/routes/account.js — backend for the Settings tabs that used to
// say "coming soon": Sessions, Two-Factor (authenticator + backup codes),
// Settings Sync, Feedback and My Bots. Mounted at /api/account.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getUserDb, get, all, run } = require('../database/userDb');
const { requireAuth } = require('../middleware/auth');
const { signToken, JWT_SECRET } = require('../services/jwt');
const { createSession, listSessions } = require('../services/sessions');
const { disconnectSessions } = require('../websocket');
const totp = require('../services/totp');

const router = express.Router();
router.use(requireAuth);

async function checkPassword(db, userId, password) {
  if (!password || typeof password !== 'string') return false;
  const row = get(db, 'SELECT password_hash FROM users WHERE id = ?', [userId]);
  return !!row && bcrypt.compare(password, row.password_hash);
}

// ── Sessions ───────────────────────────────────────────────────────
router.get('/sessions', async (req, res) => {
  const db = await getUserDb();
  res.json({ sessions: listSessions(db, req.user.id, req.sessionId), legacyToken: !req.sessionId });
});

router.delete('/sessions/:id', async (req, res) => {
  const db = await getUserDb();
  const id = req.params.id;
  if (id === req.sessionId) return res.status(400).json({ error: 'Use log out to end this device\'s session' });
  const row = get(db, 'SELECT id FROM user_sessions WHERE id = ? AND user_id = ? AND revoked = 0', [id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'Session not found' });
  run(db, 'UPDATE user_sessions SET revoked = 1 WHERE id = ?', [id]);
  disconnectSessions(req.user.id, sid => sid === id);
  res.json({ ok: true });
});

// Log out every other device. If this device is still on a pre-sessions
// token we can't tell it apart from the others, so it gets a fresh
// session-bound token in the response and the old ones are cut off by
// timestamp.
router.delete('/sessions', async (req, res) => {
  const db = await getUserDb();
  const now = Date.now();
  let newToken = null;
  if (req.sessionId) {
    run(db, 'UPDATE user_sessions SET revoked = 1 WHERE user_id = ? AND id != ? AND revoked = 0', [req.user.id, req.sessionId]);
  } else {
    run(db, 'UPDATE user_sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0', [req.user.id]);
    newToken = signToken(req.user.id, createSession(db, req.user.id, req));
  }
  run(db, 'UPDATE users SET tokens_invalid_before = ? WHERE id = ?', [now, req.user.id]);
  const keep = req.sessionId;
  disconnectSessions(req.user.id, sid => !keep || sid !== keep);
  res.json({ ok: true, token: newToken });
});

// ── Two-factor ─────────────────────────────────────────────────────
function backupCodeStatus(db, userId) {
  const row = get(db, 'SELECT COUNT(*) AS n FROM user_backup_codes WHERE user_id = ? AND used_at IS NULL', [userId]);
  return row ? row.n : 0;
}

function issueBackupCodes(db, userId) {
  run(db, 'DELETE FROM user_backup_codes WHERE user_id = ?', [userId]);
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const code = totp.generateBackupCode();
    codes.push(code);
    run(db, 'INSERT OR IGNORE INTO user_backup_codes (user_id, code_hash) VALUES (?, ?)', [userId, totp.hashBackupCode(code)]);
  }
  return codes;
}

router.get('/2fa', async (req, res) => {
  const db = await getUserDb();
  const u = get(db, 'SELECT totp_enabled FROM users WHERE id = ?', [req.user.id]);
  res.json({ enabled: !!(u && u.totp_enabled), backupCodesRemaining: backupCodeStatus(db, req.user.id) });
});

// Step 1: generate a secret (stored encrypted, not active yet).
router.post('/2fa/setup', async (req, res) => {
  const db = await getUserDb();
  const u = get(db, 'SELECT totp_enabled FROM users WHERE id = ?', [req.user.id]);
  if (u && u.totp_enabled) return res.status(400).json({ error: 'Authenticator is already enabled' });
  const secret = totp.generateSecret();
  run(db, 'UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', [totp.encryptSecret(secret), req.user.id]);
  res.json({ secret, otpauthUri: totp.otpauthUri(secret, req.user.username) });
});

// Step 2: prove the app works by entering a code; returns backup codes once.
router.post('/2fa/enable', async (req, res) => {
  const db = await getUserDb();
  const u = get(db, 'SELECT totp_secret, totp_enabled FROM users WHERE id = ?', [req.user.id]);
  if (!u || !u.totp_secret) return res.status(400).json({ error: 'Start setup first' });
  if (u.totp_enabled) return res.status(400).json({ error: 'Authenticator is already enabled' });
  if (totp.tooManyAttempts(req.user.id)) return res.status(429).json({ error: 'Too many wrong codes. Try again in a few minutes.' });
  let ok = false;
  try { ok = totp.verifyTotp(totp.decryptSecret(u.totp_secret), req.body && req.body.code); } catch (e) {}
  if (!ok) { totp.recordFailure(req.user.id); return res.status(400).json({ error: 'That code didn\'t match. Check your app and try again.' }); }
  totp.clearFailures(req.user.id);
  run(db, 'UPDATE users SET totp_enabled = 1 WHERE id = ?', [req.user.id]);
  res.json({ ok: true, backupCodes: issueBackupCodes(db, req.user.id) });
});

router.post('/2fa/disable', async (req, res) => {
  const db = await getUserDb();
  if (!(await checkPassword(db, req.user.id, req.body && req.body.password))) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  run(db, 'UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [req.user.id]);
  run(db, 'DELETE FROM user_backup_codes WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true });
});

router.post('/2fa/backup-codes', async (req, res) => {
  const db = await getUserDb();
  const u = get(db, 'SELECT totp_enabled FROM users WHERE id = ?', [req.user.id]);
  if (!u || !u.totp_enabled) return res.status(400).json({ error: 'Turn on an authenticator first — backup codes are its fallback.', needsAuthenticator: true });
  if (!(await checkPassword(db, req.user.id, req.body && req.body.password))) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  res.json({ backupCodes: issueBackupCodes(db, req.user.id) });
});

// ── Settings sync ──────────────────────────────────────────────────
function sanitizeSyncData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const keys = Object.keys(data);
  if (keys.length > 100) return null;
  const out = {};
  for (const k of keys) {
    if (!/^[A-Za-z0-9_:.-]{1,60}$/.test(k)) return null;
    if (typeof data[k] !== 'string' || data[k].length > 4000) return null;
    out[k] = data[k];
  }
  if (JSON.stringify(out).length > 32 * 1024) return null;
  return out;
}

router.get('/settings-sync', async (req, res) => {
  const db = await getUserDb();
  const row = get(db, 'SELECT data, updated_at FROM user_settings_sync WHERE user_id = ?', [req.user.id]);
  if (!row) return res.json({ data: null, updatedAt: null });
  let data = null;
  try { data = JSON.parse(row.data); } catch (e) {}
  res.json({ data, updatedAt: row.updated_at });
});

router.put('/settings-sync', async (req, res) => {
  const data = sanitizeSyncData(req.body && req.body.data);
  if (!data) return res.status(400).json({ error: 'Invalid settings payload' });
  const db = await getUserDb();
  const now = Date.now();
  run(db, 'INSERT INTO user_settings_sync (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
    [req.user.id, JSON.stringify(data), now]);
  res.json({ ok: true, updatedAt: now });
});

router.delete('/settings-sync', async (req, res) => {
  const db = await getUserDb();
  run(db, 'DELETE FROM user_settings_sync WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true });
});

// ── Feedback ───────────────────────────────────────────────────────
const FEEDBACK_CATEGORIES = ['bug', 'idea', 'other'];

router.post('/feedback', async (req, res) => {
  const { category, message, diagnostics } = req.body || {};
  if (!FEEDBACK_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Pick a category' });
  const text = typeof message === 'string' ? message.trim() : '';
  if (text.length < 10) return res.status(400).json({ error: 'Please write at least 10 characters' });
  if (text.length > 2000) return res.status(400).json({ error: 'Feedback must be 2000 characters or fewer' });
  const diag = typeof diagnostics === 'string' && diagnostics.trim() ? diagnostics.trim().slice(0, 500) : null;

  const db = await getUserDb();
  const recent = get(db, 'SELECT COUNT(*) AS n FROM user_feedback WHERE user_id = ? AND created_at > ?', [req.user.id, Date.now() - 60 * 60 * 1000]);
  if (recent && recent.n >= 5) return res.status(429).json({ error: 'You\'ve sent a lot of feedback recently — try again in a bit.' });

  const id = crypto.randomUUID();
  run(db, 'INSERT INTO user_feedback (id, user_id, category, message, diagnostics, status, created_at) VALUES (?, ?, ?, ?, ?, \'new\', ?)',
    [id, req.user.id, category, text, diag, Date.now()]);
  res.status(201).json({ ok: true, id });
});

router.get('/feedback', async (req, res) => {
  const db = await getUserDb();
  const rows = all(db, 'SELECT id, category, message, status, created_at FROM user_feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [req.user.id]);
  res.json({ feedback: rows.map(r => ({ id: r.id, category: r.category, message: r.message, status: r.status, createdAt: r.created_at })) });
});

// ── Bots (management only) ─────────────────────────────────────────
const MAX_BOTS = 10;

function newBotToken(botId) {
  return `nyxb.${botId}.${crypto.randomBytes(24).toString('base64url')}`;
}
function hashBotToken(token) {
  return crypto.createHmac('sha256', JWT_SECRET).update(token).digest('hex');
}
function publicBot(r) {
  return { id: r.id, name: r.name, description: r.description || '', tokenHint: r.token_hint, createdAt: r.created_at };
}
function cleanBotFields(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (name.length < 2 || name.length > 32) return { error: 'Bot name must be 2–32 characters' };
  if (description.length > 200) return { error: 'Description must be 200 characters or fewer' };
  return { name, description };
}

router.get('/bots', async (req, res) => {
  const db = await getUserDb();
  const rows = all(db, 'SELECT * FROM user_bots WHERE owner_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.json({ bots: rows.map(publicBot), max: MAX_BOTS });
});

router.post('/bots', async (req, res) => {
  const fields = cleanBotFields(req.body || {});
  if (fields.error) return res.status(400).json({ error: fields.error });
  const db = await getUserDb();
  const count = get(db, 'SELECT COUNT(*) AS n FROM user_bots WHERE owner_id = ?', [req.user.id]);
  if (count && count.n >= MAX_BOTS) return res.status(400).json({ error: `You can have up to ${MAX_BOTS} bots` });
  const id = crypto.randomUUID();
  const token = newBotToken(id);
  run(db, 'INSERT INTO user_bots (id, owner_id, name, description, token_hash, token_hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, req.user.id, fields.name, fields.description || null, hashBotToken(token), token.slice(-4), Date.now()]);
  const row = get(db, 'SELECT * FROM user_bots WHERE id = ?', [id]);
  res.status(201).json({ bot: publicBot(row), token }); // token is shown once
});

router.patch('/bots/:id', async (req, res) => {
  const fields = cleanBotFields(req.body || {});
  if (fields.error) return res.status(400).json({ error: fields.error });
  const db = await getUserDb();
  const row = get(db, 'SELECT id FROM user_bots WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'Bot not found' });
  run(db, 'UPDATE user_bots SET name = ?, description = ? WHERE id = ?', [fields.name, fields.description || null, row.id]);
  res.json({ bot: publicBot(get(db, 'SELECT * FROM user_bots WHERE id = ?', [row.id])) });
});

router.post('/bots/:id/reset-token', async (req, res) => {
  const db = await getUserDb();
  const row = get(db, 'SELECT id FROM user_bots WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'Bot not found' });
  const token = newBotToken(row.id);
  run(db, 'UPDATE user_bots SET token_hash = ?, token_hint = ? WHERE id = ?', [hashBotToken(token), token.slice(-4), row.id]);
  res.json({ token });
});

router.delete('/bots/:id', async (req, res) => {
  const db = await getUserDb();
  const row = get(db, 'SELECT id FROM user_bots WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'Bot not found' });
  run(db, 'DELETE FROM user_bots WHERE id = ?', [row.id]);
  res.json({ ok: true });
});

module.exports = router;
