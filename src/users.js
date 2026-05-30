const express = require('express');
const router = express.Router();
const { getDb, all, get, run } = require('./db');
const { requireAuth } = require('./middleware');

router.get('/search', requireAuth, async (req, res) => {
  const db = await getDb();
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  const users = all(db, `
    SELECT id, username, display_name, last_seen, status
    FROM users
    WHERE (username LIKE ? OR display_name LIKE ?) AND id != ?
    LIMIT 20
  `, [`%${q}%`, `%${q}%`, req.user.id]);
  res.json({ users });
});

router.get('/:id', requireAuth, async (req, res) => {
  const db = await getDb();
  const user = get(db, 'SELECT id, username, display_name, status, created_at, last_seen FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

router.patch('/me', requireAuth, async (req, res) => {
  const db = await getDb();
  const { display_name } = req.body;
  if (!display_name || !display_name.trim()) return res.status(400).json({ error: 'display_name required' });
  const trimmed = display_name.trim();
  if (trimmed.length > 64) return res.status(400).json({ error: 'Display name too long' });
  run(db, 'UPDATE users SET display_name = ? WHERE id = ?', [trimmed, req.user.id]);
  res.json({ ok: true, display_name: trimmed });
});

router.patch('/status', requireAuth, async (req, res) => {
  const db = await getDb();
  const { status } = req.body;
  const allowed = ['online', 'idle', 'dnd', 'offline'];
  if (!status || !allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  run(db, 'UPDATE users SET status = ?, status_updated_at = ? WHERE id = ?',
      [status, Date.now(), req.user.id]);
  res.json({ ok: true, status });
});

module.exports = router;