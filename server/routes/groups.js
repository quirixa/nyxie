// server/routes/groups.js — private group chats. Deliberately much
// simpler than servers.js: no channels, no roles/permission bitmask, no
// invite codes. A group is just a `rooms` row with is_dm=1, is_group=1,
// its own name/icon, and a room_members list — which means its messages
// already go through the exact same E2EE-aware pipeline as a DM (see
// routes/rooms.js), just without a shared-key fallback since E2EE here
// is inherently 2-party (this mirrors how Nyxie's own DM crypto works,
// and is called out explicitly rather than pretended away — see the
// E2EE-compatibility section of the servers/groups feature spec).
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getUserDb, all, get, run } = require('../database/userDb');
const { getMessageDb, runMessage } = require('../database/messageDb');
const { requireAuth } = require('../middleware/auth');
const { isBlocked } = require('../services/blocks');
const { effectiveStatus } = require('../services/presence');
const roomHandlers = require('./rooms');

const MAX_GROUP_NAME = 50;
// Configurable per deployment (spec: "reasonable initial group member
// limit, but make the value configurable") rather than hardcoded.
const MAX_GROUP_MEMBERS = parseInt(process.env.GROUP_MAX_MEMBERS) || 50;

function asRoomId(req, res, next) {
  req.params.id = req.params.groupId;
  next();
}

async function loadGroup(req, res, next) {
  const db = await getUserDb();
  const group = get(db, 'SELECT * FROM rooms WHERE id = ? AND is_dm = 1 AND is_group = 1', [req.params.groupId]);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const isMember = !!get(db, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', [group.id, req.user.id]);
  if (!isMember) return res.status(404).json({ error: 'Group not found' });
  req.group = group;
  next();
}

function serializeGroup(db, group, isUserConnected) {
  const members = all(db, `
    SELECT rm.user_id, rm.joined_at, u.username, u.display_name, u.avatar, u.status, u.public_key
    FROM room_members rm JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = ?
    ORDER BY rm.joined_at ASC
  `, [group.id]);
  // This one serialized payload gets broadcast to every member at once
  // (see the callers below), so it can't be masked differently per
  // recipient — always mask as "someone else's" view (isSelf: false).
  // The one place a user's own status needs to read as "invisible"
  // rather than "offline" is their own profile popout, which fetches
  // fresh via GET /users/:id and is self-aware there.
  members.forEach(m => {
    m.status = effectiveStatus(m.status, { connected: (isUserConnected || (() => false))(m.user_id), isSelf: false });
  });
  return {
    id: group.id,
    name: group.name,
    icon: group.icon || null,
    created_by: group.created_by,
    created_at: group.created_at,
    member_count: members.length,
    members
  };
}

router.get('/', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const groups = all(db, `
    SELECT r.* FROM rooms r
    JOIN room_members rm ON rm.room_id = r.id
    WHERE r.is_dm = 1 AND r.is_group = 1 AND rm.user_id = ?
    ORDER BY r.created_at DESC
  `, [req.user.id]);
  res.json({ groups: groups.map(g => serializeGroup(db, g, req.app.locals.isUserConnected)) });
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const db = await getUserDb();
    let { name, member_ids, icon } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Group name required' });
    if (!Array.isArray(member_ids) || !member_ids.length) return res.status(400).json({ error: 'At least one member required' });

    name = name.trim().slice(0, MAX_GROUP_NAME);
    icon = (typeof icon === 'string' && icon.startsWith('/uploads/')) ? icon : null;

    const uniqueIds = [...new Set(member_ids.map(String))].filter(id => id !== req.user.id);
    if (uniqueIds.length + 1 > MAX_GROUP_MEMBERS) {
      return res.status(400).json({ error: `Groups are limited to ${MAX_GROUP_MEMBERS} members` });
    }

    // Respect blocks in both directions — you can't add someone who
    // blocked you, or someone you've blocked, into a group with them.
    const blockedIds = uniqueIds.filter(id => isBlocked(db, req.user.id, id));
    if (blockedIds.length) {
      return res.status(403).json({ error: 'Cannot add a user you are blocked by or have blocked' });
    }
    const placeholders = uniqueIds.map(() => '?').join(',');
    const validUsers = uniqueIds.length ? all(db, `SELECT id FROM users WHERE id IN (${placeholders})`, uniqueIds) : [];
    if (validUsers.length !== uniqueIds.length) return res.status(400).json({ error: 'One or more users not found' });

    const groupId = crypto.randomUUID();
    const now = Date.now();
    run(db, 'INSERT INTO rooms (id, name, description, created_by, created_at, is_dm, is_group, icon) VALUES (?, ?, ?, ?, ?, 1, 1, ?)',
      [groupId, name, '', req.user.id, now, icon]);
    run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [groupId, req.user.id, now]);
    for (const uid of uniqueIds) {
      run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [groupId, uid, now]);
    }

    const group = get(db, 'SELECT * FROM rooms WHERE id = ?', [groupId]);
    const serialized = serializeGroup(db, group, req.app.locals.isUserConnected);
    [req.user.id, ...uniqueIds].forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'group_created', group: serialized }));

    res.status(201).json({ group: serialized });
  } catch (err) {
    console.error('Error creating group:', err);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

router.get('/:groupId', requireAuth, loadGroup, async (req, res) => {
  const db = await getUserDb();
  res.json({ group: serializeGroup(db, req.group, req.app.locals.isUserConnected) });
});

router.patch('/:groupId', requireAuth, loadGroup, async (req, res) => {
  if (req.group.created_by !== req.user.id) return res.status(403).json({ error: 'Only the group creator can do this' });
  const db = await getUserDb();
  const { name, icon } = req.body;
  const updates = [];
  const params = [];
  if (name !== undefined) {
    const clean = String(name).trim().slice(0, MAX_GROUP_NAME);
    if (!clean) return res.status(400).json({ error: 'Group name cannot be empty' });
    updates.push('name = ?'); params.push(clean);
  }
  if (icon !== undefined) {
    updates.push('icon = ?'); params.push(typeof icon === 'string' && icon.startsWith('/uploads/') ? icon : null);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.groupId);
  run(db, `UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`, params);

  const updated = get(db, 'SELECT * FROM rooms WHERE id = ?', [req.params.groupId]);
  const serialized = serializeGroup(db, updated, req.app.locals.isUserConnected);
  serialized.members.forEach(m => req.app.locals.broadcastToUser(m.user_id, { type: 'group_updated', group: serialized }));
  res.json({ group: serialized });
});

router.delete('/:groupId', requireAuth, loadGroup, async (req, res) => {
  if (req.group.created_by !== req.user.id) return res.status(403).json({ error: 'Only the group creator can delete this group' });
  const db = await getUserDb();
  const msgDb = await getMessageDb();
  const memberIds = all(db, 'SELECT user_id FROM room_members WHERE room_id = ?', [req.params.groupId]).map(m => m.user_id);

  runMessage(msgDb, 'DELETE FROM messages WHERE room_id = ?', [req.params.groupId]);
  run(db, 'DELETE FROM room_members WHERE room_id = ?', [req.params.groupId]);
  run(db, 'DELETE FROM rooms WHERE id = ?', [req.params.groupId]);

  memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'group_deleted', group_id: req.params.groupId }));
  res.json({ ok: true });
});

