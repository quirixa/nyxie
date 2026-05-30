const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb, all, get, run } = require('./db');
const { requireAuth } = require('./middleware');

router.get('/', requireAuth, async (req, res) => {
  const db = await getDb();
  const { server_id } = req.query;

  let rooms;
  if (server_id) {
    rooms = all(db, `
      SELECT r.id, r.name, r.description, r.created_at, r.is_dm,
             (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) AS member_count,
             (SELECT content FROM messages m WHERE m.room_id = r.id AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 1) AS last_message,
             (SELECT created_at FROM messages m WHERE m.room_id = r.id AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      WHERE r.server_id = ? AND r.is_dm = 0 AND rm.user_id = ?
      ORDER BY COALESCE(last_message_at, r.created_at) DESC
    `, [server_id, req.user.id]);
  } else {
    rooms = all(db, `
      SELECT r.id, r.name, r.description, r.created_at, r.is_dm,
             (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) AS member_count,
             (SELECT content FROM messages m WHERE m.room_id = r.id AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 1) AS last_message,
             (SELECT created_at FROM messages m WHERE m.room_id = r.id AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      WHERE r.is_dm = 1 AND rm.user_id = ?
      ORDER BY COALESCE(last_message_at, r.created_at) DESC
    `, [req.user.id]);
    for (const room of rooms) {
      const members = all(db, `SELECT user_id FROM room_members WHERE room_id = ?`, [room.id]);
      const other = members.find(m => m.user_id !== req.user.id);
      if (other) {
        const otherUser = get(db, 'SELECT display_name, username FROM users WHERE id = ?', [other.user_id]);
        room.display_name = otherUser ? (otherUser.display_name || otherUser.username) : 'Unknown';
        room._otherId = other.user_id;
      } else {
        room.display_name = room.name;
      }
    }
  }
  res.json({ rooms });
});

router.post('/dm', requireAuth, async (req, res) => {
  const db = await getDb();
  const { target_user_id } = req.body;
  if (!target_user_id) return res.status(400).json({ error: 'target_user_id required' });
  if (target_user_id === req.user.id) return res.status(400).json({ error: 'Cannot DM yourself' });

  const targetUser = get(db, 'SELECT id, username, display_name FROM users WHERE id = ?', [target_user_id]);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  const existing = get(db, `
    SELECT r.id FROM rooms r
    JOIN room_members rm1 ON rm1.room_id = r.id AND rm1.user_id = ?
    JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id = ?
    WHERE r.is_dm = 1
    AND (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) = 2
    LIMIT 1
  `, [req.user.id, target_user_id]);

  if (existing) return res.json({ room_id: existing.id });

  const roomId = uuidv4();
  const now = Date.now();
  run(db, 'INSERT INTO rooms (id, name, description, created_by, created_at, is_dm) VALUES (?, ?, ?, ?, ?, 1)',
    [roomId, `dm-${req.user.id}-${target_user_id}`, '', req.user.id, now]);
  run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [roomId, req.user.id, now]);
  run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [roomId, target_user_id, now]);

  res.status(201).json({ room_id: roomId });
});

router.get('/:id/messages', requireAuth, async (req, res) => {
  const db = await getDb();
  const isMember = get(db, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = req.query.before ? parseInt(req.query.before) : Date.now() + 1;

  const messages = all(db, `
    SELECT m.id, m.room_id, m.content, m.created_at, m.edited_at, m.deleted,
           u.id AS user_id, u.username, u.display_name
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.room_id = ? AND m.created_at < ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `, [req.params.id, before, limit]);

  res.json({ messages: messages.reverse() });
});

router.post('/:id/messages', requireAuth, async (req, res) => {
  const db = await getDb();
  const isMember = get(db, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });

  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message content required' });
  if (content.length > 4000) return res.status(400).json({ error: 'Message too long' });

  const msgId = uuidv4();
  const now = Date.now();
  run(db, 'INSERT INTO messages (id, room_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
    [msgId, req.params.id, req.user.id, content.trim(), now]);

  const message = {
    id: msgId,
    room_id: req.params.id,
    content: content.trim(),
    created_at: now,
    user_id: req.user.id,
    username: req.user.username,
    display_name: req.user.display_name
  };

  req.app.locals.broadcast(req.params.id, { type: 'new_message', message });
  res.status(201).json({ message });
});

router.patch('/:roomId/messages/:msgId', requireAuth, async (req, res) => {
  const db = await getDb();
  const msg = get(db, 'SELECT * FROM messages WHERE id = ? AND room_id = ?', [req.params.msgId, req.params.roomId]);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'Not your message' });
  if (msg.deleted) return res.status(400).json({ error: 'Cannot edit deleted message' });

  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });

  const now = Date.now();
  run(db, 'UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', [content.trim(), now, msg.id]);

  req.app.locals.broadcast(req.params.roomId, {
    type: 'message_edited',
    message_id: msg.id,
    content: content.trim(),
    edited_at: now
  });
  res.json({ ok: true });
});

router.delete('/:roomId/messages/:msgId', requireAuth, async (req, res) => {
  const db = await getDb();
  const msg = get(db, 'SELECT * FROM messages WHERE id = ? AND room_id = ?', [req.params.msgId, req.params.roomId]);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'Not your message' });

  run(db, 'UPDATE messages SET deleted = 1, content = \'[deleted]\' WHERE id = ?', [msg.id]);
  req.app.locals.broadcast(req.params.roomId, { type: 'message_deleted', message_id: msg.id });
  res.json({ ok: true });
});

router.post('/:id/leave', requireAuth, async (req, res) => {
  const db = await getDb();
  run(db, 'DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

module.exports = router;