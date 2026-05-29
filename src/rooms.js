const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb, all, get, run } = require('./db');
const { requireAuth } = require('./middleware');

// GET /api/rooms  - list rooms user is a member of
router.get('/', requireAuth, async (req, res) => {
  const db = await getDb();
  const rooms = all(db, `
    SELECT r.id, r.name, r.description, r.created_at, r.is_dm,
           (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) AS member_count,
           (SELECT content FROM messages m WHERE m.room_id = r.id AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 1) AS last_message,
           (SELECT created_at FROM messages m WHERE m.room_id = r.id AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
    FROM rooms r
    JOIN room_members rm ON rm.room_id = r.id
    WHERE rm.user_id = ?
    ORDER BY COALESCE(last_message_at, r.created_at) DESC
  `, [req.user.id]);

  // Enhance DM rooms with a display_name (the other participant's name)
  for (const room of rooms) {
    if (room.is_dm) {
      // Get all members of this DM room
      const members = all(db, `
        SELECT user_id FROM room_members WHERE room_id = ?
      `, [room.id]);
      // Find the member that is NOT the current user
      const other = members.find(m => m.user_id !== req.user.id);
      if (other) {
        const otherUser = get(db, 'SELECT display_name, username FROM users WHERE id = ?', [other.user_id]);
        room.display_name = otherUser ? (otherUser.display_name || otherUser.username) : 'Unknown';
      } else {
        room.display_name = room.name; // fallback
      }
    } else {
      room.display_name = room.name; // regular channels use the name as is
    }
  }

  res.json({ rooms });
});

// GET /api/rooms/public - list all non-DM rooms
router.get('/public', requireAuth, async (req, res) => {
  const db = await getDb();
  const rooms = all(db, `
    SELECT r.id, r.name, r.description, r.created_at,
           (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) AS member_count,
           (CASE WHEN rm2.user_id IS NOT NULL THEN 1 ELSE 0 END) AS is_member
    FROM rooms r
    LEFT JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id = ?
    WHERE r.is_dm = 0
    ORDER BY member_count DESC
  `, [req.user.id]);
  res.json({ rooms });
});

// POST /api/rooms  - create a new room
router.post('/', requireAuth, async (req, res) => {
  const db = await getDb();
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Room name required' });

  const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  if (cleanName.length < 2 || cleanName.length > 32) {
    return res.status(400).json({ error: 'Room name must be 2-32 characters' });
  }

  const existing = get(db, 'SELECT id FROM rooms WHERE name = ?', [cleanName]);
  if (existing) return res.status(409).json({ error: 'Room name already taken' });

  const roomId = uuidv4();
  const now = Date.now();
  run(db, 'INSERT INTO rooms (id, name, description, created_by, created_at, is_dm) VALUES (?, ?, ?, ?, ?, 0)',
    [roomId, cleanName, description || '', req.user.id, now]);
  run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)',
    [roomId, req.user.id, now]);

  res.status(201).json({ room: { id: roomId, name: cleanName, description: description || '' } });
});

// POST /api/rooms/:id/join
router.post('/:id/join', requireAuth, async (req, res) => {
  const db = await getDb();
  const room = get(db, 'SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_dm) return res.status(403).json({ error: 'Cannot join DM rooms' });
  run(db, 'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)',
    [req.params.id, req.user.id, Date.now()]);
  res.json({ ok: true });
});

// POST /api/rooms/:id/leave
router.post('/:id/leave', requireAuth, async (req, res) => {
  const db = await getDb();
  run(db, 'DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// GET /api/rooms/:id/members
router.get('/:id/members', requireAuth, async (req, res) => {
  const db = await getDb();
  const isMember = get(db, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });
  const members = all(db, `
    SELECT u.id, u.username, u.display_name, u.last_seen
    FROM users u
    JOIN room_members rm ON rm.user_id = u.id
    WHERE rm.room_id = ?
    ORDER BY u.username
  `, [req.params.id]);
  res.json({ members });
});

// GET /api/rooms/:id/messages?before=<ts>&limit=50
router.get('/:id/messages', requireAuth, async (req, res) => {
  const db = await getDb();
  const isMember = get(db, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this room' });

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

// POST /api/rooms/:id/messages
router.post('/:id/messages', requireAuth, async (req, res) => {
  const db = await getDb();
  const isMember = get(db, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this room' });

  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message content required' });
  if (content.length > 4000) return res.status(400).json({ error: 'Message too long (max 4000 chars)' });

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

  // Notify WebSocket clients
  req.app.locals.broadcast(req.params.id, { type: 'new_message', message });

  res.status(201).json({ message });
});

// PATCH /api/rooms/:roomId/messages/:msgId  - edit
router.patch('/:roomId/messages/:msgId', requireAuth, async (req, res) => {
  const db = await getDb();
  const msg = get(db, 'SELECT * FROM messages WHERE id = ? AND room_id = ?', [req.params.msgId, req.params.roomId]);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'Not your message' });
  if (msg.deleted) return res.status(400).json({ error: 'Cannot edit deleted message' });

  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });

  const now = Date.now();
  run(db, 'UPDATE messages SET content = ?, edited_at = ? WHERE id = ?',
    [content.trim(), now, msg.id]);

  req.app.locals.broadcast(req.params.roomId, {
    type: 'message_edited',
    message_id: msg.id,
    content: content.trim(),
    edited_at: now
  });

  res.json({ ok: true });
});

// DELETE /api/rooms/:roomId/messages/:msgId
router.delete('/:roomId/messages/:msgId', requireAuth, async (req, res) => {
  const db = await getDb();
  const msg = get(db, 'SELECT * FROM messages WHERE id = ? AND room_id = ?', [req.params.msgId, req.params.roomId]);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'Not your message' });

  run(db, 'UPDATE messages SET deleted = 1, content = \'[deleted]\' WHERE id = ?', [msg.id]);

  req.app.locals.broadcast(req.params.roomId, {
    type: 'message_deleted',
    message_id: msg.id
  });

  res.json({ ok: true });
});

// POST /api/rooms/dm  - create or get DM room between two users
router.post('/dm', requireAuth, async (req, res) => {
  const db = await getDb();
  const { target_user_id } = req.body;
  if (!target_user_id) return res.status(400).json({ error: 'target_user_id required' });
  if (target_user_id === req.user.id) return res.status(400).json({ error: 'Cannot DM yourself' });

  const targetUser = get(db, 'SELECT id, username, display_name FROM users WHERE id = ?', [target_user_id]);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  // Find existing DM room between these two
  const existing = get(db, `
    SELECT r.id FROM rooms r
    JOIN room_members rm1 ON rm1.room_id = r.id AND rm1.user_id = ?
    JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id = ?
    WHERE r.is_dm = 1
    AND (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) = 2
    LIMIT 1
  `, [req.user.id, target_user_id]);

  if (existing) return res.json({ room_id: existing.id });

  // Create new DM room
  const roomId = uuidv4();
  const now = Date.now();
  run(db, 'INSERT INTO rooms (id, name, description, created_by, created_at, is_dm) VALUES (?, ?, ?, ?, ?, 1)',
    [roomId, `dm-${req.user.id}-${target_user_id}`, '', req.user.id, now]);
  run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [roomId, req.user.id, now]);
  run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [roomId, target_user_id, now]);

  res.status(201).json({ room_id: roomId });
});

// GET /api/users/search?q=query
router.get('/users/search', requireAuth, async (req, res) => {
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

module.exports = router;