// server/services/permissions.js — server role/permission model shared by
// routes/servers.js, routes/rooms.js (channel messages) and anywhere else
// that needs to know "can this user do X in this server".
//
// Permissions are a bitmask (like Discord's), stored as a single INTEGER
// on server_roles.permissions. This keeps custom roles possible later
// (routes/servers.js exposes basic role CRUD) without a schema change —
// a new permission is just a new bit.
//
// The server owner (servers.owner_id) always has every permission,
// regardless of which role they're assigned — ownership can't be
// permissioned away, and there is deliberately no "un-owner" operation
// short of deleting the server.

const crypto = require('crypto');
const { get, all, run } = require('../database/userDb');

const PERMISSIONS = Object.freeze({
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  MANAGE_CHANNELS: 1 << 2,
  MANAGE_SERVER: 1 << 3,
  MANAGE_MEMBERS: 1 << 4,
  CREATE_INVITES: 1 << 5,
  KICK_MEMBERS: 1 << 6,
  BAN_MEMBERS: 1 << 7,
  MANAGE_MESSAGES: 1 << 8,
  MANAGE_ROLES: 1 << 9,
  ADMINISTRATOR: 1 << 10,
  // 0.2.0 — every bit below is enforced by real code (see the catalog
  // further down for where). New bits only ever get appended.
  VIEW_AUDIT_LOG: 1 << 11,
  MODERATE_MEMBERS: 1 << 12,       // time out / un-time-out members
  READ_MESSAGE_HISTORY: 1 << 13,
  ATTACH_FILES: 1 << 14
});

// Every real permission except ADMINISTRATOR (kept as before: this is the
// "ordinary" set; ADMINISTRATOR is the override-everything switch).
const ALL_PERMISSIONS = Object.keys(PERMISSIONS)
  .filter(k => k !== 'ADMINISTRATOR')
  .reduce((mask, k) => mask | PERMISSIONS[k], 0);

// Every defined bit including ADMINISTRATOR. Used to reject unknown bits
// in role payloads and as the effective mask of owners/administrators.
const ALL_PERMISSION_BITS = ALL_PERMISSIONS | PERMISSIONS.ADMINISTRATOR;

// The subset that a channel can override per role. These are exactly the
// permissions that are evaluated per channel in canViewRoom/canSendToRoom/
// canReadHistory/canAttachInRoom below.
const CHANNEL_OVERRIDABLE =
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.READ_MESSAGE_HISTORY |
  PERMISSIONS.ATTACH_FILES;

// Human-readable catalog served to the Server Settings UI so the client
// never keeps its own (drift-prone) copy of the permission list.
const PERMISSION_CATALOG = [
  {
    id: 'general', label: 'General server permissions',
    items: [
      { key: 'VIEW_CHANNEL', label: 'View channels', description: 'See channels and open them.' },
      { key: 'MANAGE_SERVER', label: 'Manage server', description: 'Change the server name, description, icon and discovery settings; manage invites.' },
      { key: 'MANAGE_CHANNELS', label: 'Manage channels', description: 'Create, edit, reorder and delete channels and categories, and edit channel permissions.' },
      { key: 'MANAGE_ROLES', label: 'Manage roles', description: 'Create, edit, reorder and delete roles below their own highest role, and assign them.' },
      { key: 'VIEW_AUDIT_LOG', label: 'View audit log', description: 'Read the server audit log.' },
      { key: 'CREATE_INVITES', label: 'Invite members', description: 'Create invite links.' }
    ]
  },
  {
    id: 'membership', label: 'Membership and moderation',
    items: [
      { key: 'MANAGE_MEMBERS', label: 'Manage members', description: 'Change other members\u2019 nicknames and assign roles below their own highest role.' },
      { key: 'KICK_MEMBERS', label: 'Kick members', description: 'Remove members who rank below them.' },
      { key: 'BAN_MEMBERS', label: 'Ban members', description: 'Ban and unban members.' },
      { key: 'MODERATE_MEMBERS', label: 'Timeout members', description: 'Temporarily stop members who rank below them from sending messages.' }
    ]
  },
  {
    id: 'text', label: 'Text-channel permissions',
    items: [
      { key: 'SEND_MESSAGES', label: 'Send messages', description: 'Post messages in channels.' },
      { key: 'READ_MESSAGE_HISTORY', label: 'Read message history', description: 'Load messages that were sent before they opened the channel.' },
      { key: 'ATTACH_FILES', label: 'Attach files', description: 'Upload files and images with a message.' },
      { key: 'MANAGE_MESSAGES', label: 'Manage messages', description: 'Delete other members\u2019 messages.' }
    ]
  },
  {
    id: 'advanced', label: 'Advanced',
    items: [
      { key: 'ADMINISTRATOR', label: 'Administrator', description: 'Grants every permission and bypasses channel overrides. Only the owner and other administrators can grant this.' }
    ]
  }
].map(cat => ({
  ...cat,
  items: cat.items.map(i => ({
    ...i,
    bit: PERMISSIONS[i.key],
    channel_overridable: (CHANNEL_OVERRIDABLE & PERMISSIONS[i.key]) !== 0
  }))
}));

