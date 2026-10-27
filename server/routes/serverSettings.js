// server/routes/serverSettings.js — the parts of Server Settings that are
// new in 0.2.0: audit log, member timeouts, categories, channel layout, and
// per-channel permission overrides. Mounted on /api/servers next to
// routes/servers.js, which keeps the existing server/member/role/ban/invite
// endpoints. Every handler authenticates, resolves the server through
// requireServerPermission (membership + permission), re-checks hierarchy
// where it matters, validates, then mutates + audits in one transaction.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getUserDb, all, get, run, transaction } = require('../database/userDb');
const { requireAuth } = require('../middleware/auth');
const {
  PERMISSIONS,
  CHANNEL_OVERRIDABLE,
  grantableMask,
  canManageRole,
  getServerContext,
  hasPermission,
  outranks,
  requireServerPermission
} = require('../services/permissions');
const { ACTIONS, recordAudit, queryAudit } = require('../services/audit');

const MAX_CATEGORY_NAME = 32;
const MAX_CATEGORIES = 30;
const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 28 * 24 * 60 * 60;
const MAX_REASON = 300;

function toServer(req, db, serverId, payload) {
  all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId])
    .forEach(m => req.app.locals.broadcastToUser(m.user_id, payload));
}

// Tells every client in the server to re-fetch its channel list.
function refreshChannels(req, db, serverId) {
  toServer(req, db, serverId, { type: 'server_channels_refresh', server_id: serverId });
  req.app.locals.revalidateServerRooms?.(serverId);
}

function permKeys(mask) {
  return Object.keys(PERMISSIONS).filter(k => (mask & PERMISSIONS[k]) !== 0);
}

// ─── Audit log ───────────────────────────────────────────────────

router.get('/:serverId/audit-log', requireAuth, requireServerPermission(PERMISSIONS.VIEW_AUDIT_LOG), async (req, res) => {
  try {
    const db = await getUserDb();
    const num = v => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const result = queryAudit(db, req.params.serverId, {
      action: req.query.action ? String(req.query.action) : undefined,
      actor_id: req.query.actor_id ? String(req.query.actor_id) : undefined,
      target_id: req.query.target_id ? String(req.query.target_id) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      from: num(req.query.from),
      to: num(req.query.to),
      page: req.query.page,
      page_size: req.query.page_size
    });
    res.json({ ...result, actions: Object.entries(ACTIONS).map(([id, label]) => ({ id, label })) });
  } catch (err) {
    console.error('Error reading audit log:', err);
    res.status(500).json({ error: 'Failed to load the audit log' });
  }
});

// ─── Timeouts ────────────────────────────────────────────────────
// A timeout is a persisted `timeout_until` on the membership. It is
// enforced by services/permissions.js canSendToRoom (REST message posting)
// and by the WebSocket typing signal, and expires on its own.

