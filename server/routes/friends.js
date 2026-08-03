const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getUserDb, all, get, run } = require('../database/userDb');
const { requireAuth } = require('../middleware/auth');

// GET /api/friends — list accepted friends (with avatars)
router.get('/', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const friends = all(db, `
    SELECT u.id, u.username, u.display_name, u.avatar, u.status, u.last_seen
    FROM friends f
    JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
    WHERE (f.user_a = ? OR f.user_b = ?) AND f.status = 'accepted'
  `, [req.user.id, req.user.id, req.user.id]);
  res.json({ friends });
});

// GET /api/friends/requests — pending requests (incoming + outgoing) with avatars
router.get('/requests', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const incoming = all(db, `
    SELECT fr.id, fr.from_id, fr.created_at,
           u.username AS from_username, u.display_name AS from_name, u.avatar AS from_avatar
    FROM friend_requests fr
    JOIN users u ON u.id = fr.from_id
    WHERE fr.to_id = ? AND fr.status = 'pending'
    ORDER BY fr.created_at DESC
  `, [req.user.id]);
  const outgoing = all(db, `
    SELECT fr.id, fr.to_id, fr.created_at,
           u.username AS to_username, u.display_name AS to_name, u.avatar AS to_avatar
    FROM friend_requests fr
    JOIN users u ON u.id = fr.to_id
    WHERE fr.from_id = ? AND fr.status = 'pending'
    ORDER BY fr.created_at DESC
  `, [req.user.id]);
  res.json({ incoming, outgoing });
});

// POST /api/friends/request — send a friend request
router.post('/request', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { to_id } = req.body;
  if (!to_id) return res.status(400).json({ error: 'to_id required' });
  if (to_id === req.user.id) return res.status(400).json({ error: 'Cannot friend yourself' });

  const target = get(db, 'SELECT id, username, display_name, avatar FROM users WHERE id = ?', [to_id]);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const already = get(db, `
    SELECT 1 FROM friends
    WHERE ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)) AND status = 'accepted'
  `, [req.user.id, to_id, to_id, req.user.id]);
  if (already) return res.status(409).json({ error: 'Already friends' });

  const pending = get(db, `
    SELECT id, from_id FROM friend_requests
    WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND status = 'pending'
  `, [req.user.id, to_id, to_id, req.user.id]);
  if (pending) {
    if (pending.from_id === to_id) {
      run(db, 'UPDATE friend_requests SET status = ? WHERE id = ?', ['accepted', pending.id]);
      const friendId = crypto.randomUUID();
      run(db, 'INSERT OR IGNORE INTO friends (id, user_a, user_b, status, created_at) VALUES (?, ?, ?, \'accepted\', ?)',
          [friendId, req.user.id, to_id, Date.now()]);
      // Fetch the friend's full profile (including avatar)
      const me = get(db, 'SELECT id, username, display_name, avatar, status, last_seen FROM users WHERE id = ?', [req.user.id]);
      req.app.locals.broadcastToUser(to_id, { type: 'friend_accepted', request_id: pending.id, friend: me });
      return res.json({ ok: true, auto_accepted: true });
    }
    return res.status(409).json({ error: 'Request already sent' });
  }

  const reqId = crypto.randomUUID();
  run(db, 'INSERT INTO friend_requests (id, from_id, to_id, status, created_at) VALUES (?, ?, ?, \'pending\', ?)',
      [reqId, req.user.id, to_id, Date.now()]);

  // Send the request notification with avatar
  const fromUser = get(db, 'SELECT id, username, display_name, avatar FROM users WHERE id = ?', [req.user.id]);
  req.app.locals.broadcastToUser(to_id, {
    type: 'friend_request',
    request: {
      id: reqId,
      from_id: req.user.id,
      created_at: Date.now(),
      from_username: fromUser.username,
      from_name: fromUser.display_name,
      from_avatar: fromUser.avatar
    }
  });
  res.status(201).json({ ok: true, request_id: reqId });
});

// POST /api/friends/requests/:id/accept
router.post('/requests/:id/accept', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const fr = get(db, 'SELECT * FROM friend_requests WHERE id = ? AND to_id = ? AND status = ?',
      [req.params.id, req.user.id, 'pending']);
  if (!fr) return res.status(404).json({ error: 'Request not found' });

  run(db, 'UPDATE friend_requests SET status = ? WHERE id = ?', ['accepted', fr.id]);
  const friendId = crypto.randomUUID();
  run(db, 'INSERT OR IGNORE INTO friends (id, user_a, user_b, status, created_at) VALUES (?, ?, ?, \'accepted\', ?)',
      [friendId, fr.from_id, fr.to_id, Date.now()]);

  const me = get(db, 'SELECT id, username, display_name, avatar, status, last_seen FROM users WHERE id = ?', [req.user.id]);
  req.app.locals.broadcastToUser(fr.from_id, { type: 'friend_accepted', request_id: fr.id, friend: me });
  res.json({ ok: true });
});

// POST /api/friends/requests/:id/decline
router.post('/requests/:id/decline', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const fr = get(db, 'SELECT * FROM friend_requests WHERE id = ? AND to_id = ? AND status = ?',
      [req.params.id, req.user.id, 'pending']);
  if (!fr) return res.status(404).json({ error: 'Request not found' });
  run(db, 'UPDATE friend_requests SET status = ? WHERE id = ?', ['declined', fr.id]);
  req.app.locals.broadcastToUser(fr.from_id, { type: 'friend_request_declined', request_id: fr.id });
  res.json({ ok: true });
});

// DELETE /api/friends/requests/:id — cancel outgoing request
router.delete('/requests/:id', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const fr = get(db, 'SELECT * FROM friend_requests WHERE id = ? AND from_id = ? AND status = ?',
      [req.params.id, req.user.id, 'pending']);
  if (!fr) return res.status(404).json({ error: 'Request not found' });
  run(db, 'UPDATE friend_requests SET status = ? WHERE id = ?', ['cancelled', fr.id]);
  req.app.locals.broadcastToUser(fr.to_id, { type: 'friend_request_cancelled', request_id: fr.id });
  res.json({ ok: true });
});

// DELETE /api/friends/:id — remove friend
router.delete('/:id', requireAuth, async (req, res) => {
  const db = await getUserDb();
  run(db, `
    DELETE FROM friends
    WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)
  `, [req.user.id, req.params.id, req.params.id, req.user.id]);
  req.app.locals.broadcastToUser(req.params.id, { type: 'friend_removed', user_id: req.user.id });
  res.json({ ok: true });
});

module.exports = router;