// Default permission sets for the three roles every new server gets.
const DEFAULT_ROLE_DEFS = [
  { key: 'admin', name: 'Admin', permissions: PERMISSIONS.ADMINISTRATOR, position: 100, is_default: 0, display_separately: 1 },
  {
    key: 'moderator',
    name: 'Moderator',
    permissions:
      PERMISSIONS.VIEW_CHANNEL |
      PERMISSIONS.SEND_MESSAGES |
      PERMISSIONS.CREATE_INVITES |
      PERMISSIONS.KICK_MEMBERS |
      PERMISSIONS.MANAGE_MESSAGES |
      PERMISSIONS.MODERATE_MEMBERS |
      PERMISSIONS.READ_MESSAGE_HISTORY |
      PERMISSIONS.ATTACH_FILES,
    position: 50,
    is_default: 0,
    display_separately: 1
  },
  {
    key: 'member',
    name: 'Member',
    permissions:
      PERMISSIONS.VIEW_CHANNEL |
      PERMISSIONS.SEND_MESSAGES |
      PERMISSIONS.CREATE_INVITES |
      PERMISSIONS.READ_MESSAGE_HISTORY |
      PERMISSIONS.ATTACH_FILES,
    position: 0,
    is_default: 1,
    display_separately: 0
  }
];