router.post('/:serverId/members/:userId/timeout', requireAuth, requireServerPermission(PERMISSIONS.MODERATE_MEMBERS), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId, userId } = req.params;
    const body = req.body || {};
    const seconds = body.duration_seconds;
    if (!Number.isInteger(seconds) || seconds < MIN_TIMEOUT_SECONDS || seconds > MAX_TIMEOUT_SECONDS) {
      return res.status(400).json({ error: 'Timeout must be between 1 minute and 28 days' });
    }
    let reason = null;
    if (body.reason !== undefined && body.reason !== null && body.reason !== '') {
      if (typeof body.reason !== 'string' || body.reason.trim().length > MAX_REASON) return res.status(400).json({ error: `Reason must be text of ${MAX_REASON} characters or fewer` });
      reason = body.reason.trim() || null;
    }
    if (userId === req.user.id) return res.status(400).json({ error: 'You cannot time yourself out' });
    if (userId === req.serverCtx.server.owner_id) return res.status(403).json({ error: 'Cannot time out the server owner' });
    const targetCtx = getServerContext(db, serverId, userId);
    if (!targetCtx) return res.status(404).json({ error: 'Member not found' });
    if (!outranks(req.serverCtx, targetCtx)) return res.status(403).json({ error: 'Cannot time out an equal or higher-ranked member' });
    const targetUser = get(db, 'SELECT username, display_name FROM users WHERE id = ?', [userId]);

    const until = Date.now() + seconds * 1000;
    transaction(db, () => {
      run(db, 'UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?', [until, serverId, userId]);
      recordAudit(db, { serverId, actorId: req.user.id, action: 'member.timeout', targetType: 'member', targetId: userId, targetName: targetUser?.display_name || targetUser?.username, reason, details: { duration_seconds: seconds, until } });
    });
    toServer(req, db, serverId, { type: 'server_member_updated', server_id: serverId, user_id: userId, timeout_until: until });
    req.app.locals.revalidateServerRooms?.(serverId); // refresh cached send-permission checks on live sockets
    res.json({ ok: true, timeout_until: until });
  } catch (err) {
    console.error('Error timing out member:', err);
    res.status(500).json({ error: 'Failed to time out member' });
  }
});

router.delete('/:serverId/members/:userId/timeout', requireAuth, requireServerPermission(PERMISSIONS.MODERATE_MEMBERS), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId, userId } = req.params;
    const targetCtx = getServerContext(db, serverId, userId);
    if (!targetCtx) return res.status(404).json({ error: 'Member not found' });
    if (!targetCtx.timeoutUntil || targetCtx.timeoutUntil <= Date.now()) return res.status(404).json({ error: 'That member is not timed out' });
    if (userId !== req.user.id && !outranks(req.serverCtx, targetCtx)) return res.status(403).json({ error: 'Cannot change the timeout of an equal or higher-ranked member' });
    // Nobody may lift their own timeout: that would make it meaningless.
    if (userId === req.user.id && !req.serverCtx.isOwner) return res.status(403).json({ error: 'You cannot remove your own timeout' });
    const targetUser = get(db, 'SELECT username, display_name FROM users WHERE id = ?', [userId]);

    transaction(db, () => {
      run(db, 'UPDATE server_members SET timeout_until = NULL WHERE server_id = ? AND user_id = ?', [serverId, userId]);
      recordAudit(db, { serverId, actorId: req.user.id, action: 'member.timeout_remove', targetType: 'member', targetId: userId, targetName: targetUser?.display_name || targetUser?.username });
    });
    toServer(req, db, serverId, { type: 'server_member_updated', server_id: serverId, user_id: userId, timeout_until: null });
    req.app.locals.revalidateServerRooms?.(serverId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error removing timeout:', err);
    res.status(500).json({ error: 'Failed to remove timeout' });
  }
});

// ─── Categories ──────────────────────────────────────────────────

function cleanCategoryName(name) {
  if (typeof name !== 'string') return { error: 'Category name must be text' };
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) return { error: 'Category name cannot be empty' };
  if (clean.length > MAX_CATEGORY_NAME) return { error: `Category name must be ${MAX_CATEGORY_NAME} characters or fewer` };
  return { value: clean };
}

