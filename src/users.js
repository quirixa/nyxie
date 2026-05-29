const express = require('express');
const router = express.Router();
const { getDb, all, get, run } = require('./db');
const { requireAuth } = require('./middleware');

// GET /api/users/search?q=
router.get('/search', requireAuth, async (req, res) => {
  const db = await getDb();
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  const users = all(db, `
    SELECT id, username, display_name, last_seen
    FROM users
    WHERE (username LIKE ? OR display_name LIKE ?) AND id != ?
    LIMIT 20
  `, [`%${q}%`, `%${q}%`, req.user.id]);
  res.json({ users });
});

// GET /api/users/:id
router.get('/:id', requireAuth, async (req, res) => {
  const db = await getDb();
  const user = get(db, 'SELECT id, username, display_name, created_at, last_seen FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// PATCH /api/users/me  - update display name
router.patch('/me', requireAuth, async (req, res) => {
  const db = await getDb();
  const { display_name } = req.body;
  if (!display_name || !display_name.trim()) return res.status(400).json({ error: 'display_name required' });
  const trimmed = display_name.trim();
  if (trimmed.length > 64) return res.status(400).json({ error: 'Display name too long' });
  run(db, 'UPDATE users SET display_name = ? WHERE id = ?', [trimmed, req.user.id]);
  res.json({ ok: true, display_name: trimmed });
});

module.exports = router;