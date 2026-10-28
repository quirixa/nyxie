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
const fs = require('fs');
const path = require('path');
const { getUserDb, all, get, run, transaction } = require('../database/userDb');
const { getMessageDb, runMessage } = require('../database/messageDb');
const { requireAuth } = require('../middleware/auth');
const {
  PERMISSIONS,
  ALL_PERMISSION_BITS,
  CHANNEL_OVERRIDABLE,
  PERMISSION_CATALOG,
  grantableMask,
  canManageRole,
  canViewRoom,
  createDefaultRoles,
  getDefaultRoleId,
  ensureServerRoles,
  getServerContext,
  hasPermission,
  outranks,
  requireServerPermission
} = require('../services/permissions');
const { recordAudit } = require('../services/audit');
const { UPLOAD_DIR } = require('../config/paths');
const { CATEGORIES, isValidCategory } = require('../services/discoveryCategories');
const { effectiveStatus } = require('../services/presence');

const MAX_SERVER_NAME = 50;
const MAX_SERVER_DESC = 300;
const MAX_CHANNEL_NAME = 32;
const MAX_CHANNEL_TOPIC = 200;
const MAX_ROLE_NAME = 32;
const MAX_REASON = 300;
const MAX_ROLES = 50;
const MAX_CHANNELS = 100;
const MAX_ICON_BYTES = 5 * 1024 * 1024;

function cleanChannelName(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, MAX_CHANNEL_NAME);
}

function syncMemberPrimaryRole(db, serverId, userId) {
  const top = get(db, `
    SELECT sr.id
    FROM server_member_roles smr
    JOIN server_roles sr ON sr.id = smr.role_id AND sr.server_id = smr.server_id
    WHERE smr.server_id = ? AND smr.user_id = ?
    ORDER BY sr.position DESC, sr.created_at ASC
    LIMIT 1
  `, [serverId, userId]);
  run(db, 'UPDATE server_members SET role_id = ? WHERE server_id = ? AND user_id = ?',
    [top?.id || null, serverId, userId]);
}

function getAssignedRoles(db, serverId, userId) {
  return all(db, `
    SELECT sr.id, sr.name, sr.permissions, sr.position, sr.is_default, sr.display_separately, sr.color
    FROM server_member_roles smr
    JOIN server_roles sr ON sr.id = smr.role_id AND sr.server_id = smr.server_id
    WHERE smr.server_id = ? AND smr.user_id = ?
    ORDER BY sr.position DESC, sr.created_at ASC
  `, [serverId, userId]);
}

// Icons reuse the normal upload pipeline (POST /api/upload stores the file
// under data/uploads and returns /uploads/<name>). The server then only
// accepts a reference to such a file if it really is a small raster image:
// allowed extension, real image magic bytes, <= 5 MB. null/'' removes it.
function validateIcon(icon) {
  if (icon === null || icon === '') return { value: null };
  if (typeof icon !== 'string') return { error: 'Invalid icon' };
  const m = /^\/uploads\/([A-Za-z0-9._-]+)$/.exec(icon);
  if (!m || !/\.(png|jpe?g|gif|webp)$/i.test(m[1])) return { error: 'Icon must be a PNG, JPG, GIF or WebP image uploaded through Nyxie' };
  const file = path.join(UPLOAD_DIR, path.basename(m[1]));
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return { error: 'Icon file was not found — upload it again' }; }
  if (!stat.isFile()) return { error: 'Icon file was not found — upload it again' };
  if (stat.size > MAX_ICON_BYTES) return { error: 'Icon must be 5 MB or smaller' };
  let head = Buffer.alloc(12);
  try {
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
  } catch (_) { return { error: 'Icon file could not be read' }; }
  const isPng = head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isGif = head.slice(0, 4).toString('latin1') === 'GIF8';
  const isWebp = head.slice(0, 4).toString('latin1') === 'RIFF' && head.slice(8, 12).toString('latin1') === 'WEBP';
  if (!(isPng || isJpg || isGif || isWebp)) return { error: 'That file is not a valid image' };
  return { value: icon };
}

// Sends `payload` to every current member of the server (sockets only).
function broadcastToServer(req, db, serverId, payload) {
  all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId])
    .forEach(m => req.app.locals.broadcastToUser(m.user_id, payload));
}