router.post('/:serverId/categories', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_CHANNELS), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId } = req.params;
    const name = cleanCategoryName(req.body && req.body.name);
    if (name.error) return res.status(400).json({ error: name.error });
    const count = get(db, 'SELECT COUNT(*) AS c FROM server_categories WHERE server_id = ?', [serverId])?.c || 0;
    if (count >= MAX_CATEGORIES) return res.status(400).json({ error: `A server can have at most ${MAX_CATEGORIES} categories` });
    const maxPos = get(db, 'SELECT MAX(position) AS m FROM server_categories WHERE server_id = ?', [serverId])?.m;
    const position = Number.isInteger(maxPos) ? maxPos + 1 : 0;
    const id = crypto.randomUUID();
    transaction(db, () => {
      run(db, 'INSERT INTO server_categories (id, server_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)', [id, serverId, name.value, position, Date.now()]);
      recordAudit(db, { serverId, actorId: req.user.id, action: 'category.create', targetType: 'category', targetId: id, targetName: name.value });
    });
    refreshChannels(req, db, serverId);
    res.status(201).json({ category: { id, name: name.value, position } });
  } catch (err) {
    console.error('Error creating category:', err);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

router.patch('/:serverId/categories/:categoryId', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_CHANNELS), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId, categoryId } = req.params;
    const cat = get(db, 'SELECT * FROM server_categories WHERE id = ? AND server_id = ?', [categoryId, serverId]);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    const name = cleanCategoryName(req.body && req.body.name);
    if (name.error) return res.status(400).json({ error: name.error });
    if (name.value === cat.name) return res.json({ category: { id: cat.id, name: cat.name, position: cat.position }, changed: false });
    transaction(db, () => {
      run(db, 'UPDATE server_categories SET name = ? WHERE id = ? AND server_id = ?', [name.value, categoryId, serverId]);
      recordAudit(db, { serverId, actorId: req.user.id, action: 'category.update', targetType: 'category', targetId: categoryId, targetName: name.value, details: { before: cat.name, after: name.value } });
    });
    refreshChannels(req, db, serverId);
    res.json({ category: { id: cat.id, name: name.value, position: cat.position }, changed: true });
  } catch (err) {
    console.error('Error renaming category:', err);
    res.status(500).json({ error: 'Failed to rename category' });
  }
});