// Creates the Admin/Moderator/Member roles for a brand-new server and
// returns their ids so the caller can assign the creator to Admin.
function createDefaultRoles(db, serverId, now) {
  const ids = {};
  for (const def of DEFAULT_ROLE_DEFS) {
    const id = crypto.randomUUID();
    ids[def.key] = id;
    run(db, `
      INSERT INTO server_roles (id, server_id, name, permissions, position, is_default, display_separately, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, serverId, def.name, def.permissions, def.position, def.is_default, def.display_separately ? 1 : 0, now]);
  }
  return ids;
}

function getDefaultRoleId(db, serverId) {
  const row = get(db, 'SELECT id FROM server_roles WHERE server_id = ? AND is_default = 1 LIMIT 1', [serverId]);
  return row ? row.id : null;
}

// Servers created before this feature existed (e.g. the 'nyxie-default'
// server seeded in userDb.js) have no rows in server_roles at all.
// Lazily backfill them the first time anything touches that server's
// permissions, rather than requiring a one-off migration script: create
// the three default roles, put the owner on Admin, and put every other
// existing member on the default Member role.
function ensureMemberRoleAssignments(db, serverId) {
  // Migrate the old one-role-per-member column into the new many-to-many
  // assignment table. Only rows that are actually missing are inserted:
  // run() persists the whole database after every statement, and this
  // function is reached from every permission check, so re-inserting
  // every member on every call (INSERT OR IGNORE) was needlessly O(members)
  // disk writes per request. Behaviour is identical.
  const now = Date.now();
  const missing = all(db, `
    SELECT sm.server_id, sm.user_id, sm.role_id
    FROM server_members sm
    WHERE sm.server_id = ? AND sm.role_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM server_member_roles smr
        WHERE smr.server_id = sm.server_id AND smr.user_id = sm.user_id AND smr.role_id = sm.role_id
      )
  `, [serverId]);
  for (const row of missing) {
    run(db, `
      INSERT OR IGNORE INTO server_member_roles (server_id, user_id, role_id, assigned_at)
      VALUES (?, ?, ?, ?)
    `, [row.server_id, row.user_id, row.role_id, now]);
  }
}

function getMemberRoles(db, serverId, userId) {
  ensureMemberRoleAssignments(db, serverId);
  return all(db, `
    SELECT sr.id, sr.name, sr.permissions, sr.position, sr.is_default, sr.display_separately
    FROM server_member_roles smr
    JOIN server_roles sr ON sr.id = smr.role_id AND sr.server_id = smr.server_id
    WHERE smr.server_id = ? AND smr.user_id = ?
    ORDER BY sr.position DESC, sr.created_at ASC
  `, [serverId, userId]);
}

// Servers created before the role system existed (or before multi-role
// assignments were added) are upgraded lazily. Existing role_id values are
// copied into server_member_roles without changing the member's behavior.
function ensureServerRoles(db, serverId) {
  // The table is normally created by userDb.js. Keep this defensive creation
  // here too so old/alternate database initialization paths remain safe.
  db.run(`
    CREATE TABLE IF NOT EXISTS server_member_roles (
      server_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      assigned_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, user_id, role_id)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_server_member_roles_member ON server_member_roles (server_id, user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_server_member_roles_role ON server_member_roles (server_id, role_id)');

  const existing = get(db, 'SELECT id FROM server_roles WHERE server_id = ? LIMIT 1', [serverId]);
  if (!existing) {
    const server = get(db, 'SELECT owner_id FROM servers WHERE id = ?', [serverId]);
    if (!server) return;

    const now = Date.now();
    const roleIds = createDefaultRoles(db, serverId, now);
    const members = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]);
    for (const m of members) {
      const roleId = m.user_id === server.owner_id ? roleIds.admin : roleIds.member;
      run(db, 'UPDATE server_members SET role_id = ? WHERE server_id = ? AND user_id = ? AND role_id IS NULL', [roleId, serverId, m.user_id]);
    }
  }

  ensureMemberRoleAssignments(db, serverId);

  // Every member gets the base Member role. This keeps the old Nyxie
  // permission behavior while allowing additional roles to stack on top.
  const defaultRoleId = getDefaultRoleId(db, serverId);
  if (defaultRoleId) {
    const lacking = all(db, `
      SELECT sm.user_id FROM server_members sm
      WHERE sm.server_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM server_member_roles smr
          WHERE smr.server_id = sm.server_id AND smr.user_id = sm.user_id AND smr.role_id = ?
        )
    `, [serverId, defaultRoleId]);
    for (const m of lacking) {
      run(db, `
        INSERT OR IGNORE INTO server_member_roles (server_id, user_id, role_id, assigned_at)
        VALUES (?, ?, ?, ?)
      `, [serverId, m.user_id, defaultRoleId, Date.now()]);
    }
  }
}

// Full context needed to make a permission decision for one user in one
// server: whether they're the owner, which role (if any) they hold, and
// the effective permission bitmask. Returns null if the user isn't a
// member of the server at all.
function getServerContext(db, serverId, userId) {
  const server = get(db, 'SELECT * FROM servers WHERE id = ?', [serverId]);
  if (!server) return null;
  ensureServerRoles(db, serverId);

  const membership = get(db, `
    SELECT sm.server_id, sm.user_id, sm.joined_at, sm.role_id, sm.nickname, sm.muted, sm.timeout_until
    FROM server_members sm
    WHERE sm.server_id = ? AND sm.user_id = ?
  `, [serverId, userId]);
  if (!membership) return null;

  const roles = getMemberRoles(db, serverId, userId);
  const highestRole = roles[0] || null;
  const permissions = roles.reduce((mask, role) => mask | (role.permissions || 0), 0);
  const isOwner = server.owner_id === userId;

  return {
    server,
    isOwner,
    roleId: highestRole?.id || membership.role_id || null,
    roleName: highestRole?.name || null,
    rolePosition: highestRole?.position != null ? highestRole.position : -1,
    permissions,
    roles,
    nickname: membership.nickname || null,
    muted: !!membership.muted,
    timeoutUntil: membership.timeout_until || null
  };
}

