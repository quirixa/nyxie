// server/routes/servers.js — server CRUD, membership, roles, and bans.
// Channel-specific operations (rename/delete a single channel, channel
// messages) live in routes/channels.js instead, since a channel isn't
// addressed by serverId in its URL. Invite redemption/preview/revocation
// by code lives in routes/invites.js for the same reason (an invite code
// isn't a serverId either). Both of those routers reuse
// services/permissions.js so all three files agree on what each role
// can do.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getUserDb, all, get, run } = require('../database/userDb');
const { getMessageDb, runMessage } = require('../database/messageDb');
const { requireAuth } = require('../middleware/auth');
const {
  PERMISSIONS,
  createDefaultRoles,
  getDefaultRoleId,
  ensureServerRoles,
  getServerContext,
  hasPermission,
  outranks,
  requireServerPermission
} = require('../services/permissions');
const { CATEGORIES, isValidCategory } = require('../services/discoveryCategories');
const { effectiveStatus } = require('../services/presence');

const MAX_SERVER_NAME = 50;
const MAX_SERVER_DESC = 300;
const MAX_CHANNEL_NAME = 32;

function cleanChannelName(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, MAX_CHANNEL_NAME);
}

function serializeServer(db, server, ctx) {
  const memberCount = get(db, 'SELECT COUNT(*) AS c FROM server_members WHERE server_id = ?', [server.id])?.c || 0;
  return {
    id: server.id,
    name: server.name,
    description: server.description || '',
    icon: server.icon || null,
    owner_id: server.owner_id,
    created_at: server.created_at,
    category: server.category || null,
    is_discoverable: !!server.is_discoverable,
    member_count: memberCount,
    my_role: ctx ? { id: ctx.roleId, name: ctx.roleName, position: ctx.rolePosition, permissions: ctx.permissions } : null,
    my_permissions: ctx ? ctx.permissions : 0,
    is_owner: !!ctx?.isOwner,
    nickname: ctx?.nickname || null
  };
}

const DISCOVER_PAGE_SIZE = 20;
const MAX_DISCOVER_PAGE_SIZE = 50;