// Deleting a category never deletes its channels: they become uncategorized.
router.delete('/:serverId/categories/:categoryId', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_CHANNELS), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId, categoryId } = req.params;
    const cat = get(db, 'SELECT * FROM server_categories WHERE id = ? AND server_id = ?', [categoryId, serverId]);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    const moved = get(db, 'SELECT COUNT(*) AS c FROM rooms WHERE server_id = ? AND category_id = ?', [serverId, categoryId])?.c || 0;
    transaction(db, () => {
      run(db, 'UPDATE rooms SET category_id = NULL WHERE server_id = ? AND category_id = ?', [serverId, categoryId]);
      run(db, 'DELETE FROM server_categories WHERE id = ? AND server_id = ?', [categoryId, serverId]);
      recordAudit(db, { serverId, actorId: req.user.id, action: 'category.delete', targetType: 'category', targetId: categoryId, targetName: cat.name, details: { channels_uncategorized: moved } });
    });
    refreshChannels(req, db, serverId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting category:', err);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// ─── Layout (order + category membership) ────────────────────────
// Body: { categories: [categoryId...], channels: [{ id, category_id|null }...] }
// Both lists must be complete. Array order becomes the stored order.
router.put('/:serverId/channel-layout', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_CHANNELS), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId } = req.params;
    const body = req.body || {};
    if (!Array.isArray(body.categories) || !Array.isArray(body.channels)) return res.status(400).json({ error: 'categories and channels must be arrays' });

    const cats = all(db, 'SELECT * FROM server_categories WHERE server_id = ? ORDER BY position ASC, created_at ASC', [serverId]);
    const chans = all(db, 'SELECT id, name, category_id, position FROM rooms WHERE server_id = ? AND is_dm = 0 ORDER BY position ASC, created_at ASC', [serverId]);
    const catIds = cats.map(c => c.id);
    const chanIds = chans.map(c => c.id);

    const reqCats = body.categories.map(String);
    const reqChans = body.channels.map(c => ({ id: String(c && c.id), category_id: c && c.category_id ? String(c.category_id) : null }));
    if (reqCats.length !== catIds.length || new Set(reqCats).size !== reqCats.length || !reqCats.every(id => catIds.includes(id))) {
      return res.status(400).json({ error: 'categories must list every category exactly once' });
    }
    if (reqChans.length !== chanIds.length || new Set(reqChans.map(c => c.id)).size !== reqChans.length || !reqChans.every(c => chanIds.includes(c.id))) {
      return res.status(400).json({ error: 'channels must list every channel exactly once' });
    }
    if (reqChans.some(c => c.category_id && !catIds.includes(c.category_id))) return res.status(400).json({ error: 'Unknown category in channels' });

    const chanById = new Map(chans.map(c => [c.id, c]));
    const moved = reqChans.filter(c => (chanById.get(c.id).category_id || null) !== c.category_id);
    const orderChanged = reqChans.some((c, i) => c.id !== chanIds[i]);
    const catOrderChanged = reqCats.some((id, i) => id !== catIds[i]);
    if (!moved.length && !orderChanged && !catOrderChanged) return res.json({ ok: true, changed: false });

    const catName = new Map(cats.map(c => [c.id, c.name]));
    transaction(db, () => {
      reqCats.forEach((id, i) => run(db, 'UPDATE server_categories SET position = ? WHERE id = ? AND server_id = ?', [i, id, serverId]));
      reqChans.forEach((c, i) => run(db, 'UPDATE rooms SET position = ?, category_id = ? WHERE id = ? AND server_id = ?', [i, c.category_id, c.id, serverId]));
      if (catOrderChanged) recordAudit(db, { serverId, actorId: req.user.id, action: 'category.reorder', targetType: 'server', targetId: serverId, details: { before: catIds.map(i => catName.get(i)), after: reqCats.map(i => catName.get(i)) } });
      for (const c of moved) {
        const ch = chanById.get(c.id);
        recordAudit(db, { serverId, actorId: req.user.id, action: 'channel.move', targetType: 'channel', targetId: c.id, targetName: ch.name, details: { from_category: ch.category_id ? catName.get(ch.category_id) || null : null, to_category: c.category_id ? catName.get(c.category_id) : null } });
      }
      const movedIds = new Set(moved.map(c => c.id));
      const sameOrderWithoutMoved = reqChans.filter(c => !movedIds.has(c.id)).map(c => c.id).join() === chanIds.filter(id => !movedIds.has(id)).join();
      if (orderChanged && !(moved.length && sameOrderWithoutMoved)) {
        recordAudit(db, { serverId, actorId: req.user.id, action: 'channel.reorder', targetType: 'server', targetId: serverId });
      }
    });
    refreshChannels(req, db, serverId);
    res.json({ ok: true, changed: true });
  } catch (err) {
    console.error('Error saving channel layout:', err);
    res.status(500).json({ error: 'Failed to save the channel layout' });
  }
});

// ─── Channel permission overrides ────────────────────────────────
// Per-channel, per-role allow/deny masks over CHANNEL_OVERRIDABLE only.
// How they combine with server-level permissions is documented in
// services/permissions.js getChannelPermissions (and the README).

function loadChannel(db, serverId, channelId) {
  return get(db, 'SELECT id, name, server_id FROM rooms WHERE id = ? AND server_id = ? AND is_dm = 0', [channelId, serverId]);
}

router.get('/:serverId/channels/:channelId/overrides', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_CHANNELS), async (req, res) => {
  const db = await getUserDb();
  const { serverId, channelId } = req.params;
  if (!loadChannel(db, serverId, channelId)) return res.status(404).json({ error: 'Channel not found' });
  const overrides = all(db, `
    SELECT o.role_id, o.allow, o.deny, r.name AS role_name, r.color AS role_color, r.position AS role_position, r.is_default
    FROM channel_permission_overrides o
    JOIN server_roles r ON r.id = o.role_id AND r.server_id = ?
    WHERE o.channel_id = ? ORDER BY r.position DESC
  `, [serverId, channelId]);
  res.json({ overrides, channel_overridable: CHANNEL_OVERRIDABLE });
});

