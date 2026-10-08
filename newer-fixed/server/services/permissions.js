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
  ADMINISTRATOR: 1 << 10
});

const ALL_PERMISSIONS = Object.keys(PERMISSIONS)
  .filter(k => k !== 'ADMINISTRATOR')
  .reduce((mask, k) => mask | PERMISSIONS[k], 0);

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
      PERMISSIONS.MANAGE_MESSAGES,
    position: 50,
    is_default: 0,
    display_separately: 1
  },
  {
    key: 'member',
    name: 'Member',
    permissions: PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.CREATE_INVITES,
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
  // assignment table. INSERT OR IGNORE makes this safe to run repeatedly.
  const now = Date.now();
  const legacy = all(db, `
    SELECT server_id, user_id, role_id
    FROM server_members
    WHERE server_id = ? AND role_id IS NOT NULL
  `, [serverId]);
  for (const row of legacy) {
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
    const members = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [serverId]);
    for (const m of members) {
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
    SELECT sm.server_id, sm.user_id, sm.joined_at, sm.role_id, sm.nickname, sm.muted
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
    muted: !!membership.muted
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

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS,
  createDefaultRoles,
  getDefaultRoleId,
  ensureServerRoles,
  getServerContext,
  hasPermission,
  outranks,
  requireServerPermission
};