// ─── Servers ─────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const db = await getUserDb();
    const rows = all(db, `
      SELECT s.id FROM servers s
      JOIN server_members sm ON sm.server_id = s.id
      WHERE sm.user_id = ?
      ORDER BY s.created_at ASC
    `, [req.user.id]);

    const servers = rows.map(r => {
      const server = get(db, 'SELECT * FROM servers WHERE id = ?', [r.id]);
      const ctx = getServerContext(db, r.id, req.user.id);
      return serializeServer(db, server, ctx);
    });
    res.json({ servers });
  } catch (err) {
    console.error('Error fetching servers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const db = await getUserDb();
    let { name, description, icon, is_discoverable, category } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Server name required' });
    name = name.trim().substring(0, MAX_SERVER_NAME);
    description = (description || '').toString().trim().slice(0, MAX_SERVER_DESC);
    icon = (typeof icon === 'string' && icon.startsWith('/uploads/')) ? icon : null;
    const discoverable = is_discoverable === true ? 1 : 0;
    // Reject an unknown category outright rather than silently storing
    // whatever the client sent — a bogus value here would never match
    // any Discovery category tab, so the server would be undiscoverable
    // by category (only reachable via search) while looking fine to the
    // owner. Empty/omitted stays NULL (uncategorized).
    if (category !== undefined && category !== null && category !== '' && !isValidCategory(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    category = isValidCategory(category) ? category : null;

    const serverId = crypto.randomUUID();
    const now = Date.now();

    run(db, 'INSERT INTO servers (id, name, description, icon, owner_id, created_at, is_discoverable, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [serverId, name, description, icon, req.user.id, now, discoverable, category]);

    const roleIds = createDefaultRoles(db, serverId, now);
    run(db, 'INSERT INTO server_members (server_id, user_id, joined_at, role_id) VALUES (?, ?, ?, ?)',
      [serverId, req.user.id, now, roleIds.admin]);

    const generalId = crypto.randomUUID();
    run(db, `INSERT INTO rooms (id, server_id, name, description, created_by, created_at, is_dm, position)
             VALUES (?, ?, 'general', 'Default channel', ?, ?, 0, 0)`,
      [generalId, serverId, req.user.id, now]);
    run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [generalId, req.user.id, now]);

    const server = get(db, 'SELECT * FROM servers WHERE id = ?', [serverId]);
    const ctx = getServerContext(db, serverId, req.user.id);
    res.status(201).json({ server: serializeServer(db, server, ctx), default_channel_id: generalId });
  } catch (err) {
    console.error('Error creating server:', err);
    res.status(500).json({ error: 'Failed to create server' });
  }
});

// ─── Discover ────────────────────────────────────────────────────
// Public server search — backend/database driven (not a filter over
// servers already loaded into the browser). Registered before
// '/:serverId' below so the literal paths '/discover' and
// '/categories' aren't swallowed by that param route.

// The fixed category list, for the Discovery page's top nav — kept
// server-side (services/discoveryCategories.js) so the frontend never
// hard-codes its own copy that could drift from what create/update
// actually accept.
router.get('/categories', requireAuth, async (req, res) => {
  res.json({ categories: CATEGORIES });
});

router.get('/discover', requireAuth, async (req, res) => {
  try {
    const db = await getUserDb();
    const rawQuery = (req.query.query || req.query.q || '').toString().trim().slice(0, 100);
    const rawCategory = (req.query.category || '').toString().trim();
    if (rawCategory && !isValidCategory(rawCategory)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    let page = parseInt(req.query.page, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;
    let pageSize = parseInt(req.query.page_size, 10);
    if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = DISCOVER_PAGE_SIZE;
    pageSize = Math.min(pageSize, MAX_DISCOVER_PAGE_SIZE);
    const offset = (page - 1) * pageSize;

    // Case-insensitive partial match on name and description. SQLite's
    // LIKE is already case-insensitive for ASCII by default; lower()
    // on both sides keeps that true regardless of collation settings.
    // Only is_discoverable = 1 servers are ever considered here — a
    // private server's existence/membership is never exposed through
    // this endpoint, no matter what someone searches for or which
    // category they filter by.
    const like = `%${rawQuery.toLowerCase().replace(/[%_]/g, c => '\\' + c)}%`;
    const conditions = ['s.is_discoverable = 1'];
    const params = [];
    if (rawCategory) { conditions.push('s.category = ?'); params.push(rawCategory); }
    if (rawQuery) { conditions.push(`(lower(s.name) LIKE ? ESCAPE '\\' OR lower(s.description) LIKE ? ESCAPE '\\')`); params.push(like, like); }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const total = get(db, `SELECT COUNT(*) AS c FROM servers s ${where}`, params)?.c || 0;

    // Member counts come from a single JOIN + GROUP BY against
    // server_members (never a client-supplied or separately cached
    // number), and the sort/pagination happen in this one query rather
    // than fetching every matching row and sorting/counting per-row in
    // JS — the "N+1 COUNT(*) per server" shape the discovery endpoint
    // used before doesn't scale past a handful of results.
    const rows = all(db, `
      SELECT s.id, s.name, s.description, s.icon, s.category, s.created_at,
             COUNT(sm.user_id) AS member_count
      FROM servers s
      LEFT JOIN server_members sm ON sm.server_id = s.id
      ${where}
      GROUP BY s.id
      ORDER BY member_count DESC, s.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, offset]);

    const results = rows.map(s => {
      const alreadyMember = !!get(db, 'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?', [s.id, req.user.id]);
      return {
        id: s.id,
        name: s.name,
        description: s.description || '',
        icon: s.icon || null,
        category: s.category || null,
        member_count: s.member_count,
        already_member: alreadyMember
      };
    });

    res.json({
      servers: results,
      page,
      page_size: pageSize,
      total,
      has_more: offset + results.length < total
    });
  } catch (err) {
    console.error('Error searching servers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Join a public, discoverable server directly (no invite code needed).
// Invite-code joins (private or public servers) go through
// routes/invites.js's POST /:code/join instead.
router.post('/:serverId/join', requireAuth, async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId } = req.params;
    const server = get(db, 'SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!server || !server.is_discoverable) return res.status(404).json({ error: 'Server not found' });

    if (get(db, 'SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, req.user.id])) {
      return res.status(403).json({ error: 'You are banned from this server' });
    }
    if (get(db, 'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, req.user.id])) {
      return res.status(200).json({ ok: true, server_id: serverId, already_member: true });
    }

    ensureServerRoles(db, serverId);
    const defaultRoleId = getDefaultRoleId(db, serverId);
    const now = Date.now();
    run(db, 'INSERT INTO server_members (server_id, user_id, joined_at, role_id) VALUES (?, ?, ?, ?)',
      [serverId, req.user.id, now, defaultRoleId]);

    const channels = all(db, 'SELECT id FROM rooms WHERE server_id = ? AND is_dm = 0', [serverId]);
    for (const ch of channels) {
      run(db, 'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [ch.id, req.user.id, now]);
    }

    const joined = { id: req.user.id, username: req.user.username, display_name: req.user.display_name };
    const memberIds = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]).map(m => m.user_id);
    memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'server_member_joined', server_id: serverId, member: joined }));
    req.app.locals.broadcastToUser(req.user.id, { type: 'server_joined', server_id: serverId });

    res.json({ ok: true, server_id: serverId });
  } catch (err) {
    console.error('Error joining server:', err);
    res.status(500).json({ error: 'Failed to join server' });
  }
});

router.get('/:serverId', requireAuth, requireServerPermission(null), async (req, res) => {
  const db = await getUserDb();
  res.json({ server: serializeServer(db, req.serverCtx.server, req.serverCtx) });
});

router.patch('/:serverId', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_SERVER), async (req, res) => {
  try {
    const db = await getUserDb();
    const { name, description, icon, is_discoverable, category } = req.body;
    const updates = [];
    const params = [];
    if (name !== undefined) {
      const clean = String(name).trim().slice(0, MAX_SERVER_NAME);
      if (!clean) return res.status(400).json({ error: 'Server name cannot be empty' });
      updates.push('name = ?'); params.push(clean);
    }
    if (description !== undefined) {
      updates.push('description = ?'); params.push(String(description).trim().slice(0, MAX_SERVER_DESC));
    }
    if (icon !== undefined) {
      updates.push('icon = ?'); params.push(typeof icon === 'string' && icon.startsWith('/uploads/') ? icon : null);
    }
    if (is_discoverable !== undefined) {
      updates.push('is_discoverable = ?'); params.push(is_discoverable ? 1 : 0);
    }
    if (category !== undefined) {
      if (category !== null && category !== '' && !isValidCategory(category)) {
        return res.status(400).json({ error: 'Invalid category' });
      }
      updates.push('category = ?'); params.push(isValidCategory(category) ? category : null);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.serverId);
    run(db, `UPDATE servers SET ${updates.join(', ')} WHERE id = ?`, params);

    const server = get(db, 'SELECT * FROM servers WHERE id = ?', [req.params.serverId]);
    const memberIds = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [req.params.serverId]).map(m => m.user_id);
    memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'server_updated', server: serializeServer(db, server, null) }));

    res.json({ server: serializeServer(db, server, req.serverCtx) });
  } catch (err) {
    console.error('Error updating server:', err);
    res.status(500).json({ error: 'Failed to update server' });
  }
});

router.delete('/:serverId', requireAuth, requireServerPermission(null), async (req, res) => {
  try {
    if (!req.serverCtx.isOwner) return res.status(403).json({ error: 'Only the owner can delete this server' });
    const db = await getUserDb();
    const msgDb = await getMessageDb();
    const serverId = req.params.serverId;

    const memberIds = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]).map(m => m.user_id);
    const channelIds = all(db, 'SELECT id FROM rooms WHERE server_id = ?', [serverId]).map(r => r.id);

    for (const channelId of channelIds) {
      runMessage(msgDb, 'DELETE FROM messages WHERE room_id = ?', [channelId]);
      run(db, 'DELETE FROM room_members WHERE room_id = ?', [channelId]);
      run(db, 'DELETE FROM rooms WHERE id = ?', [channelId]);
    }
    run(db, 'DELETE FROM server_members WHERE server_id = ?', [serverId]);
    run(db, 'DELETE FROM server_roles WHERE server_id = ?', [serverId]);
    run(db, 'DELETE FROM server_invites WHERE server_id = ?', [serverId]);
    run(db, 'DELETE FROM server_bans WHERE server_id = ?', [serverId]);
    run(db, 'DELETE FROM servers WHERE id = ?', [serverId]);

    memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'server_deleted', server_id: serverId }));
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting server:', err);
    res.status(500).json({ error: 'Failed to delete server' });
  }
});

router.post('/:serverId/leave', requireAuth, requireServerPermission(null), async (req, res) => {
  const db = await getUserDb();
  const serverId = req.params.serverId;
  if (req.serverCtx.isOwner) {
    return res.status(400).json({ error: 'The owner cannot leave — transfer ownership or delete the server instead' });
  }
  const channelIds = all(db, 'SELECT id FROM rooms WHERE server_id = ?', [serverId]).map(r => r.id);
  for (const channelId of channelIds) {
    run(db, 'DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [channelId, req.user.id]);
  }
  run(db, 'DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, req.user.id]);

  const memberIds = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]).map(m => m.user_id);
  const payload = { type: 'server_member_left', server_id: serverId, user_id: req.user.id };
  memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, payload));
  req.app.locals.broadcastToUser(req.user.id, { type: 'server_left', server_id: serverId });

  res.json({ ok: true });
});

// ─── Members ─────────────────────────────────────────────────────

router.get('/:serverId/members', requireAuth, requireServerPermission(null), async (req, res) => {
  const db = await getUserDb();
  const members = all(db, `
    SELECT sm.user_id, sm.joined_at, sm.nickname, sm.muted, sm.role_id,
           sr.name AS role_name, sr.position AS role_position, sr.permissions AS role_permissions,
           u.username, u.display_name, u.avatar, u.status
    FROM server_members sm
    JOIN users u ON u.id = sm.user_id
    LEFT JOIN server_roles sr ON sr.id = sm.role_id
    WHERE sm.server_id = ?
    ORDER BY COALESCE(sr.position, -1) DESC, u.username ASC
  `, [req.params.serverId]);

  const isUserConnected = req.app.locals.isUserConnected || (() => false);
  res.json({
    members: members.map(m => ({
      id: m.user_id,
      username: m.username,
      display_name: m.nickname || m.display_name,
      global_display_name: m.display_name,
      avatar: m.avatar,
      status: effectiveStatus(m.status, { connected: isUserConnected(m.user_id), isSelf: m.user_id === req.user.id }),
      nickname: m.nickname,
      muted: !!m.muted,
      joined_at: m.joined_at,
      is_owner: m.user_id === req.serverCtx.server.owner_id,
      role: m.role_id ? { id: m.role_id, name: m.role_name, position: m.role_position, permissions: m.role_permissions } : null
    }))
  });
});

// Nickname (self, or anyone with MANAGE_MEMBERS) and/or role
// (MANAGE_MEMBERS only, and only onto/over members you outrank).
router.patch('/:serverId/members/:userId', requireAuth, requireServerPermission(null), async (req, res) => {
  const db = await getUserDb();
  const { serverId, userId } = req.params;
  const targetCtx = getServerContext(db, serverId, userId);
  if (!targetCtx) return res.status(404).json({ error: 'Member not found' });

  const { nickname, role_id } = req.body;
  const isSelf = userId === req.user.id;

  if (nickname !== undefined) {
    if (!isSelf && !hasPermission(req.serverCtx, PERMISSIONS.MANAGE_MEMBERS)) {
      return res.status(403).json({ error: 'Missing permission' });
    }
    run(db, 'UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?',
      [nickname ? String(nickname).trim().slice(0, 32) : null, serverId, userId]);
  }

  if (role_id !== undefined) {
    if (!hasPermission(req.serverCtx, PERMISSIONS.MANAGE_MEMBERS)) return res.status(403).json({ error: 'Missing permission' });
    if (!outranks(req.serverCtx, targetCtx)) return res.status(403).json({ error: 'Cannot change the role of an equal or higher-ranked member' });
    const role = get(db, 'SELECT * FROM server_roles WHERE id = ? AND server_id = ?', [role_id, serverId]);
    if (!role) return res.status(400).json({ error: 'Role not found' });
    // Can't hand out a role that outranks (or equals) your own — stops a
    // Moderator promoting someone to Admin.
    if (!req.serverCtx.isOwner && role.position >= req.serverCtx.rolePosition) {
      return res.status(403).json({ error: 'Cannot assign a role equal to or higher than your own' });
    }
    run(db, 'UPDATE server_members SET role_id = ? WHERE server_id = ? AND user_id = ?', [role_id, serverId, userId]);
    req.app.locals.broadcastToUser(userId, { type: 'server_member_updated', server_id: serverId, user_id: userId, role_id });
  }

  const updatedCtx = getServerContext(db, serverId, userId);
  const memberIds = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]).map(m => m.user_id);
  memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, {
    type: 'server_member_updated', server_id: serverId, user_id: userId,
    nickname: updatedCtx.nickname, role_id: updatedCtx.roleId
  }));

  res.json({ ok: true });
});

router.delete('/:serverId/members/:userId', requireAuth, requireServerPermission(PERMISSIONS.KICK_MEMBERS), async (req, res) => {
  const db = await getUserDb();
  const { serverId, userId } = req.params;
  if (userId === req.serverCtx.server.owner_id) return res.status(403).json({ error: 'Cannot kick the server owner' });

  const targetCtx = getServerContext(db, serverId, userId);
  if (!targetCtx) return res.status(404).json({ error: 'Member not found' });
  if (!outranks(req.serverCtx, targetCtx)) return res.status(403).json({ error: 'Cannot kick an equal or higher-ranked member' });

  const channelIds = all(db, 'SELECT id FROM rooms WHERE server_id = ?', [serverId]).map(r => r.id);
  for (const channelId of channelIds) {
    run(db, 'DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [channelId, userId]);
  }
  run(db, 'DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);

  req.app.locals.broadcastToUser(userId, { type: 'server_member_kicked', server_id: serverId, user_id: userId });
  const memberIds = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]).map(m => m.user_id);
  memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'server_member_left', server_id: serverId, user_id: userId }));

  res.json({ ok: true });
});

// ─── Bans ────────────────────────────────────────────────────────

router.get('/:serverId/bans', requireAuth, requireServerPermission(PERMISSIONS.BAN_MEMBERS), async (req, res) => {
  const db = await getUserDb();
  const bans = all(db, `
    SELECT b.user_id, b.reason, b.created_at, u.username, u.display_name, u.avatar
    FROM server_bans b
    JOIN users u ON u.id = b.user_id
    WHERE b.server_id = ?
    ORDER BY b.created_at DESC
  `, [req.params.serverId]);
  res.json({ bans });
});

router.post('/:serverId/bans/:userId', requireAuth, requireServerPermission(PERMISSIONS.BAN_MEMBERS), async (req, res) => {
  const db = await getUserDb();
  const { serverId, userId } = req.params;
  if (userId === req.serverCtx.server.owner_id) return res.status(403).json({ error: 'Cannot ban the server owner' });

  const targetCtx = getServerContext(db, serverId, userId);
  if (targetCtx && !outranks(req.serverCtx, targetCtx)) {
    return res.status(403).json({ error: 'Cannot ban an equal or higher-ranked member' });
  }

  const now = Date.now();
  run(db, 'INSERT OR REPLACE INTO server_bans (server_id, user_id, banned_by, reason, created_at) VALUES (?, ?, ?, ?, ?)',
    [serverId, userId, req.user.id, (req.body?.reason || '').toString().slice(0, 300), now]);

  if (targetCtx) {
    const channelIds = all(db, 'SELECT id FROM rooms WHERE server_id = ?', [serverId]).map(r => r.id);
    for (const channelId of channelIds) {
      run(db, 'DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [channelId, userId]);
    }
    run(db, 'DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
    req.app.locals.broadcastToUser(userId, { type: 'server_member_banned', server_id: serverId, user_id: userId });
    const memberIds = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]).map(m => m.user_id);
    memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'server_member_left', server_id: serverId, user_id: userId }));
  }

  res.json({ ok: true });
});

router.delete('/:serverId/bans/:userId', requireAuth, requireServerPermission(PERMISSIONS.BAN_MEMBERS), async (req, res) => {
  const db = await getUserDb();
  run(db, 'DELETE FROM server_bans WHERE server_id = ? AND user_id = ?', [req.params.serverId, req.params.userId]);
  res.json({ ok: true });
});

// ─── Roles ───────────────────────────────────────────────────────

router.get('/:serverId/roles', requireAuth, requireServerPermission(null), async (req, res) => {
  const db = await getUserDb();
  const roles = all(db, 'SELECT * FROM server_roles WHERE server_id = ? ORDER BY position DESC', [req.params.serverId]);
  res.json({ roles });
});

router.post('/:serverId/roles', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_ROLES), async (req, res) => {
  const db = await getUserDb();
  const { serverId } = req.params;
  let { name, permissions, position } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Role name required' });
  name = name.trim().slice(0, 32);
  // Can't grant a role with more permission bits than the creator holds
  // (Administrator excepted for the owner) — otherwise MANAGE_ROLES alone
  // would let someone mint themselves a role with every other bit set.
  const requested = Number.isInteger(permissions) ? permissions : 0;
  const cappedPerms = req.serverCtx.isOwner ? requested : (requested & req.serverCtx.permissions);
  const pos = Number.isInteger(position) ? Math.max(0, Math.min(position, 99)) : 10;
  if (!req.serverCtx.isOwner && pos >= req.serverCtx.rolePosition) {
    return res.status(403).json({ error: 'Cannot create a role at or above your own rank' });
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  run(db, 'INSERT INTO server_roles (id, server_id, name, permissions, position, is_default, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [id, serverId, name, cappedPerms, pos, now]);

  const role = get(db, 'SELECT * FROM server_roles WHERE id = ?', [id]);
  const memberIds = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]).map(m => m.user_id);
  memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'server_role_created', server_id: serverId, role }));
  res.status(201).json({ role });
});

router.patch('/:serverId/roles/:roleId', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_ROLES), async (req, res) => {
  const db = await getUserDb();
  const { serverId, roleId } = req.params;
  const role = get(db, 'SELECT * FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId]);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (!req.serverCtx.isOwner && role.position >= req.serverCtx.rolePosition) {
    return res.status(403).json({ error: 'Cannot edit a role at or above your own rank' });
  }

  const { name, permissions } = req.body;
  const updates = [];
  const params = [];
  if (name !== undefined) {
    const clean = String(name).trim().slice(0, 32);
    if (!clean) return res.status(400).json({ error: 'Role name cannot be empty' });
    updates.push('name = ?'); params.push(clean);
  }
  if (permissions !== undefined) {
    const requested = Number.isInteger(permissions) ? permissions : 0;
    const cappedPerms = req.serverCtx.isOwner ? requested : (requested & req.serverCtx.permissions);
    updates.push('permissions = ?'); params.push(cappedPerms);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(roleId);
  run(db, `UPDATE server_roles SET ${updates.join(', ')} WHERE id = ?`, params);

  const updated = get(db, 'SELECT * FROM server_roles WHERE id = ?', [roleId]);
  const memberIds = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]).map(m => m.user_id);
  memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'server_role_updated', server_id: serverId, role: updated }));
  res.json({ role: updated });
});

router.delete('/:serverId/roles/:roleId', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_ROLES), async (req, res) => {
  const db = await getUserDb();
  const { serverId, roleId } = req.params;
  const role = get(db, 'SELECT * FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId]);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_default) return res.status(400).json({ error: 'Cannot delete the default role' });
  if (!req.serverCtx.isOwner && role.position >= req.serverCtx.rolePosition) {
    return res.status(403).json({ error: 'Cannot delete a role at or above your own rank' });
  }

  const fallbackRoleId = getDefaultRoleId(db, serverId);
  run(db, 'UPDATE server_members SET role_id = ? WHERE server_id = ? AND role_id = ?', [fallbackRoleId, serverId, roleId]);
  run(db, 'DELETE FROM server_roles WHERE id = ?', [roleId]);

  const memberIds = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]).map(m => m.user_id);
  memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'server_role_deleted', server_id: serverId, role_id: roleId }));
  res.json({ ok: true });
});

// ─── Channels ────────────────────────────────────────────────────
// Listing/creation are server-scoped (need serverId to check
// membership/permissions and to know which server to attach the new
// channel to); rename/delete of an existing channel live in
// routes/channels.js, addressed by channelId alone.

router.get('/:serverId/channels', requireAuth, requireServerPermission(null), async (req, res) => {
  const db = await getUserDb();
  const channels = all(db, `
    SELECT r.id, r.name, r.description, r.created_at, r.created_by, r.position,
           (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) AS member_count
    FROM rooms r
    WHERE r.server_id = ? AND r.is_dm = 0
    ORDER BY r.position ASC, r.created_at ASC
  `, [req.params.serverId]);
  res.json({ channels });
});

router.post('/:serverId/channels', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_CHANNELS), async (req, res) => {
  try {
    const db = await getUserDb();
    const serverId = req.params.serverId;
    const { name, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Channel name required' });

    const cleanName = cleanChannelName(name);
    if (!cleanName) return res.status(400).json({ error: 'Invalid channel name' });

    const channelId = crypto.randomUUID();
    const now = Date.now();
    const maxPos = get(db, 'SELECT MAX(position) AS m FROM rooms WHERE server_id = ? AND is_dm = 0', [serverId])?.m;
    const position = Number.isInteger(maxPos) ? maxPos + 1 : 0;

    run(db, `INSERT INTO rooms (id, server_id, name, description, created_by, created_at, is_dm, position)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [channelId, serverId, cleanName, (description || '').toString().trim().slice(0, 200), req.user.id, now, position]);

    const members = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]);
    for (const m of members) {
      run(db, 'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [channelId, m.user_id, now]);
    }

    const channel = { id: channelId, server_id: serverId, name: cleanName, description: description?.trim() || '', position };
    members.forEach(m => req.app.locals.broadcastToUser(m.user_id, { type: 'channel_created', server_id: serverId, channel }));

    res.status(201).json({ channel });
  } catch (err) {
    console.error('Error creating channel:', err);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// ─── Invites ─────────────────────────────────────────────────────
// Redemption (POST /api/invites/:code/join) and public preview
// (GET /api/invites/:code) live in routes/invites.js since those aren't
// addressed by serverId. Creation and listing stay here because they
// need serverId to check CREATE_INVITES/MANAGE_SERVER.

function generateInviteCode() {
  return crypto.randomBytes(5).toString('base64url').slice(0, 8);
}

router.post('/:serverId/invites', requireAuth, requireServerPermission(PERMISSIONS.CREATE_INVITES), async (req, res) => {
  const db = await getUserDb();
  const { serverId } = req.params;
  let { expires_in_seconds, max_uses } = req.body || {};

  let code;
  do { code = generateInviteCode(); } while (get(db, 'SELECT 1 FROM server_invites WHERE code = ?', [code]));

  const now = Date.now();
  const expiresAt = Number.isFinite(expires_in_seconds) && expires_in_seconds > 0 ? now + expires_in_seconds * 1000 : null;
  const maxUses = Number.isInteger(max_uses) && max_uses > 0 ? Math.min(max_uses, 10000) : null;

  run(db, 'INSERT INTO server_invites (code, server_id, creator_id, created_at, expires_at, max_uses, uses, revoked) VALUES (?, ?, ?, ?, ?, ?, 0, 0)',
    [code, serverId, req.user.id, now, expiresAt, maxUses]);

  res.status(201).json({ invite: { code, server_id: serverId, creator_id: req.user.id, created_at: now, expires_at: expiresAt, max_uses: maxUses, uses: 0, revoked: false } });
});

router.get('/:serverId/invites', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_SERVER), async (req, res) => {
  const db = await getUserDb();
  const invites = all(db, `
    SELECT i.*, u.username AS creator_username, u.display_name AS creator_display_name
    FROM server_invites i
    LEFT JOIN users u ON u.id = i.creator_id
    WHERE i.server_id = ?
    ORDER BY i.created_at DESC
  `, [req.params.serverId]);
  res.json({ invites: invites.map(i => ({ ...i, revoked: !!i.revoked })) });
});

module.exports = router;