router.put('/:serverId/channels/:channelId/overrides/:roleId', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_CHANNELS), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId, channelId, roleId } = req.params;
    const actor = req.serverCtx;
    const channel = loadChannel(db, serverId, channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const role = get(db, 'SELECT * FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId]);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (!canManageRole(actor, role)) return res.status(403).json({ error: 'Cannot set permissions for a role at or above your own rank' });

    const { allow, deny } = req.body || {};
    if (!Number.isInteger(allow) || !Number.isInteger(deny) || allow < 0 || deny < 0) return res.status(400).json({ error: 'allow and deny must be non-negative integers' });
    if (((allow | deny) & ~CHANNEL_OVERRIDABLE) !== 0) return res.status(400).json({ error: 'Those permissions cannot be overridden per channel' });
    if ((allow & deny) !== 0) return res.status(400).json({ error: 'A permission cannot be both allowed and denied' });

    const current = get(db, 'SELECT allow, deny FROM channel_permission_overrides WHERE channel_id = ? AND role_id = ?', [channelId, roleId]) || { allow: 0, deny: 0 };
    // Bits the actor does not hold themselves cannot be changed by them.
    const locked = ~grantableMask(actor);
    if ((allow & locked) !== (current.allow & locked) || (deny & locked) !== (current.deny & locked)) {
      return res.status(403).json({ error: 'Cannot change permissions you do not have' });
    }
    if (allow === current.allow && deny === current.deny) return res.json({ ok: true, changed: false });

    transaction(db, () => {
      if (allow === 0 && deny === 0) {
        run(db, 'DELETE FROM channel_permission_overrides WHERE channel_id = ? AND role_id = ?', [channelId, roleId]);
      } else {
        run(db, 'INSERT OR REPLACE INTO channel_permission_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)', [channelId, roleId, allow, deny]);
      }
      recordAudit(db, {
        serverId, actorId: req.user.id,
        action: allow === 0 && deny === 0 ? 'channel.permissions_remove' : 'channel.permissions_update',
        targetType: 'channel', targetId: channelId, targetName: channel.name,
        details: { role: role.name, before: { allow: permKeys(current.allow), deny: permKeys(current.deny) }, after: { allow: permKeys(allow), deny: permKeys(deny) } }
      });
    });
    refreshChannels(req, db, serverId);
    res.json({ ok: true, changed: true });
  } catch (err) {
    console.error('Error saving channel override:', err);
    res.status(500).json({ error: 'Failed to save channel permissions' });
  }
});

router.delete('/:serverId/channels/:channelId/overrides/:roleId', requireAuth, requireServerPermission(PERMISSIONS.MANAGE_CHANNELS), async (req, res) => {
  try {
    const db = await getUserDb();
    const { serverId, channelId, roleId } = req.params;
    const actor = req.serverCtx;
    const channel = loadChannel(db, serverId, channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const role = get(db, 'SELECT * FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId]);
    const current = get(db, 'SELECT allow, deny FROM channel_permission_overrides WHERE channel_id = ? AND role_id = ?', [channelId, roleId]);
    if (!role || !current) return res.status(404).json({ error: 'Override not found' });
    if (!canManageRole(actor, role)) return res.status(403).json({ error: 'Cannot set permissions for a role at or above your own rank' });
    const locked = ~grantableMask(actor);
    if ((current.allow & locked) !== 0 || (current.deny & locked) !== 0) return res.status(403).json({ error: 'Cannot change permissions you do not have' });

    transaction(db, () => {
      run(db, 'DELETE FROM channel_permission_overrides WHERE channel_id = ? AND role_id = ?', [channelId, roleId]);
      recordAudit(db, { serverId, actorId: req.user.id, action: 'channel.permissions_remove', targetType: 'channel', targetId: channelId, targetName: channel.name, details: { role: role.name, before: { allow: permKeys(current.allow), deny: permKeys(current.deny) } } });
    });
    refreshChannels(req, db, serverId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error removing channel override:', err);
    res.status(500).json({ error: 'Failed to remove channel permissions' });
  }
});

module.exports = router;