// Removes a user's membership AND everything that hangs off it (channel
// memberships and role assignments). Role assignments used to be left
// behind, so a kicked/banned/leaving Admin who later rejoined got Admin
// back. Call inside a transaction.
function removeMemberRows(db, serverId, userId) {
  run(db, 'DELETE FROM room_members WHERE user_id = ? AND room_id IN (SELECT id FROM rooms WHERE server_id = ?)', [userId, serverId]);
  run(db, 'DELETE FROM server_member_roles WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  run(db, 'DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
}

// Replaces a member's role set and refreshes the cached primary role in one
// place so server_member_roles and server_members.role_id cannot disagree.
function setMemberRoles(db, serverId, userId, roleIds) {
  run(db, 'DELETE FROM server_member_roles WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  const now = Date.now();
  for (const roleId of roleIds) {
    run(db, 'INSERT INTO server_member_roles (server_id, user_id, role_id, assigned_at) VALUES (?, ?, ?, ?)', [serverId, userId, roleId, now]);
  }
  syncMemberPrimaryRole(db, serverId, userId);
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

// Permission catalog + the caller's own masks. Served from the server so
// the settings UI always matches what is actually enforced.
router.get('/:serverId/permissions', requireAuth, requireServerPermission(null), (req, res) => {
  res.json({
    catalog: PERMISSION_CATALOG,
    channel_overridable: CHANNEL_OVERRIDABLE,
    my_permissions: req.serverCtx.permissions,
    my_grantable: grantableMask(req.serverCtx),
    is_owner: !!req.serverCtx.isOwner
  });
});

// ─── Server overview ─────────────────────────────────────────────
// Whitelisted fields only (no mass assignment). The permission check, the
// validation, the UPDATE and the audit row all run in one synchronous
// transaction, so concurrent requests cannot interleave with them.
router.patch('/:serverId', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_SERVER), async (req, res) => {
  try {
    const db = await getUserDb();
    const serverId = req.params.serverId;
    const body = req.body || {};
    const current = get(db, 'SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!current) return res.status(404).json({ error: 'Server not found' });

    const next = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') return res.status(400).json({ error: 'Server name must be text' });
      const clean = body.name.trim();
      if (!clean) return res.status(400).json({ error: 'Server name cannot be empty' });
      if (clean.length > MAX_SERVER_NAME) return res.status(400).json({ error: `Server name must be ${MAX_SERVER_NAME} characters or fewer` });
      next.name = clean;
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') return res.status(400).json({ error: 'Description must be text' });
      const clean = (body.description || '').trim();
      if (clean.length > MAX_SERVER_DESC) return res.status(400).json({ error: `Description must be ${MAX_SERVER_DESC} characters or fewer` });
      next.description = clean;
    }
    if (body.icon !== undefined) {
      const v = validateIcon(body.icon);
      if (v.error) return res.status(400).json({ error: v.error });
      next.icon = v.value;
    }
    if (body.is_discoverable !== undefined) {
      if (typeof body.is_discoverable !== 'boolean') return res.status(400).json({ error: 'is_discoverable must be true or false' });
      next.is_discoverable = body.is_discoverable ? 1 : 0;
    }
    if (body.category !== undefined) {
      if (body.category !== null && body.category !== '' && !isValidCategory(body.category)) return res.status(400).json({ error: 'Invalid category' });
      next.category = isValidCategory(body.category) ? body.category : null;
    }

    // Only fields that actually change are written / audited.
    const currentNorm = {
      name: current.name,
      description: current.description || '',
      icon: current.icon || null,
      is_discoverable: current.is_discoverable ? 1 : 0,
      category: current.category || null
    };
    const changes = {};
    for (const [k, v] of Object.entries(next)) {
      if (v !== currentNorm[k]) {
        changes[k] = k === 'is_discoverable'
          ? { before: !!currentNorm[k], after: !!v }
          : { before: currentNorm[k], after: v };
      }
    }
    if (!Object.keys(next).length) return res.status(400).json({ error: 'Nothing to update' });

    if (Object.keys(changes).length) {
      transaction(db, () => {
        const cols = Object.keys(changes);
        run(db, `UPDATE servers SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map(c => next[c]), serverId]);
        const iconChange = changes.icon;
        const rest = { ...changes }; delete rest.icon;
        if (Object.keys(rest).length) {
          recordAudit(db, { serverId, actorId: req.user.id, action: 'server.update', targetType: 'server', targetId: serverId, targetName: next.name || current.name, details: { changes: rest } });
        }
        if (iconChange) {
          recordAudit(db, { serverId, actorId: req.user.id, action: 'server.icon_update', targetType: 'server', targetId: serverId, targetName: next.name || current.name, details: { removed: !iconChange.after, before: iconChange.before, after: iconChange.after } });
        }
      });
    }

    const server = get(db, 'SELECT * FROM servers WHERE id = ?', [serverId]);
    if (Object.keys(changes).length) {
      // Per-user fields (my_permissions, is_owner, my_role, nickname) are
      // deliberately NOT part of this broadcast: the client merges the payload
      // into its cached server, and sending zeroed per-user fields used to wipe
      // the owner's `is_owner` flag until the next reload.
      const { my_role, my_permissions, is_owner, nickname, ...publicFields } = serializeServer(db, server, null);
      broadcastToServer(req, db, serverId, { type: 'server_updated', server: publicFields });
    }
    res.json({ server: serializeServer(db, server, req.serverCtx), changed: Object.keys(changes) });
  } catch (err) {
    console.error('Error updating server:', err);
    res.status(500).json({ error: 'Failed to update server' });
  }
});

// Deleting a server is owner-only and requires the caller to echo the
// server's exact name as `confirm_name` — enforced here, not just in the UI.
router.delete('/:serverId', requireAuth, requireServerPermission(null), async (req, res) => {
  try {
    if (!req.serverCtx.isOwner) return res.status(403).json({ error: 'Only the owner can delete this server' });
    const db = await getUserDb();
    const msgDb = await getMessageDb();
    const serverId = req.params.serverId;
    const confirmName = req.body && typeof req.body.confirm_name === 'string' ? req.body.confirm_name : null;
    if (confirmName === null || confirmName.trim() !== req.serverCtx.server.name) {
      return res.status(400).json({ error: 'Type the exact server name to confirm deletion' });
    }

    const memberIds = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]).map(m => m.user_id);
    const channelIds = all(db, 'SELECT id FROM rooms WHERE server_id = ?', [serverId]).map(r => r.id);

    transaction(db, () => {
      for (const channelId of channelIds) {
        run(db, 'DELETE FROM channel_permission_overrides WHERE channel_id = ?', [channelId]);
        run(db, 'DELETE FROM room_members WHERE room_id = ?', [channelId]);
        run(db, 'DELETE FROM rooms WHERE id = ?', [channelId]);
      }
      run(db, 'DELETE FROM server_categories WHERE server_id = ?', [serverId]);
      run(db, 'DELETE FROM server_member_roles WHERE server_id = ?', [serverId]);
      run(db, 'DELETE FROM server_members WHERE server_id = ?', [serverId]);
      run(db, 'DELETE FROM server_roles WHERE server_id = ?', [serverId]);
      run(db, 'DELETE FROM server_invites WHERE server_id = ?', [serverId]);
      run(db, 'DELETE FROM server_bans WHERE server_id = ?', [serverId]);
      run(db, 'DELETE FROM server_audit_log WHERE server_id = ?', [serverId]);
      run(db, 'DELETE FROM servers WHERE id = ?', [serverId]);
    });
    // Messages live in a separate database; delete them only once the
    // server rows are gone (orphaned rows are harmless, the reverse is not).
    for (const channelId of channelIds) {
      runMessage(msgDb, 'DELETE FROM messages WHERE room_id = ?', [channelId]);
      req.app.locals.closeRoom?.(channelId);
    }

    memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'server_deleted', server_id: serverId }));
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting server:', err);
    res.status(500).json({ error: 'Failed to delete server' });
  }
});

// Ownership transfer. Only the current owner may do it, to another current
// member of the server, and — as with deletion — the caller must echo the
// server's exact name as `confirm_name`; both are enforced here, not in the UI.
// Ownership is derived everywhere from servers.owner_id, so this is one
// UPDATE plus cleanup, done in one synchronous transaction together with the
// audit row. The former owner becomes an ordinary member with whatever roles
// they hold (they are not given Admin automatically).
router.post('/:serverId/transfer-ownership', requireAuth, requireServerPermission(null), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId } = req.params;
    if (!req.serverCtx.isOwner) return res.status(403).json({ error: 'Only the owner can transfer ownership' });

    const body = req.body || {};
    const targetId = typeof body.user_id === 'string' ? body.user_id : null;
    if (!targetId) return res.status(400).json({ error: 'user_id is required' });
    if (targetId === req.user.id) return res.status(400).json({ error: 'You already own this server' });
    const confirmName = typeof body.confirm_name === 'string' ? body.confirm_name : null;
    if (confirmName === null || confirmName.trim() !== req.serverCtx.server.name) {
      return res.status(400).json({ error: 'Type the exact server name to confirm the transfer' });
    }

    // Must be a real, current member (banned users are never members).
    const target = getServerContext(db, serverId, targetId);
    if (!target) return res.status(404).json({ error: 'That user is not a member of this server' });
    const targetUser = get(db, 'SELECT id, username, display_name FROM users WHERE id = ?', [targetId]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    const oldOwner = get(db, 'SELECT username, display_name FROM users WHERE id = ?', [req.user.id]);

    transaction(db, () => {
      run(db, 'UPDATE servers SET owner_id = ? WHERE id = ? AND owner_id = ?', [targetId, serverId, req.user.id]);
      // The `AND owner_id = ?` guard makes a racing second transfer change nothing; detect that
      // BEFORE writing the audit row so a transfer that did not happen is never recorded.
      if (get(db, 'SELECT owner_id FROM servers WHERE id = ?', [serverId])?.owner_id !== targetId) {
        const e = new Error('ownership changed'); e.conflict = true; throw e;
      }
      // An owner can't be timed out, so lift any timeout the new owner had.
      run(db, 'UPDATE server_members SET timeout_until = NULL WHERE server_id = ? AND user_id = ?', [serverId, targetId]);
      recordAudit(db, {
        serverId, actorId: req.user.id, action: 'server.ownership_transfer',
        targetType: 'member', targetId, targetName: targetUser.display_name || targetUser.username,
        details: { from: oldOwner?.display_name || oldOwner?.username || null, to: targetUser.display_name || targetUser.username }
      });
    });

    broadcastToServer(req, db, serverId, { type: 'server_ownership_changed', server_id: serverId, owner_id: targetId, previous_owner_id: req.user.id });
    req.app.locals.revalidateServerRooms?.(serverId);
    res.json({ ok: true, owner_id: targetId });
  } catch (err) {
    if (err && err.conflict) return res.status(409).json({ error: 'Ownership changed while you were transferring it — try again' });
    console.error('Error transferring ownership:', err);
    res.status(500).json({ error: 'Failed to transfer ownership' });
  }
});

router.post('/:serverId/leave', requireAuth, requireServerPermission(null), async (req, res) => {
  try {
    const db = await getUserDb();
    const serverId = req.params.serverId;
    if (req.serverCtx.isOwner) {
      return res.status(400).json({ error: 'The owner cannot leave — transfer ownership or delete the server instead' });
    }
    transaction(db, () => removeMemberRows(db, serverId, req.user.id));

    const payload = { type: 'server_member_left', server_id: serverId, user_id: req.user.id };
    broadcastToServer(req, db, serverId, payload);
    req.app.locals.broadcastToUser(req.user.id, { type: 'server_left', server_id: serverId });
    req.app.locals.revalidateServerRooms?.(serverId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error leaving server:', err);
    res.status(500).json({ error: 'Failed to leave server' });
  }
});

// ─── Members ─────────────────────────────────────────────────────

function serializeRole(r) {
  return {
    id: r.id, name: r.name, position: r.position, permissions: r.permissions,
    color: r.color || null,
    display_separately: !!r.display_separately, is_default: !!r.is_default
  };
}

// Without paging parameters this returns every member exactly as before
// (the chat sidebar's member list depends on that). With `page`,
// `page_size` or `search` it returns one page plus per-member `actions`
// flags computed for the caller. The flags are a convenience for the UI —
// every mutation endpoint re-checks authority on its own.
router.get('/:serverId/members', requireAuth, requireServerPermission(null), async (req, res) => {
  const db = await getUserDb();
  const serverId = req.params.serverId;
  ensureServerRoles(db, serverId);
  const paged = req.query.page !== undefined || req.query.page_size !== undefined || req.query.search !== undefined;
  const ownerId = req.serverCtx.server.owner_id;

  let where = 'sm.server_id = ?';
  const params = [serverId];
  let total = null, page = 1, pageSize = 25, tail = '';
  if (paged) {
    const search = (req.query.search || '').toString().trim().slice(0, 64).toLowerCase();
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, c => '\\' + c)}%`;
      where += ` AND (lower(u.username) LIKE ? ESCAPE '\\' OR lower(u.display_name) LIKE ? ESCAPE '\\' OR lower(COALESCE(sm.nickname,'')) LIKE ? ESCAPE '\\')`;
      params.push(like, like, like);
    }
    if (req.query.role_id) {
      where += ' AND EXISTS (SELECT 1 FROM server_member_roles x WHERE x.server_id = sm.server_id AND x.user_id = sm.user_id AND x.role_id = ?)';
      params.push(String(req.query.role_id));
    }
    if (req.query.timed_out === '1') { where += ' AND sm.timeout_until > ?'; params.push(Date.now()); }
    page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    pageSize = Math.min(Math.max(parseInt(req.query.page_size, 10) || 25, 1), 100);
    total = get(db, `SELECT COUNT(*) AS c FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE ${where}`, params)?.c || 0;
    tail = ` ORDER BY lower(COALESCE(sm.nickname, u.display_name)) ASC, sm.user_id ASC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  }

  const members = all(db, `
    SELECT sm.user_id, sm.joined_at, sm.nickname, sm.muted, sm.role_id, sm.timeout_until,
           u.username, u.display_name, u.avatar, u.avatar_decoration, u.status, u.profile_effect
    FROM server_members sm
    JOIN users u ON u.id = sm.user_id
    WHERE ${where}${tail}
  `, params);

  const actor = req.serverCtx;
  const canRoles = hasPermission(actor, PERMISSIONS.MANAGE_ROLES) || hasPermission(actor, PERMISSIONS.MANAGE_MEMBERS);
  const now = Date.now();
  const isUserConnected = req.app.locals.isUserConnected || (() => false);
  const out = members.map(m => {
    const assignedRoles = getAssignedRoles(db, serverId, m.user_id);
    const highestRole = assignedRoles[0] || null;
    const isOwner = m.user_id === ownerId;
    const item = {
      id: m.user_id,
      username: m.username,
      display_name: m.nickname || m.display_name,
      global_display_name: m.display_name,
      avatar: m.avatar,
      avatar_decoration: m.avatar_decoration || 'none',
      profile_effect: m.profile_effect ? 1 : 0,
      status: effectiveStatus(m.status, { connected: isUserConnected(m.user_id), isSelf: m.user_id === req.user.id }),
      nickname: m.nickname,
      muted: !!m.muted,
      joined_at: m.joined_at,
      timeout_until: m.timeout_until && m.timeout_until > now ? m.timeout_until : null,
      is_owner: isOwner,
      roles: assignedRoles.map(serializeRole),
      // Keep the old single-role shape for any existing client code.
      role: highestRole ? {
        id: highestRole.id, name: highestRole.name, position: highestRole.position,
        permissions: highestRole.permissions, display_separately: !!highestRole.display_separately
      } : null
    };
    if (paged) {
      const above = outranks(actor, { isOwner, rolePosition: highestRole ? highestRole.position : -1 });
      const self = m.user_id === req.user.id;
      item.actions = {
        is_self: self,
        can_edit_roles: canRoles && above,
        can_kick: hasPermission(actor, PERMISSIONS.KICK_MEMBERS) && above && !self,
        can_ban: hasPermission(actor, PERMISSIONS.BAN_MEMBERS) && above && !self,
        can_timeout: hasPermission(actor, PERMISSIONS.MODERATE_MEMBERS) && above && !self,
        can_transfer: !!actor.isOwner && !self
      };
    }
    return item;
  });

  const body = { members: out };
  if (paged) Object.assign(body, { page, page_size: pageSize, total, has_more: (page - 1) * pageSize + out.length < total });
  res.json(body);
});

// Nickname (self, or MANAGE_MEMBERS over members you outrank) and/or roles
// (MANAGE_ROLES or MANAGE_MEMBERS, only over members you outrank, only
// roles strictly below your own highest role, only permissions you hold).
// Roles can be set wholesale (`role_ids`) or changed by delta
// (`add_role_ids` / `remove_role_ids`) — the delta form is safe when two
// moderators edit the same member at once.
router.patch('/:serverId/members/:userId', requireAuth, requireServerPermission(null), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId, userId } = req.params;
    ensureServerRoles(db, serverId);
    const actor = req.serverCtx;
    const targetCtx = getServerContext(db, serverId, userId);
    if (!targetCtx) return res.status(404).json({ error: 'Member not found' });

    const { nickname, role_id, role_ids, add_role_ids, remove_role_ids } = req.body || {};
    const isSelf = userId === req.user.id;
    const targetUser = get(db, 'SELECT username, display_name FROM users WHERE id = ?', [userId]);
    const targetName = targetCtx.nickname || targetUser?.display_name || targetUser?.username || userId;

    let nicknameValue;
    if (nickname !== undefined) {
      if (nickname !== null && typeof nickname !== 'string') return res.status(400).json({ error: 'Nickname must be text' });
      if (!isSelf) {
        if (!hasPermission(actor, PERMISSIONS.MANAGE_MEMBERS)) return res.status(403).json({ error: 'Missing permission' });
        if (!outranks(actor, targetCtx)) return res.status(403).json({ error: 'Cannot change the nickname of an equal or higher-ranked member' });
      }
      nicknameValue = nickname ? nickname.trim().slice(0, 32) : null;
    }

    const wantsRoleUpdate = [role_ids, role_id, add_role_ids, remove_role_ids].some(v => v !== undefined);
    let roleChange = null;
    if (wantsRoleUpdate) {
      if (!hasPermission(actor, PERMISSIONS.MANAGE_ROLES) && !hasPermission(actor, PERMISSIONS.MANAGE_MEMBERS)) {
        return res.status(403).json({ error: 'Missing permission' });
      }
      if (!outranks(actor, targetCtx)) {
        return res.status(403).json({ error: 'Cannot change the roles of an equal or higher-ranked member' });
      }
      const ids = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x)).filter(Boolean))];
      for (const v of [role_ids, add_role_ids, remove_role_ids]) {
        if (v !== undefined && !Array.isArray(v)) return res.status(400).json({ error: 'Role lists must be arrays' });
      }
      const defaultRoleId = getDefaultRoleId(db, serverId);
      const oldIds = new Set(targetCtx.roles.map(r => r.id));
      let newIds;
      if (role_ids !== undefined || role_id !== undefined) {
        newIds = new Set(role_ids !== undefined ? ids(role_ids) : (role_id ? [String(role_id)] : []));
      } else {
        newIds = new Set(oldIds);
        ids(add_role_ids).forEach(x => newIds.add(x));
        ids(remove_role_ids).forEach(x => newIds.delete(x));
      }
      // The base Member role is the server-wide baseline and cannot be removed.
      if (defaultRoleId) newIds.add(defaultRoleId);

      const serverRoles = all(db, 'SELECT * FROM server_roles WHERE server_id = ?', [serverId]);
      const roleMap = new Map(serverRoles.map(r => [r.id, r]));
      for (const id of newIds) if (!roleMap.has(id)) return res.status(400).json({ error: 'One or more roles were not found' });

      const added = [...newIds].filter(id => !oldIds.has(id)).map(id => roleMap.get(id));
      const removed = [...oldIds].filter(id => !newIds.has(id)).map(id => roleMap.get(id)).filter(Boolean);
      const grantable = grantableMask(actor);
      for (const r of added) {
        if (!canManageRole(actor, r)) return res.status(403).json({ error: 'Cannot assign a role equal to or higher than your own' });
        if ((r.permissions & ~grantable) !== 0) return res.status(403).json({ error: 'Cannot assign a role with permissions you do not have' });
      }
      for (const r of removed) {
        if (!canManageRole(actor, r)) return res.status(403).json({ error: 'Cannot remove a role equal to or higher than your own' });
      }
      roleChange = { newIds: [...newIds], added, removed };
    }

    let changed = false;
    transaction(db, () => {
      if (nicknameValue !== undefined && (nicknameValue || null) !== (targetCtx.nickname || null)) {
        run(db, 'UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?', [nicknameValue, serverId, userId]);
        changed = true;
        if (!isSelf) {
          recordAudit(db, { serverId, actorId: req.user.id, action: 'member.nickname_update', targetType: 'member', targetId: userId, targetName: targetUser?.display_name || targetUser?.username, details: { before: targetCtx.nickname || null, after: nicknameValue } });
        }
      }
      if (roleChange && (roleChange.added.length || roleChange.removed.length)) {
        setMemberRoles(db, serverId, userId, roleChange.newIds);
        changed = true;
        recordAudit(db, {
          serverId, actorId: req.user.id, action: 'member.roles_update', targetType: 'member', targetId: userId,
          targetName: targetUser?.display_name || targetUser?.username,
          details: {
            added: roleChange.added.map(r => ({ id: r.id, name: r.name })),
            removed: roleChange.removed.map(r => ({ id: r.id, name: r.name }))
          }
        });
      }
    });

    const updatedCtx = getServerContext(db, serverId, userId);
    const updatedRoles = getAssignedRoles(db, serverId, userId);
    if (changed) {
      broadcastToServer(req, db, serverId, {
        type: 'server_member_updated',
        server_id: serverId,
        user_id: userId,
        nickname: updatedCtx.nickname,
        role_id: updatedCtx.roleId,
        role_ids: updatedRoles.map(r => r.id)
      });
      if (roleChange) req.app.locals.revalidateServerRooms?.(serverId);
    }
    res.json({ ok: true, changed, roles: updatedRoles.map(serializeRole) });
  } catch (err) {
    console.error('Error updating member:', err);
    res.status(500).json({ error: 'Failed to update member' });
  }
});

function readReason(req) {
  const r = req.body && req.body.reason;
  if (r === undefined || r === null || r === '') return { value: null };
  if (typeof r !== 'string') return { error: 'Reason must be text' };
  const clean = r.trim();
  if (clean.length > MAX_REASON) return { error: `Reason must be ${MAX_REASON} characters or fewer` };
  return { value: clean || null };
}

router.delete('/:serverId/members/:userId', requireAuth, requireServerPermission(PERMISSIONS.KICK_MEMBERS), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId, userId } = req.params;
    if (userId === req.user.id) return res.status(400).json({ error: 'You cannot kick yourself — use Leave Server instead' });
    if (userId === req.serverCtx.server.owner_id) return res.status(403).json({ error: 'Cannot kick the server owner' });
    const reason = readReason(req);
    if (reason.error) return res.status(400).json({ error: reason.error });

    const targetCtx = getServerContext(db, serverId, userId);
    if (!targetCtx) return res.status(404).json({ error: 'Member not found' });
    if (!outranks(req.serverCtx, targetCtx)) return res.status(403).json({ error: 'Cannot kick an equal or higher-ranked member' });
    const targetUser = get(db, 'SELECT username, display_name FROM users WHERE id = ?', [userId]);

    transaction(db, () => {
      removeMemberRows(db, serverId, userId);
      recordAudit(db, { serverId, actorId: req.user.id, action: 'member.kick', targetType: 'member', targetId: userId, targetName: targetUser?.display_name || targetUser?.username, reason: reason.value });
    });

    req.app.locals.broadcastToUser(userId, { type: 'server_member_kicked', server_id: serverId, user_id: userId });
    broadcastToServer(req, db, serverId, { type: 'server_member_left', server_id: serverId, user_id: userId });
    req.app.locals.revalidateServerRooms?.(serverId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error kicking member:', err);
    res.status(500).json({ error: 'Failed to kick member' });
  }
});

// ─── Bans ────────────────────────────────────────────────────────

router.get('/:serverId/bans', requireAuth, requireServerPermission(PERMISSIONS.BAN_MEMBERS), async (req, res) => {
  const db = await getUserDb();
  const search = (req.query.search || '').toString().trim().slice(0, 64).toLowerCase();
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.page_size, 10) || 25, 1), 100);
  let where = 'b.server_id = ?';
  const params = [req.params.serverId];
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, c => '\\' + c)}%`;
    where += ` AND (lower(u.username) LIKE ? ESCAPE '\\' OR lower(u.display_name) LIKE ? ESCAPE '\\' OR lower(COALESCE(b.reason,'')) LIKE ? ESCAPE '\\')`;
    params.push(like, like, like);
  }
  const total = get(db, `SELECT COUNT(*) AS c FROM server_bans b JOIN users u ON u.id = b.user_id WHERE ${where}`, params)?.c || 0;
  const bans = all(db, `
    SELECT b.user_id, b.reason, b.created_at, b.banned_by, u.username, u.display_name, u.avatar,
           bu.username AS banned_by_username, bu.display_name AS banned_by_display_name
    FROM server_bans b
    JOIN users u ON u.id = b.user_id
    LEFT JOIN users bu ON bu.id = b.banned_by
    WHERE ${where}
    ORDER BY b.created_at DESC, b.user_id ASC
    LIMIT ? OFFSET ?
  `, [...params, pageSize, (page - 1) * pageSize]);
  res.json({ bans, page, page_size: pageSize, total, has_more: (page - 1) * pageSize + bans.length < total });
});

router.post('/:serverId/bans/:userId', requireAuth, requireServerPermission(PERMISSIONS.BAN_MEMBERS), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId, userId } = req.params;
    if (userId === req.user.id) return res.status(400).json({ error: 'You cannot ban yourself' });
    if (userId === req.serverCtx.server.owner_id) return res.status(403).json({ error: 'Cannot ban the server owner' });
    const reason = readReason(req);
    if (reason.error) return res.status(400).json({ error: reason.error });

    const targetUser = get(db, 'SELECT id, username, display_name FROM users WHERE id = ?', [userId]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    const targetCtx = getServerContext(db, serverId, userId);
    if (targetCtx && !outranks(req.serverCtx, targetCtx)) {
      return res.status(403).json({ error: 'Cannot ban an equal or higher-ranked member' });
    }
    // Repeating a ban is a no-op: it must not overwrite who banned them
    // or when, and must not create a second audit row.
    if (get(db, 'SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, userId])) {
      return res.json({ ok: true, already_banned: true });
    }

    transaction(db, () => {
      run(db, 'INSERT INTO server_bans (server_id, user_id, banned_by, reason, created_at) VALUES (?, ?, ?, ?, ?)',
        [serverId, userId, req.user.id, reason.value, Date.now()]);
      if (targetCtx) removeMemberRows(db, serverId, userId);
      recordAudit(db, { serverId, actorId: req.user.id, action: 'member.ban', targetType: 'member', targetId: userId, targetName: targetUser.display_name || targetUser.username, reason: reason.value, details: { was_member: !!targetCtx } });
    });

    if (targetCtx) {
      req.app.locals.broadcastToUser(userId, { type: 'server_member_banned', server_id: serverId, user_id: userId });
      broadcastToServer(req, db, serverId, { type: 'server_member_left', server_id: serverId, user_id: userId });
      req.app.locals.revalidateServerRooms?.(serverId);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error banning member:', err);
    res.status(500).json({ error: 'Failed to ban member' });
  }
});

router.delete('/:serverId/bans/:userId', requireAuth, requireServerPermission(PERMISSIONS.BAN_MEMBERS), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId, userId } = req.params;
    if (!get(db, 'SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, userId])) {
      return res.status(404).json({ error: 'That user is not banned' });
    }
    const targetUser = get(db, 'SELECT username, display_name FROM users WHERE id = ?', [userId]);
    transaction(db, () => {
      run(db, 'DELETE FROM server_bans WHERE server_id = ? AND user_id = ?', [serverId, userId]);
      recordAudit(db, { serverId, actorId: req.user.id, action: 'member.unban', targetType: 'member', targetId: userId, targetName: targetUser?.display_name || targetUser?.username });
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error unbanning member:', err);
    res.status(500).json({ error: 'Failed to unban member' });
  }
});

// ─── Roles ───────────────────────────────────────────────────────

function permissionKeys(mask) {
  return Object.keys(PERMISSIONS).filter(k => (mask & PERMISSIONS[k]) !== 0);
}

function validateRoleName(name) {
  if (typeof name !== 'string') return { error: 'Role name must be text' };
  const clean = name.trim();
  if (!clean) return { error: 'Role name cannot be empty' };
  if (clean.length > MAX_ROLE_NAME) return { error: `Role name must be ${MAX_ROLE_NAME} characters or fewer` };
  return { value: clean };
}

function validateColor(color) {
  if (color === null || color === '') return { value: null };
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return { error: 'Role colour must look like #RRGGBB' };
  return { value: color.toLowerCase() };
}

function validatePermissions(p) {
  if (!Number.isInteger(p) || p < 0) return { error: 'Permissions must be a non-negative integer' };
  if ((p & ~ALL_PERMISSION_BITS) !== 0) return { error: 'Unknown permission bits' };
  return { value: p };
}

function bool(v) { return v === true || v === 1 || v === '1'; }

router.get('/:serverId/roles', requireAuth, requireServerPermission(null), async (req, res) => {
  const db = await getUserDb();
  const roles = all(db, `
    SELECT r.*, (SELECT COUNT(*) FROM server_member_roles m WHERE m.server_id = r.server_id AND m.role_id = r.id) AS member_count
    FROM server_roles r WHERE r.server_id = ? ORDER BY r.position DESC, r.created_at ASC
  `, [req.params.serverId]);
  res.json({ roles: roles.map(r => ({ ...r, color: r.color || null })) });
});

router.post('/:serverId/roles', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_ROLES), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId } = req.params;
    const actor = req.serverCtx;
    const body = req.body || {};
    const name = validateRoleName(body.name);
    if (name.error) return res.status(400).json({ error: name.error });
    const color = validateColor(body.color === undefined ? null : body.color);
    if (color.error) return res.status(400).json({ error: color.error });
    const perms = validatePermissions(body.permissions === undefined ? 0 : body.permissions);
    if (perms.error) return res.status(400).json({ error: perms.error });

    // A new role is always created at the bottom of the hierarchy (just
    // above the default role), so it can never outrank its creator, and the
    // creator can reorder it afterwards. Someone whose only role is the
    // default one has no rank to create beneath.
    if (!actor.isOwner && actor.rolePosition < 1) return res.status(403).json({ error: 'You need a role above the default role to create roles' });
    if ((perms.value & ~grantableMask(actor)) !== 0) return res.status(403).json({ error: 'Cannot grant permissions you do not have' });
    const count = get(db, 'SELECT COUNT(*) AS c FROM server_roles WHERE server_id = ?', [serverId])?.c || 0;
    if (count >= MAX_ROLES) return res.status(400).json({ error: `A server can have at most ${MAX_ROLES} roles` });

    const id = crypto.randomUUID();
    transaction(db, () => {
      run(db, 'UPDATE server_roles SET position = position + 1 WHERE server_id = ? AND is_default = 0', [serverId]);
      run(db, `INSERT INTO server_roles (id, server_id, name, permissions, position, is_default, display_separately, color, created_at)
               VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)`,
        [id, serverId, name.value, perms.value, bool(body.display_separately) ? 1 : 0, color.value, Date.now()]);
      recordAudit(db, { serverId, actorId: req.user.id, action: 'role.create', targetType: 'role', targetId: id, targetName: name.value, details: { permissions: permissionKeys(perms.value), color: color.value } });
    });

    const role = get(db, 'SELECT * FROM server_roles WHERE id = ?', [id]);
    broadcastToServer(req, db, serverId, { type: 'server_role_created', server_id: serverId, role });
    res.status(201).json({ role: { ...role, member_count: 0 } });
  } catch (err) {
    console.error('Error creating role:', err);
    res.status(500).json({ error: 'Failed to create role' });
  }
});

// Declared before '/:roleId' so "order" is never read as a role id (they use
// different HTTP methods anyway, which keeps the two unambiguous).
// Body: { role_ids: [every non-default role, highest first] }.
router.put('/:serverId/roles/order', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_ROLES), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId } = req.params;
    const actor = req.serverCtx;
    const ids = req.body && req.body.role_ids;
    if (!Array.isArray(ids) || ids.some(x => typeof x !== 'string')) return res.status(400).json({ error: 'role_ids must be an array of role ids' });

    const roles = all(db, 'SELECT * FROM server_roles WHERE server_id = ? AND is_default = 0 ORDER BY position DESC, created_at ASC', [serverId]);
    const oldIds = roles.map(r => r.id);
    if (ids.length !== oldIds.length || new Set(ids).size !== ids.length || !ids.every(id => oldIds.includes(id))) {
      return res.status(400).json({ error: 'role_ids must list every non-default role exactly once' });
    }
    if (ids.every((id, i) => id === oldIds[i])) return res.json({ ok: true, changed: false });

    // Anyone who is not the owner may only reorder roles strictly below
    // their own highest role: the roles at or above it (including their own)
    // must stay exactly where they are, which also means nobody can raise a
    // role to or above their own rank — the escalation route reordering
    // would otherwise open.
    if (!actor.isOwner) {
      const fixedCount = roles.filter(r => r.position >= actor.rolePosition).length;
      for (let i = 0; i < fixedCount; i++) {
        if (ids[i] !== oldIds[i]) return res.status(403).json({ error: 'Cannot move roles at or above your own highest role' });
      }
    }

    const nameOf = new Map(roles.map(r => [r.id, r.name]));
    transaction(db, () => {
      ids.forEach((id, i) => run(db, 'UPDATE server_roles SET position = ? WHERE id = ? AND server_id = ?', [ids.length - i, id, serverId]));
      recordAudit(db, { serverId, actorId: req.user.id, action: 'role.reorder', targetType: 'server', targetId: serverId, details: { before: oldIds.map(i => nameOf.get(i)), after: ids.map(i => nameOf.get(i)) } });
    });
    broadcastToServer(req, db, serverId, { type: 'server_role_updated', server_id: serverId, role: null });
    res.json({ ok: true, changed: true });
  } catch (err) {
    console.error('Error reordering roles:', err);
    res.status(500).json({ error: 'Failed to reorder roles' });
  }
});