function hasPermission(ctx, permBit) {
  if (!ctx) return false;
  if (ctx.isOwner) return true;
  if (ctx.permissions & PERMISSIONS.ADMINISTRATOR) return true;
  return (ctx.permissions & permBit) !== 0;
}

// True if `actor` is allowed to take a moderation action (kick/ban/role
// change) against `target` — the owner can act on anyone, nobody can act
// on the owner, and otherwise a strictly higher role position is
// required. This is what stops a Moderator from kicking an Admin, and
// stops any non-owner from touching the owner at all.
function outranks(actorCtx, targetCtx) {
  if (!actorCtx || !targetCtx) return false;
  if (actorCtx.isOwner) return true;
  if (targetCtx.isOwner) return false;
  return actorCtx.rolePosition > targetCtx.rolePosition;
}

// Express middleware factory: 404s if the server doesn't exist, 403s if
// the user isn't a member, 403s if the user lacks `permBit`. On success
// attaches req.serverCtx for the route handler to reuse (avoids a second
// query for the same data).
function requireServerPermission(permBit) {
  return async (req, res, next) => {
    try {
      const db = await require('../database/userDb').getUserDb();
      const serverId = req.params.serverId;
      const ctx = getServerContext(db, serverId, req.user.id);
      if (!ctx) return res.status(404).json({ error: 'Server not found or not a member' });
      if (permBit != null && !hasPermission(ctx, permBit)) {
        return res.status(403).json({ error: 'Missing permission' });
      }
      req.serverCtx = ctx;
      next();
    } catch (err) {
      console.error('Permission check failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// ─── Hierarchy / grant helpers ────────────────────────────────────

// The permission bits `ctx` may hand out to others (put on a role, or
// allow/deny in a channel override). Owners and administrators can grant
// anything; everyone else only what they hold themselves. (Before this,
// a non-owner Administrator's mask was just the single ADMINISTRATOR bit,
// so "requested & mask" silently stripped every permission off roles they
// created.)
function grantableMask(ctx) {
  if (!ctx) return 0;
  if (ctx.isOwner || (ctx.permissions & PERMISSIONS.ADMINISTRATOR)) return ALL_PERMISSION_BITS;
  return ctx.permissions & ALL_PERMISSION_BITS;
}

// True if `ctx` may edit/delete/assign/reorder `role` (strictly below the
// actor's highest role; the owner may touch any role).
function canManageRole(ctx, role) {
  if (!ctx || !role) return false;
  if (ctx.isOwner) return true;
  return role.position < ctx.rolePosition;
}

// ─── Per-channel permissions ──────────────────────────────────────
//
// Evaluation order (documented in README):
//   1. Owner / ADMINISTRATOR: every permission, overrides ignored.
//   2. Start from the union of the member's role permissions (server level).
//   3. Apply the default (@everyone-equivalent) role's override for the channel:
//      perms = (perms & ~deny) | allow
//   4. Apply the combined overrides of the member's other roles (all their
//      denies OR-ed, all their allows OR-ed): perms = (perms & ~deny) | allow
//   So a role-level allow beats any deny, and any deny beats the server-level grant.
function getChannelPermissions(db, ctx, channelId) {
  if (!ctx) return 0;
  if (ctx.isOwner || (ctx.permissions & PERMISSIONS.ADMINISTRATOR)) return ALL_PERMISSION_BITS;
  let perms = ctx.permissions;
  if (!channelId) return perms;
  const overrides = all(db, 'SELECT role_id, allow, deny FROM channel_permission_overrides WHERE channel_id = ?', [channelId]);
  if (!overrides.length) return perms;

  const byRole = new Map(overrides.map(o => [o.role_id, o]));
  const defaultRole = ctx.roles.find(r => r.is_default);
  const defOv = defaultRole && byRole.get(defaultRole.id);
  if (defOv) perms = (perms & ~(defOv.deny | 0)) | (defOv.allow | 0);

  let allow = 0, deny = 0;
  for (const r of ctx.roles) {
    if (r.is_default) continue;
    const ov = byRole.get(r.id);
    if (ov) { allow |= ov.allow | 0; deny |= ov.deny | 0; }
  }
  return (perms & ~deny) | allow;
}

function isTimedOut(ctx, now = Date.now()) {
  return !!(ctx && !ctx.isOwner && ctx.timeoutUntil && ctx.timeoutUntil > now);
}

// True if `userId` may currently view `room` (a rooms row with at least
// id/server_id). DMs and groups: membership alone. Server channels:
// membership AND the effective per-channel VIEW_CHANNEL permission.
function canViewRoom(db, room, userId) {
  const isMember = !!get(db, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', [room.id, userId]);
  if (!isMember) return false;
  if (!room.server_id) return true;
  const ctx = getServerContext(db, room.server_id, userId);
  return (getChannelPermissions(db, ctx, room.id) & PERMISSIONS.VIEW_CHANNEL) !== 0;
}

// Same, but also returns the effective permission mask for the room so a
// caller that needs several checks only evaluates once. DMs get every bit.
function getRoomAccess(db, room, userId) {
  const isMember = !!get(db, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', [room.id, userId]);
  if (!isMember) return { member: false, ctx: null, perms: 0 };
  if (!room.server_id) return { member: true, ctx: null, perms: ALL_PERMISSION_BITS };
  const ctx = getServerContext(db, room.server_id, userId);
  return { member: true, ctx, perms: getChannelPermissions(db, ctx, room.id) };
}

// True if `userId` may currently send messages into `room`.
function canSendToRoom(db, room, userId) {
  const acc = getRoomAccess(db, room, userId);
  if (!acc.member || !(acc.perms & PERMISSIONS.VIEW_CHANNEL)) return false;
  if (!room.server_id) return true;
  if (acc.ctx && acc.ctx.muted && !acc.ctx.isOwner) return false;
  if (isTimedOut(acc.ctx)) return false;
  return (acc.perms & PERMISSIONS.SEND_MESSAGES) !== 0;
}

// Reading older messages needs VIEW_CHANNEL + READ_MESSAGE_HISTORY.
function canReadHistory(db, room, userId) {
  const acc = getRoomAccess(db, room, userId);
  if (!acc.member || !(acc.perms & PERMISSIONS.VIEW_CHANNEL)) return false;
  if (!room.server_id) return true;
  return (acc.perms & PERMISSIONS.READ_MESSAGE_HISTORY) !== 0;
}

function canAttachInRoom(db, room, userId) {
  const acc = getRoomAccess(db, room, userId);
  if (!acc.member || !(acc.perms & PERMISSIONS.VIEW_CHANNEL)) return false;
  if (!room.server_id) return true;
  return (acc.perms & PERMISSIONS.ATTACH_FILES) !== 0;
}

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS,
  ALL_PERMISSION_BITS,
  CHANNEL_OVERRIDABLE,
  PERMISSION_CATALOG,
  grantableMask,
  canManageRole,
  getChannelPermissions,
  isTimedOut,
  canViewRoom,
  canSendToRoom,
  canReadHistory,
  canAttachInRoom,
  getRoomAccess,
  createDefaultRoles,
  getDefaultRoleId,
  ensureServerRoles,
  getServerContext,
  hasPermission,
  outranks,
  requireServerPermission
};
