// server/routes/channels.js — operations addressed by channelId alone
// (rename, delete, and the message endpoints). Creation/listing of
// channels lives in routes/servers.js since those need a serverId.
//
// Messages reuse the exact same handlers as routes/rooms.js — a channel
// is a room with server_id set, so its messages go through the same
// E2EE/attachment/mention/reply pipeline as a DM or group chat. This
// file just resolves :channelId -> the same req.params.id shape those
// handlers expect, and adds the server-permission checks that only
// apply to channels.
const express = require('express');
const router = express.Router();
const { getUserDb, all, get, run } = require('../database/userDb');
const { getMessageDb, runMessage } = require('../database/messageDb');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, getServerContext, hasPermission } = require('../services/permissions');
const roomHandlers = require('./rooms');

// Bridges /api/channels/:channelId/... to the shared handlers in
// rooms.js, which read the room id from req.params.id.
function asRoomId(req, res, next) {
  req.params.id = req.params.channelId;
  next();
}

async function loadChannel(req, res, next) {
  const db = await getUserDb();
  const channel = get(db, 'SELECT * FROM rooms WHERE id = ? AND is_dm = 0', [req.params.channelId]);
  if (!channel || !channel.server_id) return res.status(404).json({ error: 'Channel not found' });
  req.channel = channel;
  next();
}

router.get('/:channelId/messages', requireAuth, loadChannel, asRoomId, roomHandlers.listMessages);
router.post('/:channelId/messages', requireAuth, loadChannel, asRoomId, roomHandlers.postMessage);
router.patch('/:channelId/messages/:msgId', requireAuth, loadChannel, asRoomId, roomHandlers.editMessage);
router.delete('/:channelId/messages/:msgId', requireAuth, loadChannel, asRoomId, roomHandlers.deleteMessage);

router.patch('/:channelId', requireAuth, loadChannel, async (req, res) => {
  const db = await getUserDb();
  const ctx = getServerContext(db, req.channel.server_id, req.user.id);
  if (!hasPermission(ctx, PERMISSIONS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'Missing permission' });

  const { name, description, position } = req.body;
  const updates = [];
  const params = [];
  if (name !== undefined) {
    const clean = String(name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 32);
    if (!clean) return res.status(400).json({ error: 'Invalid channel name' });
    updates.push('name = ?'); params.push(clean);
  }
  if (description !== undefined) {
    updates.push('description = ?'); params.push(String(description).trim().slice(0, 200));
  }
  if (position !== undefined && Number.isInteger(position)) {
    updates.push('position = ?'); params.push(position);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  params.push(req.params.channelId);
  run(db, `UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`, params);

  const updated = get(db, 'SELECT id, server_id, name, description, position FROM rooms WHERE id = ?', [req.params.channelId]);
  const members = all(db, 'SELECT user_id FROM room_members WHERE room_id = ?', [req.params.channelId]);
  members.forEach(m => req.app.locals.broadcastToUser(m.user_id, { type: 'channel_updated', server_id: req.channel.server_id, channel: updated }));
  res.json({ channel: updated });
});

router.delete('/:channelId', requireAuth, loadChannel, async (req, res) => {
  const db = await getUserDb();
  const ctx = getServerContext(db, req.channel.server_id, req.user.id);
  if (!hasPermission(ctx, PERMISSIONS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'Missing permission' });

  const remaining = get(db, 'SELECT COUNT(*) AS c FROM rooms WHERE server_id = ? AND is_dm = 0', [req.channel.server_id])?.c || 0;
  if (remaining <= 1) return res.status(400).json({ error: 'A server must have at least one channel' });

  const memberIds = all(db, 'SELECT user_id FROM room_members WHERE room_id = ?', [req.params.channelId]).map(m => m.user_id);
  const msgDb = await getMessageDb();
  runMessage(msgDb, 'DELETE FROM messages WHERE room_id = ?', [req.params.channelId]);
  run(db, 'DELETE FROM room_members WHERE room_id = ?', [req.params.channelId]);
  run(db, 'DELETE FROM rooms WHERE id = ?', [req.params.channelId]);

  memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'channel_deleted', server_id: req.channel.server_id, channel_id: req.params.channelId }));
  res.json({ ok: true });
});

module.exports = router;
