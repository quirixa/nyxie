const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb, all, get, run } = require('./db');
const { requireAuth } = require('./middleware');

// GET /api/servers – list all servers the user is a member of
router.get('/', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const servers = all(db, `
      SELECT s.id, s.name, s.icon, s.owner_id, s.created_at,
             (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) AS member_count
      FROM servers s
      JOIN server_members sm ON sm.server_id = s.id
      WHERE sm.user_id = ?
      ORDER BY s.created_at ASC
    `, [req.user.id]);
    res.json({ servers });
  } catch (err) {
    console.error('Error fetching servers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/servers – create a new server (user becomes owner)
router.post('/', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    let { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Server name is required' });
    }
    name = name.trim().substring(0, 50);
    const serverId = uuidv4();
    const now = Date.now();

    run(db, 'INSERT INTO servers (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)',
        [serverId, name, req.user.id, now]);
    run(db, 'INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)',
        [serverId, req.user.id, now]);
    const generalId = uuidv4();
    run(db, `INSERT INTO rooms (id, server_id, name, description, created_by, created_at, is_dm)
             VALUES (?, ?, 'general', 'Default channel', ?, ?, 0)`,
        [generalId, serverId, req.user.id, now]);
    run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)',
        [generalId, req.user.id, now]);

    res.status(201).json({ server: { id: serverId, name, owner_id: req.user.id } });
  } catch (err) {
    console.error('Error creating server:', err);
    res.status(500).json({ error: 'Failed to create server' });
  }
});

// POST /api/servers/:serverId/join – join a public server
router.post('/:serverId/join', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const server = get(db, 'SELECT id FROM servers WHERE id = ?', [req.params.serverId]);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const already = get(db, 'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?',
        [server.id, req.user.id]);
    if (already) {
      return res.status(400).json({ error: 'Already a member of this server' });
    }

    const now = Date.now();
    run(db, 'INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)',
        [server.id, req.user.id, now]);

    const channels = all(db, 'SELECT id FROM rooms WHERE server_id = ? AND is_dm = 0', [server.id]);
    for (const ch of channels) {
      run(db, 'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)',
          [ch.id, req.user.id, now]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error joining server:', err);
    res.status(500).json({ error: 'Failed to join server' });
  }
});

// GET /api/servers/:serverId/channels – list all text channels of a server
router.get('/:serverId/channels', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const isMember = get(db, 'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?',
        [req.params.serverId, req.user.id]);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this server' });
    }

    const channels = all(db, `
      SELECT r.id, r.name, r.description, r.created_at,
             (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) AS member_count
      FROM rooms r
      WHERE r.server_id = ? AND r.is_dm = 0
      ORDER BY r.created_at ASC
    `, [req.params.serverId]);
    res.json({ channels });
  } catch (err) {
    console.error('Error fetching channels:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/servers/:serverId/channels – create a new channel in a server
router.post('/:serverId/channels', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const { name, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Channel name is required' });
    }

    const server = get(db, 'SELECT id, owner_id FROM servers WHERE id = ?', [req.params.serverId]);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const isMember = get(db, 'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?',
        [server.id, req.user.id]);
    if (!isMember) {
      return res.status(403).json({ error: 'You must be a member of the server to create channels' });
    }

    const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 32);
    const channelId = uuidv4();
    const now = Date.now();

    run(db, `INSERT INTO rooms (id, server_id, name, description, created_by, created_at, is_dm)
             VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [channelId, server.id, cleanName, description?.trim() || '', req.user.id, now]);

    const members = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [server.id]);
    for (const m of members) {
      run(db, 'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)',
          [channelId, m.user_id, now]);
    }

    res.status(201).json({ channel: { id: channelId, name: cleanName, description: description?.trim() || '' } });
  } catch (err) {
    console.error('Error creating channel:', err);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

module.exports = router;