router.post('/:groupId/members', requireAuth, loadGroup, async (req, res) => {
  try {
    const db = await getUserDb();
    const { user_ids } = req.body;
    if (!Array.isArray(user_ids) || !user_ids.length) return res.status(400).json({ error: 'user_ids required' });

    const currentCount = get(db, 'SELECT COUNT(*) AS c FROM room_members WHERE room_id = ?', [req.params.groupId])?.c || 0;
    const uniqueIds = [...new Set(user_ids.map(String))]
      .filter(id => !get(db, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', [req.params.groupId, id]));

    if (currentCount + uniqueIds.length > MAX_GROUP_MEMBERS) {
      return res.status(400).json({ error: `Groups are limited to ${MAX_GROUP_MEMBERS} members` });
    }
    if (uniqueIds.some(id => isBlocked(db, req.user.id, id))) {
      return res.status(403).json({ error: 'Cannot add a user you are blocked by or have blocked' });
    }
    const placeholders = uniqueIds.map(() => '?').join(',');
    const validUsers = uniqueIds.length ? all(db, `SELECT id FROM users WHERE id IN (${placeholders})`, uniqueIds) : [];
    if (validUsers.length !== uniqueIds.length) return res.status(400).json({ error: 'One or more users not found' });

    const now = Date.now();
    for (const uid of uniqueIds) {
      run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [req.params.groupId, uid, now]);
    }

    const group = get(db, 'SELECT * FROM rooms WHERE id = ?', [req.params.groupId]);
    const serialized = serializeGroup(db, group, req.app.locals.isUserConnected);
    serialized.members.forEach(m => req.app.locals.broadcastToUser(m.user_id, { type: 'group_member_added', group_id: req.params.groupId, added: uniqueIds, group: serialized }));

    res.status(201).json({ group: serialized });
  } catch (err) {
    console.error('Error adding group members:', err);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

router.delete('/:groupId/members/:userId', requireAuth, loadGroup, async (req, res) => {
  const db = await getUserDb();
  const { userId } = req.params;
  const isSelf = userId === req.user.id;
  if (!isSelf && req.group.created_by !== req.user.id) {
    return res.status(403).json({ error: 'Only the group creator can remove other members' });
  }
  if (userId === req.group.created_by && !isSelf) {
    return res.status(403).json({ error: 'Cannot remove the group creator' });
  }

  const memberIdsBefore = all(db, 'SELECT user_id FROM room_members WHERE room_id = ?', [req.params.groupId]).map(m => m.user_id);
  run(db, 'DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [req.params.groupId, userId]);

  // If the creator leaves, hand ownership to the longest-standing
  // remaining member rather than leaving the group ownerless.
  if (isSelf && userId === req.group.created_by) {
    const next = get(db, 'SELECT user_id FROM room_members WHERE room_id = ? ORDER BY joined_at ASC LIMIT 1', [req.params.groupId]);
    if (next) run(db, 'UPDATE rooms SET created_by = ? WHERE id = ?', [next.user_id, req.params.groupId]);
  }

  const eventType = isSelf ? 'group_member_left' : 'group_member_removed';
  memberIdsBefore.forEach(uid => req.app.locals.broadcastToUser(uid, { type: eventType, group_id: req.params.groupId, user_id: userId }));

  res.json({ ok: true });
});

router.get('/:groupId/messages', requireAuth, loadGroup, asRoomId, roomHandlers.listMessages);
router.post('/:groupId/messages', requireAuth, loadGroup, asRoomId, roomHandlers.postMessage);
router.patch('/:groupId/messages/:msgId', requireAuth, loadGroup, asRoomId, roomHandlers.editMessage);
router.delete('/:groupId/messages/:msgId', requireAuth, loadGroup, asRoomId, roomHandlers.deleteMessage);

module.exports = router;