router.patch('/:serverId/roles/:roleId', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_ROLES), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId, roleId } = req.params;
    const actor = req.serverCtx;
    const role = get(db, 'SELECT * FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId]);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (!canManageRole(actor, role)) return res.status(403).json({ error: 'Cannot edit a role at or above your own rank' });

    const body = req.body || {};
    const next = {};
    if (body.name !== undefined) {
      const v = validateRoleName(body.name);
      if (v.error) return res.status(400).json({ error: v.error });
      next.name = v.value;
    }
    if (body.color !== undefined) {
      const v = validateColor(body.color);
      if (v.error) return res.status(400).json({ error: v.error });
      next.color = v.value;
    }
    if (body.display_separately !== undefined) next.display_separately = bool(body.display_separately) ? 1 : 0;
    if (body.permissions !== undefined) {
      const v = validatePermissions(body.permissions);
      if (v.error) return res.status(400).json({ error: v.error });
      // Bits the actor cannot grant must be left exactly as they are:
      // can't be added, and can't be stripped from a role either.
      const locked = ~grantableMask(actor);
      if ((v.value & locked) !== ((role.permissions | 0) & locked)) {
        return res.status(403).json({ error: 'Cannot change permissions you do not have' });
      }
      next.permissions = v.value;
    }
    if (!Object.keys(next).length) return res.status(400).json({ error: 'Nothing to update' });

    const changed = Object.keys(next).filter(k => (next[k] === null ? (role[k] || null) !== null : next[k] !== role[k]));
    if (!changed.length) return res.json({ role: { ...role, color: role.color || null }, changed: false });

    transaction(db, () => {
      run(db, `UPDATE server_roles SET ${changed.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND server_id = ?`, [...changed.map(c => next[c]), roleId, serverId]);
      const nonPerm = changed.filter(c => c !== 'permissions');
      if (nonPerm.length) {
        const diff = {};
        nonPerm.forEach(c => { diff[c] = { before: role[c] ?? null, after: next[c] }; });
        recordAudit(db, { serverId, actorId: req.user.id, action: 'role.update', targetType: 'role', targetId: roleId, targetName: next.name || role.name, details: { changes: diff } });
      }
      if (changed.includes('permissions')) {
        const b = permissionKeys(role.permissions | 0), a = permissionKeys(next.permissions);
        recordAudit(db, { serverId, actorId: req.user.id, action: 'role.permissions_update', targetType: 'role', targetId: roleId, targetName: next.name || role.name, details: { added: a.filter(k => !b.includes(k)), removed: b.filter(k => !a.includes(k)) } });
      }
    });

    const updated = get(db, 'SELECT * FROM server_roles WHERE id = ?', [roleId]);
    broadcastToServer(req, db, serverId, { type: 'server_role_updated', server_id: serverId, role: updated });
    if (changed.includes('permissions')) req.app.locals.revalidateServerRooms?.(serverId);
    res.json({ role: { ...updated, color: updated.color || null }, changed: true });
  } catch (err) {
    console.error('Error updating role:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

router.delete('/:serverId/roles/:roleId', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_ROLES), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId, roleId } = req.params;
    const role = get(db, 'SELECT * FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId]);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (role.is_default) return res.status(400).json({ error: 'Cannot delete the default role' });
    if (!canManageRole(req.serverCtx, role)) return res.status(403).json({ error: 'Cannot delete a role at or above your own rank' });

    const affectedMembers = all(db, 'SELECT user_id FROM server_member_roles WHERE server_id = ? AND role_id = ?', [serverId, roleId]).map(r => r.user_id);
    transaction(db, () => {
      run(db, 'DELETE FROM server_member_roles WHERE server_id = ? AND role_id = ?', [serverId, roleId]);
      run(db, 'DELETE FROM channel_permission_overrides WHERE role_id = ?', [roleId]);
      run(db, 'DELETE FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId]);
      // Members keep the baseline role and have their cached primary role
      // refreshed; leftover positions are renumbered to stay contiguous.
      const fallbackRoleId = getDefaultRoleId(db, serverId);
      for (const userId of affectedMembers) {
        if (fallbackRoleId) {
          run(db, 'INSERT OR IGNORE INTO server_member_roles (server_id, user_id, role_id, assigned_at) VALUES (?, ?, ?, ?)', [serverId, userId, fallbackRoleId, Date.now()]);
        }
        syncMemberPrimaryRole(db, serverId, userId);
      }
      const rest = all(db, 'SELECT id FROM server_roles WHERE server_id = ? AND is_default = 0 ORDER BY position DESC, created_at ASC', [serverId]);
      rest.forEach((r, i) => run(db, 'UPDATE server_roles SET position = ? WHERE id = ?', [rest.length - i, r.id]));
      recordAudit(db, { serverId, actorId: req.user.id, action: 'role.delete', targetType: 'role', targetId: roleId, targetName: role.name, details: { permissions: permissionKeys(role.permissions | 0), members_affected: affectedMembers.length } });
    });

    broadcastToServer(req, db, serverId, { type: 'server_role_deleted', server_id: serverId, role_id: roleId });
    req.app.locals.revalidateServerRooms?.(serverId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting role:', err);
    res.status(500).json({ error: 'Failed to delete role' });
  }
});

// ─── Channels ────────────────────────────────────────────────────
// Listing/creation are server-scoped (need serverId to check
// membership/permissions and to know which server to attach the new
// channel to); rename/delete of an existing channel live in
// routes/channels.js, addressed by channelId alone.

// By default only channels the caller can actually view are returned (a
// private channel's existence and name are not leaked to people who cannot
// see it). `?scope=manage` returns every channel for the settings page and
// requires MANAGE_CHANNELS.
router.get('/:serverId/channels', requireAuth, requireServerPermission(null), async (req, res) => {
  const db = await getUserDb();
  const serverId = req.params.serverId;
  const manage = req.query.scope === 'manage';
  if (manage && !hasPermission(req.serverCtx, PERMISSIONS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'Missing permission' });
  let channels = all(db, `
    SELECT r.id, r.name, r.description, r.created_at, r.created_by, r.position, r.category_id,
           (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) AS member_count
    FROM rooms r
    WHERE r.server_id = ? AND r.is_dm = 0
    ORDER BY r.position ASC, r.created_at ASC
  `, [serverId]);
  if (!manage) channels = channels.filter(c => canViewRoom(db, { id: c.id, server_id: serverId }, req.user.id));
  const categories = all(db, 'SELECT id, name, position FROM server_categories WHERE server_id = ? ORDER BY position ASC, created_at ASC', [serverId]);
  res.json({ channels, categories });
});

router.post('/:serverId/channels', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_CHANNELS), async (req, res) => {
  try {
    const db = await getUserDb();
    const serverId = req.params.serverId;
    const { name, description, category_id } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Channel name required' });
    if (description !== undefined && description !== null && typeof description !== 'string') return res.status(400).json({ error: 'Topic must be text' });
    const topic = (description || '').trim();
    if (topic.length > MAX_CHANNEL_TOPIC) return res.status(400).json({ error: `Topic must be ${MAX_CHANNEL_TOPIC} characters or fewer` });

    const cleanName = cleanChannelName(name);
    if (!cleanName) return res.status(400).json({ error: 'Invalid channel name' });
    let categoryId = null;
    if (category_id) {
      if (!get(db, 'SELECT 1 FROM server_categories WHERE id = ? AND server_id = ?', [String(category_id), serverId])) return res.status(400).json({ error: 'Category not found' });
      categoryId = String(category_id);
    }
    const count = get(db, 'SELECT COUNT(*) AS c FROM rooms WHERE server_id = ? AND is_dm = 0', [serverId])?.c || 0;
    if (count >= MAX_CHANNELS) return res.status(400).json({ error: `A server can have at most ${MAX_CHANNELS} channels` });

    const channelId = crypto.randomUUID();
    const now = Date.now();
    const maxPos = get(db, 'SELECT MAX(position) AS m FROM rooms WHERE server_id = ? AND is_dm = 0', [serverId])?.m;
    const position = Number.isInteger(maxPos) ? maxPos + 1 : 0;
    let members;
    transaction(db, () => {
      run(db, `INSERT INTO rooms (id, server_id, name, description, created_by, created_at, is_dm, position, category_id)
               VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [channelId, serverId, cleanName, topic, req.user.id, now, position, categoryId]);
      members = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]);
      for (const m of members) {
        run(db, 'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [channelId, m.user_id, now]);
      }
      recordAudit(db, { serverId, actorId: req.user.id, action: 'channel.create', targetType: 'channel', targetId: channelId, targetName: cleanName, details: { topic, category_id: categoryId } });
    });

    const channel = { id: channelId, server_id: serverId, name: cleanName, description: topic, position, category_id: categoryId };
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
  try {
    const db = await getUserDb();
    const { serverId } = req.params;
    let { expires_in_seconds, max_uses } = req.body || {};

    let code;
    do { code = generateInviteCode(); } while (get(db, 'SELECT 1 FROM server_invites WHERE code = ?', [code]));

    const now = Date.now();
    const expiresAt = Number.isFinite(expires_in_seconds) && expires_in_seconds > 0 ? now + expires_in_seconds * 1000 : null;
    const maxUses = Number.isInteger(max_uses) && max_uses > 0 ? Math.min(max_uses, 10000) : null;

    transaction(db, () => {
      run(db, 'INSERT INTO server_invites (code, server_id, creator_id, created_at, expires_at, max_uses, uses, revoked) VALUES (?, ?, ?, ?, ?, ?, 0, 0)',
        [code, serverId, req.user.id, now, expiresAt, maxUses]);
      recordAudit(db, { serverId, actorId: req.user.id, action: 'invite.create', targetType: 'invite', targetId: code, targetName: code, details: { max_uses: maxUses, expires_at: expiresAt } });
    });

    res.status(201).json({ invite: { code, server_id: serverId, creator_id: req.user.id, created_at: now, expires_at: expiresAt, max_uses: maxUses, uses: 0, revoked: false } });
  } catch (err) {
    console.error('Error creating invite:', err);
    res.status(500).json({ error: 'Failed to create invite' });
  }
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
