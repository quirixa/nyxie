const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { getUserDb, all, get, run } = require('./userDb');
const { requireAuth } = require('./middleware');

// Ensure avatar directory exists
const AVATAR_DIR = path.join(__dirname, '..', 'data', 'avatars');
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

// Configure multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = req.user.id + '-' + Date.now() + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// GET /api/users/search
router.get('/search', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  const users = all(db, `
    SELECT id, username, display_name, avatar, bio, last_seen, status
    FROM users
    WHERE (username LIKE ? OR display_name LIKE ?) AND id != ?
    LIMIT 20
  `, [`%${q}%`, `%${q}%`, req.user.id]);
  res.json({ users });
});

// GET /api/users/:id
router.get('/:id', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const user = get(db, 'SELECT id, username, display_name, avatar, bio, status, created_at, last_seen FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// PATCH /api/users/me – update profile (username, display_name, bio, password)
router.patch('/me', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { username, display_name, bio, current_password, new_password } = req.body;
  const userId = req.user.id;

  // Start building updates
  const updates = [];
  const params = [];

  // Username change
  if (username !== undefined) {
    const trimmed = username.trim();
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(trimmed)) {
      return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, _ or -).' });
    }
    const reserved = ['admin', 'root', 'system', 'nyxie', 'support'];
    if (reserved.includes(trimmed.toLowerCase())) {
      return res.status(400).json({ error: 'Username not available' });
    }
    // Check uniqueness
    const existing = get(db, 'SELECT id FROM users WHERE username = ? AND id != ?', [trimmed, userId]);
    if (existing) return res.status(409).json({ error: 'Username already taken' });
    updates.push('username = ?');
    params.push(trimmed);
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

  // Password change
  if (current_password !== undefined || new_password !== undefined) {
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Both current and new password are required to change password' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    // Verify current password
    const user = get(db, 'SELECT password_hash FROM users WHERE id = ?', [userId]);
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const newHash = await bcrypt.hash(new_password, 10);
    updates.push('password_hash = ?');
    params.push(newHash);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  params.push(userId);
  const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
  run(db, sql, params);

  // Fetch updated user to return
  const updated = get(db, 'SELECT id, username, display_name, avatar, bio, status FROM users WHERE id = ?', [userId]);
  res.json({ ok: true, user: updated });
});

// PATCH /api/users/status – only online/offline
router.patch('/status', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { status } = req.body;
  const allowed = ['online', 'offline'];
  if (!status || !allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  run(db, 'UPDATE users SET status = ?, status_updated_at = ? WHERE id = ?',
      [status, Date.now(), req.user.id]);
  res.json({ ok: true, status });
});

// POST /api/users/avatar – upload avatar
router.post('/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }
  const avatarPath = '/avatars/' + req.file.filename;
  const db = await getUserDb();
  // Delete old avatar if exists
  const oldUser = get(db, 'SELECT avatar FROM users WHERE id = ?', [req.user.id]);
  if (oldUser && oldUser.avatar) {
    const oldPath = path.join(__dirname, '..', 'public', oldUser.avatar);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  run(db, 'UPDATE users SET avatar = ? WHERE id = ?', [avatarPath, req.user.id]);
  req.user.avatar = avatarPath;
  res.json({ ok: true, avatar: avatarPath });
});

module.exports = router;