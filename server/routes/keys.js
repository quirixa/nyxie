// server/routes/keys.js — public-key directory, key history and key rotation.
//
// Only PUBLIC keys live here, plus the user's own client-encrypted backup
// blobs (which the server cannot open). Contacts use the history to (a) see
// that a change was a deliberate, password-confirmed rotation and (b) read
// older messages that were wrapped to a since-retired key.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const router = express.Router();
const { getUserDb, all, get, run, transaction } = require('../database/userDb');
const { requireAuth } = require('../middleware/auth');

const B64_RE = /^[A-Za-z0-9+/=]+$/;
const isKey = k => typeof k === 'string' && B64_RE.test(k) && Buffer.from(k, 'base64').length === 32;

// GET /api/keys/:userId — current public key + every key it replaced.
router.get('/:userId', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const u = get(db, 'SELECT id, public_key FROM users WHERE id = ?', [req.params.userId]);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const history = all(db, 'SELECT public_key, created_at, retired_at, reason FROM key_history WHERE user_id = ? ORDER BY created_at ASC', [u.id]);
  res.json({ user_id: u.id, public_key: u.public_key || null, history });
});

// POST /api/keys/rotate — replace the account's identity key.
// Needs the account password (so a stolen session token cannot swap keys),
// and the new client-encrypted backup so other devices can restore it. The
// previous key is retired, not deleted: old messages stay readable.
router.post('/rotate', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { new_public_key, encrypted_private_key, key_salt, key_nonce, encrypted_key_history, key_history_nonce, current_password } = req.body || {};
  if (!isKey(new_public_key)) return res.status(400).json({ error: 'Invalid public key' });
  for (const f of [encrypted_private_key, key_salt, key_nonce]) {
    if (typeof f !== 'string' || !B64_RE.test(f) || f.length > 4096) return res.status(400).json({ error: 'Invalid encrypted key backup' });
  }
  if (encrypted_key_history !== undefined && encrypted_key_history !== null) {
    if (typeof encrypted_key_history !== 'string' || !B64_RE.test(encrypted_key_history) || encrypted_key_history.length > 65536 ||
        typeof key_history_nonce !== 'string' || !B64_RE.test(key_history_nonce) || key_history_nonce.length > 256) {
      return res.status(400).json({ error: 'Invalid key history backup' });
    }
  }
  const user = get(db, 'SELECT password_hash, public_key FROM users WHERE id = ?', [req.user.id]);
  if (typeof current_password !== 'string' || !user || !(await bcrypt.compare(current_password, user.password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (user.public_key === new_public_key) return res.status(400).json({ error: 'That is already your key' });

  const now = Date.now();
  transaction(db, () => {
    if (user.public_key) run(db, 'UPDATE key_history SET retired_at = ? WHERE user_id = ? AND public_key = ? AND retired_at IS NULL', [now, req.user.id, user.public_key]);
    run(db, 'INSERT OR IGNORE INTO key_history (id, user_id, public_key, created_at, reason) VALUES (?, ?, ?, ?, ?)', [crypto.randomUUID(), req.user.id, new_public_key, now, 'rotation']);
    run(db, `UPDATE users SET public_key = ?, encrypted_private_key = ?, key_salt = ?, key_nonce = ?,
               encrypted_key_history = ?, key_history_nonce = ? WHERE id = ?`,
      [new_public_key, encrypted_private_key, key_salt, key_nonce, encrypted_key_history || null, encrypted_key_history ? key_history_nonce : null, req.user.id]);
  });

  // Tell everyone this person shares a conversation or friendship with, so
  // their clients flag "key changed" instead of silently trusting it.
  const peers = new Set(all(db, `
    SELECT DISTINCT rm2.user_id AS id FROM room_members rm1
    JOIN room_members rm2 ON rm2.room_id = rm1.room_id AND rm2.user_id != rm1.user_id
    JOIN rooms r ON r.id = rm1.room_id AND r.is_dm = 1
    WHERE rm1.user_id = ?`, [req.user.id]).map(r => r.id));
  all(db, `SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id FROM friends WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'`,
    [req.user.id, req.user.id, req.user.id]).forEach(r => peers.add(r.id));
  for (const id of peers) req.app.locals.broadcastToUser(id, { type: 'key_changed', user_id: req.user.id });
  req.app.locals.broadcastToUser(req.user.id, { type: 'key_changed', user_id: req.user.id });
  res.json({ ok: true, public_key: new_public_key });
});

module.exports = router;
