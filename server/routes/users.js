const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { getUserDb, all, get, run } = require('../database/userDb');
const { getMessageDb, runMessage } = require('../database/messageDb');
const { requireAuth } = require('../middleware/auth');
const { hasBlocked } = require('../services/blocks');
const { isReservedUsername } = require('../services/reservedUsernames');
const { STATUSES, effectiveStatus } = require('../services/presence');
const { assertCanEquip, CosmeticsError } = require('../services/cosmetics');

// ─── Paths ──────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '../..'); // because this file is in server/routes/
const { DATA_DIR } = require('../config/paths');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const BANNER_DIR = path.join(DATA_DIR, 'banners');

// Ensure directories exist
[AVATAR_DIR, BANNER_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Multer config for avatars ─────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, req.user.id + '-' + Date.now() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// ─── Multer config for banners ─────────────────────────────
const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BANNER_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, req.user.id + '-' + Date.now() + ext);
  }
});
const uploadBanner = multer({
  storage: bannerStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// ─── Routes ──────────────────────────────────────────────────

// GET /api/users/search
router.get('/search', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  const users = all(db, `
    SELECT id, username, display_name, avatar, banner, banner_color, bio, pronouns, avatar_decoration, card_decoration, profile_effect, role, public_key, status
    FROM users
    WHERE (username LIKE ? OR display_name LIKE ?) AND id != ?
    LIMIT 20
  `, [`%${q}%`, `%${q}%`, req.user.id]);
  const isUserConnected = req.app.locals.isUserConnected || (() => false);
  users.forEach(u => { u.status = effectiveStatus(u.status, { connected: isUserConnected(u.id), isSelf: false }); });
  res.json({ users });
});

// GET /api/users/:id
router.get('/:id', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const user = get(db, `
    SELECT id, username, display_name, avatar, banner, banner_color, bio, pronouns, avatar_decoration, card_decoration, profile_effect, role, public_key, status, created_at
    FROM users WHERE id = ?
  `, [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Only reveal that *I* blocked them, never whether they blocked me —
  // Discord-style, so blocking someone doesn't tip them off.
  user.is_blocked = hasBlocked(db, req.user.id, req.params.id);
  const isSelf = req.params.id === req.user.id;
  const isUserConnected = req.app.locals.isUserConnected || (() => false);
  user.status = effectiveStatus(user.status, { connected: isUserConnected(user.id), isSelf });
  res.json({ user });
});

// ─── AVATAR UPLOAD ──────────────────────────────────────────
router.post('/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    const avatarPath = '/avatars/' + req.file.filename;
    const db = await getUserDb();

    // Delete old avatar
    const oldUser = get(db, 'SELECT avatar FROM users WHERE id = ?', [req.user.id]);
    if (oldUser && oldUser.avatar) {
      const oldPath = path.join(AVATAR_DIR, path.basename(oldUser.avatar));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    run(db, 'UPDATE users SET avatar = ? WHERE id = ?', [avatarPath, req.user.id]);

    res.status(200).json({ ok: true, avatar: avatarPath });
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

// ─── BANNER UPLOAD ──────────────────────────────────────────
router.post('/banner', requireAuth, uploadBanner.single('banner'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    const bannerPath = '/banners/' + req.file.filename;
    const db = await getUserDb();

    // Delete old banner
    const oldUser = get(db, 'SELECT banner FROM users WHERE id = ?', [req.user.id]);
    if (oldUser && oldUser.banner) {
      const oldPath = path.join(BANNER_DIR, path.basename(oldUser.banner));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    run(db, 'UPDATE users SET banner = ?, banner_color = NULL WHERE id = ?', [bannerPath, req.user.id]);

    res.status(200).json({ ok: true, banner: bannerPath });
  } catch (err) {
    console.error('Banner upload error:', err);
    res.status(500).json({ error: 'Failed to upload banner' });
  }
});

// ─── DELETE BANNER ──────────────────────────────────────────
router.delete('/banner', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const oldUser = get(db, 'SELECT banner FROM users WHERE id = ?', [req.user.id]);
  if (oldUser && oldUser.banner) {
    const oldPath = path.join(BANNER_DIR, path.basename(oldUser.banner));
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  run(db, 'UPDATE users SET banner = NULL, banner_color = NULL WHERE id = ?', [req.user.id]);
  res.json({ ok: true });
});

// ─── UPDATE PROFILE (PATCH /me) ────────────────────────────
router.patch('/me', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { username, email, display_name, bio, pronouns, avatar_decoration, card_decoration, profile_effect, banner_color, public_key, encrypted_private_key, key_salt, key_nonce, current_password, new_password } = req.body;
  const userId = req.user.id;

  const updates = [];
  const params = [];

  // Username change
  if (username !== undefined) {
    const trimmed = username.trim();
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(trimmed)) {
      return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, _ or -).' });
    }
    if (isReservedUsername(trimmed)) {
      return res.status(400).json({ error: 'Username not available' });
    }
    const existing = get(db, 'SELECT id FROM users WHERE username = ? AND id != ?', [trimmed, userId]);
    if (existing) return res.status(409).json({ error: 'Username already taken' });
    updates.push('username = ?');
    params.push(trimmed);
  }

  // Email change
  if (email !== undefined) {
    const trimmedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    const existingEmail = get(db, 'SELECT id FROM users WHERE email = ? AND id != ?', [trimmedEmail, userId]);
    if (existingEmail) return res.status(409).json({ error: 'Email already registered' });
    updates.push('email = ?');
    params.push(trimmedEmail);
  }

  // Display name
  if (display_name !== undefined) {
    const trimmed = display_name.trim();
    if (trimmed.length > 64) return res.status(400).json({ error: 'Display name too long (max 64)' });
    updates.push('display_name = ?');
    params.push(trimmed || req.user.username);
  }

  // Bio
  if (bio !== undefined) {
    const trimmed = bio.trim();
    if (trimmed.length > 500) return res.status(400).json({ error: 'Bio too long (max 500 chars)' });
    updates.push('bio = ?');
    params.push(trimmed || null);
  }

  // Pronouns — free text like Discord's, optional, shown under the
  // username in the profile popout. No fixed list: people fill in
  // whatever they want here.
  if (pronouns !== undefined) {
    const trimmed = pronouns.trim();
    if (trimmed.length > 40) return res.status(400).json({ error: 'Pronouns too long (max 40 chars)' });
    updates.push('pronouns = ?');
    params.push(trimmed || null);
  }

  // Avatar + card decorations — cosmetic, but NX-gated: a user can only
  // equip an item they bought in the shop (or 'none' to unequip). The id
  // must also exist in the server-side catalog, so clients can't inject
  // arbitrary class names/assets into profile rendering.
  for (const [type, value] of [['avatar_decoration', avatar_decoration], ['card_decoration', card_decoration]]) {
    if (value === undefined) continue;
    try {
      assertCanEquip(db, userId, type, value);
    } catch (e) {
      if (e instanceof CosmeticsError) return res.status(e.status).json({ error: e.message, code: e.code });
      throw e;
    }
    updates.push(`${type} = ?`);
    params.push(value);
  }

  // Profile effect (ring + sparkles) — bought in the shop like the decorations.
  // 'none' (or false) unequips; anything else must be an owned profile_effect
  // item. Stored as the 0/1 flag users.profile_effect.
  if (profile_effect !== undefined) {
    const effectValue = (profile_effect === false || profile_effect === 0 || profile_effect === null) ? 'none' : String(profile_effect);
    try {
      assertCanEquip(db, userId, 'profile_effect', effectValue);
    } catch (e) {
      if (e instanceof CosmeticsError) return res.status(e.status).json({ error: e.message, code: e.code });
      throw e;
    }
    updates.push('profile_effect = ?');
    params.push(effectValue === 'none' ? 0 : 1);
  }

  // The Sparkle Ring and an avatar decoration are mutually exclusive: only one
  // of them can be equipped at a time. Equipping one unequips the other.
  {
    const effectOn = profile_effect !== undefined && !(profile_effect === false || profile_effect === 0 || profile_effect === null || profile_effect === 'none');
    const decoOn = avatar_decoration !== undefined && avatar_decoration !== 'none';
    if (effectOn && decoOn) {
      return res.status(400).json({ error: 'Pick either the Sparkle Ring or an avatar decoration, not both' });
    }
    if (effectOn && avatar_decoration === undefined) { updates.push('avatar_decoration = ?'); params.push('none'); }
    if (decoOn && profile_effect === undefined) { updates.push('profile_effect = ?'); params.push(0); }
  }

  // Banner color
  if (banner_color !== undefined) {
    const trimmed = (banner_color || '').trim();
    const isHex = /^#[0-9a-fA-F]{3,8}$/.test(trimmed);
    const isRgb = /^rgba?\([\d.,\s%]+\)$/.test(trimmed);
    if (trimmed && !isHex && !isRgb) {
      return res.status(400).json({ error: 'Invalid banner color' });
    }
    updates.push('banner_color = ?');
    params.push(trimmed || null);
    if (trimmed) {
      const oldUser = get(db, 'SELECT banner FROM users WHERE id = ?', [userId]);
      if (oldUser && oldUser.banner) {
        const oldPath = path.join(BANNER_DIR, path.basename(oldUser.banner));
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      updates.push('banner = ?');
      params.push(null);
    }
  }

  // Public key (E2EE)
  if (public_key !== undefined) {
    if (typeof public_key !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(public_key)) {
      return res.status(400).json({ error: 'Invalid public key format' });
    }
    updates.push('public_key = ?');
    params.push(public_key);
  }

  // Encrypted private key bundle
  const keyBundleFields = [encrypted_private_key, key_salt, key_nonce];
  const keyBundleProvided = keyBundleFields.some(f => f !== undefined);
  if (keyBundleProvided) {
    if (keyBundleFields.some(f => f === undefined)) {
      return res.status(400).json({ error: 'encrypted_private_key, key_salt and key_nonce must be provided together' });
    }
    const b64 = /^[A-Za-z0-9+/=]+$/;
    if (typeof encrypted_private_key !== 'string' || !b64.test(encrypted_private_key) || encrypted_private_key.length > 4096) {
      return res.status(400).json({ error: 'Invalid encrypted_private_key format' });
    }
    if (typeof key_salt !== 'string' || !b64.test(key_salt) || key_salt.length > 256) {
      return res.status(400).json({ error: 'Invalid key_salt format' });
    }
    if (typeof key_nonce !== 'string' || !b64.test(key_nonce) || key_nonce.length > 256) {
      return res.status(400).json({ error: 'Invalid key_nonce format' });
    }
    updates.push('encrypted_private_key = ?', 'key_salt = ?', 'key_nonce = ?');
    params.push(encrypted_private_key, key_salt, key_nonce);
  }

  // Password change
  if (new_password !== undefined) {
    if (!current_password) {
      return res.status(400).json({ error: 'Current password is required to change password' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const user = get(db, 'SELECT password_hash, encrypted_private_key FROM users WHERE id = ?', [userId]);
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (user.encrypted_private_key && !keyBundleProvided) {
      return res.status(400).json({ error: 'Password change must include a re-encrypted private key bundle' });
    }
    const newHash = await bcrypt.hash(new_password, 10);
    updates.push('password_hash = ?');
    params.push(newHash);
  } else if (email !== undefined) {
    // Email changes require current password
    if (!current_password) {
      return res.status(400).json({ error: 'Current password is required to change email' });
    }
    const user = get(db, 'SELECT password_hash FROM users WHERE id = ?', [userId]);
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  params.push(userId);
  const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
  run(db, sql, params);

  const updated = get(db, 'SELECT id, username, email, display_name, avatar, banner, banner_color, bio, pronouns, avatar_decoration, card_decoration, profile_effect, role, public_key, encrypted_private_key, key_salt, key_nonce, status FROM users WHERE id = ?', [userId]);
  // Tell every connected client (including this user's other sessions)
  // that this profile's cosmetics changed, so open profile cards update
  // live. Carries only public cosmetic ids — same approach as the
  // 'badges_updated' event in routes/adminBadges.js.
  if ((avatar_decoration !== undefined || card_decoration !== undefined || profile_effect !== undefined) && typeof req.app.locals.broadcastAll === 'function') {
    req.app.locals.broadcastAll({
      type: 'profile_updated',
      user_id: userId,
      avatar_decoration: updated.avatar_decoration || 'none',
      card_decoration: updated.card_decoration || 'none',
      profile_effect: updated.profile_effect ? 1 : 0,
    });
  }
  res.json({ ok: true, user: updated });
});

// ─── STATUS UPDATE ─────────────────────────────────────────
router.patch('/status', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { status } = req.body;
  if (!status || !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  run(db, 'UPDATE users SET status = ?, status_updated_at = ? WHERE id = ?',
      [status, Date.now(), req.user.id]);
  // The client also pushes this over the WebSocket (see set_status in
  // server/websocket/index.js), which is what actually reaches other
  // connected clients in real time — this broadcast is just a fallback
  // for the (rare) case where this REST call lands without a live socket,
  // so a friend polling the REST endpoints isn't stuck with a stale value.
  if (typeof req.app.locals.broadcastPresenceChange === 'function') {
    req.app.locals.broadcastPresenceChange(req.user.id, status);
  }
  res.json({ ok: true, status });
});

// ─── DISABLE ACCOUNT ────────────────────────────────────────
router.post('/disable', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required' });
  const user = get(db, 'SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Incorrect password' });
  run(db, "UPDATE users SET disabled = 1, status = 'offline' WHERE id = ?", [req.user.id]);
  res.json({ ok: true });
});

// ─── DELETE ACCOUNT (PERMANENT) ────────────────────────────
router.delete('/me', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { password, delete_messages = false } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password is required' });
  }

  const user = get(db, 'SELECT password_hash, avatar, banner FROM users WHERE id = ?', [req.user.id]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Verify password
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const userId = req.user.id;

  // Delete avatar/banner files
  if (user.avatar) {
    const avatarPath = path.join(AVATAR_DIR, path.basename(user.avatar));
    try { if (fs.existsSync(avatarPath)) fs.unlinkSync(avatarPath); } catch (e) {}
  }
  if (user.banner) {
    const bannerPath = path.join(BANNER_DIR, path.basename(user.banner));
    try { if (fs.existsSync(bannerPath)) fs.unlinkSync(bannerPath); } catch (e) {}
  }

  // Delete messages if requested
  if (delete_messages) {
    const msgDb = await getMessageDb();
    runMessage(msgDb, 'DELETE FROM messages WHERE user_id = ?', [userId]);
  }

  // Remove all memberships and relationships
  run(db, 'DELETE FROM room_members WHERE user_id = ?', [userId]);
  run(db, 'DELETE FROM server_members WHERE user_id = ?', [userId]);
  run(db, 'DELETE FROM friends WHERE user_a = ? OR user_b = ?', [userId, userId]);
  run(db, 'DELETE FROM friend_requests WHERE from_id = ? OR to_id = ?', [userId, userId]);
  run(db, 'DELETE FROM user_badges WHERE user_id = ?', [userId]);

  // Finally delete the user
  run(db, 'DELETE FROM users WHERE id = ?', [userId]);

  res.json({ ok: true, message: 'Account deleted successfully' });
});

module.exports = router;