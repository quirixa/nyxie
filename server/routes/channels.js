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
const { getUserDb, all, get, run, transaction } = require('../database/userDb');
const { getMessageDb, runMessage } = require('../database/messageDb');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS, getServerContext, hasPermission, canViewRoom } = require('../services/permissions');
const { recordAudit } = require('../services/audit');
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

// Only people who can still view the channel hear about its name/topic.
function viewerIds(db, channel) {
  return all(db, 'SELECT user_id FROM room_members WHERE room_id = ?', [channel.id])
    .map(m => m.user_id)
    .filter(uid => canViewRoom(db, { id: channel.id, server_id: channel.server_id }, uid));
}

router.patch('/:channelId', requireAuth, loadChannel, async (req, res) => {
  try {
    const db = await getUserDb();
    const ctx = getServerContext(db, req.channel.server_id, req.user.id);
    if (!hasPermission(ctx, PERMISSIONS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'Missing permission' });

    const { name, description, position, category_id } = req.body || {};
    const next = {};
    if (name !== undefined) {
      if (typeof name !== 'string') return res.status(400).json({ error: 'Invalid channel name' });
      const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 32);
      if (!clean) return res.status(400).json({ error: 'Invalid channel name' });
      next.name = clean;
    }
    if (description !== undefined) {
      if (description !== null && typeof description !== 'string') return res.status(400).json({ error: 'Topic must be text' });
      const topic = (description || '').trim();
      if (topic.length > 200) return res.status(400).json({ error: 'Topic must be 200 characters or fewer' });
      next.description = topic;
    }
    if (position !== undefined) {
      if (!Number.isInteger(position) || position < 0 || position > 100000) return res.status(400).json({ error: 'Invalid position' });
      next.position = position;
    }
    if (category_id !== undefined) {
      if (category_id !== null && category_id !== '' &&
          !get(db, 'SELECT 1 FROM server_categories WHERE id = ? AND server_id = ?', [String(category_id), req.channel.server_id])) {
        return res.status(400).json({ error: 'Category not found' });
      }
      next.category_id = category_id ? String(category_id) : null;
    }
    if (!Object.keys(next).length) return res.status(400).json({ error: 'Nothing to update' });

    const cur = req.channel;
    const norm = { name: cur.name, description: cur.description || '', position: cur.position || 0, category_id: cur.category_id || null };
    const changed = Object.keys(next).filter(k => next[k] !== norm[k]);
    if (changed.length) {
      transaction(db, () => {
        run(db, `UPDATE rooms SET ${changed.map(c => `${c} = ?`).join(', ')} WHERE id = ?`, [...changed.map(c => next[c]), req.params.channelId]);
        const diff = {};
        changed.filter(c => c === 'name' || c === 'description').forEach(c => { diff[c] = { before: norm[c], after: next[c] }; });
        if (Object.keys(diff).length) {
          recordAudit(db, { serverId: cur.server_id, actorId: req.user.id, action: 'channel.update', targetType: 'channel', targetId: cur.id, targetName: next.name || cur.name, details: { changes: diff } });
        }
        if (changed.includes('category_id')) {
          const nm = id => (id ? get(db, 'SELECT name FROM server_categories WHERE id = ?', [id])?.name || null : null);
          recordAudit(db, { serverId: cur.server_id, actorId: req.user.id, action: 'channel.move', targetType: 'channel', targetId: cur.id, targetName: next.name || cur.name, details: { from_category: nm(norm.category_id), to_category: nm(next.category_id) } });
        }
      });
    }

    const updated = get(db, 'SELECT id, server_id, name, description, position, category_id FROM rooms WHERE id = ?', [req.params.channelId]);
    if (changed.length) {
      viewerIds(db, req.channel).forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'channel_updated', server_id: req.channel.server_id, channel: updated }));
    }
    res.json({ channel: updated, changed: changed.length > 0 });
  } catch (err) {
    console.error('Error updating channel:', err);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

router.delete('/:channelId', requireAuth, loadChannel, async (req, res) => {
  try {
    const db = await getUserDb();
    const ctx = getServerContext(db, req.channel.server_id, req.user.id);
    if (!hasPermission(ctx, PERMISSIONS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'Missing permission' });

    const remaining = get(db, 'SELECT COUNT(*) AS c FROM rooms WHERE server_id = ? AND is_dm = 0', [req.channel.server_id])?.c || 0;
    if (remaining <= 1) return res.status(400).json({ error: 'A server must have at least one channel' });

    const memberIds = all(db, 'SELECT user_id FROM room_members WHERE room_id = ?', [req.params.channelId]).map(m => m.user_id);
    const msgDb = await getMessageDb();
    // Existing data rule: deleting a channel deletes that channel's own
    // messages (and nothing else). Server rows first, then the messages.
    transaction(db, () => {
      run(db, 'DELETE FROM channel_permission_overrides WHERE channel_id = ?', [req.params.channelId]);
      run(db, 'DELETE FROM room_members WHERE room_id = ?', [req.params.channelId]);
      run(db, 'DELETE FROM rooms WHERE id = ?', [req.params.channelId]);
      recordAudit(db, { serverId: req.channel.server_id, actorId: req.user.id, action: 'channel.delete', targetType: 'channel', targetId: req.channel.id, targetName: req.channel.name, details: { topic: req.channel.description || '' } });
    });
    runMessage(msgDb, 'DELETE FROM messages WHERE room_id = ?', [req.params.channelId]);
    req.app.locals.closeRoom?.(req.params.channelId);

    memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'channel_deleted', server_id: req.channel.server_id, channel_id: req.params.channelId }));
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting channel:', err);
    res.status(500).json({ error: 'Failed to delete channel' });
  }
});

module.exports = router;
