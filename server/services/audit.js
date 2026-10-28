// server/services/audit.js — persistent, append-only server audit log.
//
// Contract for callers (routes/servers.js, routes/serverSettings.js,
// routes/channels.js, routes/invites.js):
//   * call recordAudit() INSIDE the same transaction() as the mutation,
//     after the mutation succeeded. If recording fails it throws, the
//     transaction rolls back, and the request fails — the app never has
//     an administrative change without its audit row, nor an audit row for
//     a change that did not happen.
//   * actorId must come from req.user.id (the authenticated identity),
//     never from the request body.
//
// What is NOT stored: passwords, tokens, keys, message content. Details
// are passed through sanitizeDetails(), which drops any key that looks
// secret-ish or content-ish and truncates long strings.
const crypto = require('crypto');
const { all, get, run } = require('../database/userDb');

const ACTIONS = Object.freeze({
  'server.update': 'Server settings changed',
  'server.icon_update': 'Server icon changed',
  'server.ownership_transfer': 'Ownership transferred',
  'invite.create': 'Invite created',
  'invite.revoke': 'Invite revoked',
  'role.create': 'Role created',
  'role.update': 'Role updated',
  'role.permissions_update': 'Role permissions changed',
  'role.delete': 'Role deleted',
  'role.reorder': 'Roles reordered',
  'member.roles_update': 'Member roles changed',
  'member.nickname_update': 'Member nickname changed',
  'member.kick': 'Member kicked',
  'member.ban': 'Member banned',
  'member.unban': 'Member unbanned',
  'member.timeout': 'Member timed out',
  'member.timeout_remove': 'Timeout removed',
  'channel.create': 'Channel created',
  'channel.update': 'Channel updated',
  'channel.move': 'Channel moved',
  'channel.reorder': 'Channels reordered',
  'channel.delete': 'Channel deleted',
  'channel.permissions_update': 'Channel permissions changed',
  'channel.permissions_remove': 'Channel permission override removed',
  'category.create': 'Category created',
  'category.update': 'Category renamed',
  'category.delete': 'Category deleted',
  'category.reorder': 'Categories reordered'
});

// Keys whose values must never be persisted, wherever they appear.
const FORBIDDEN_KEY = /pass(word)?|token|secret|private|key|hash|pin\b|content|ciphertext|nonce|envelope|authorization|cookie/i;
const MAX_STRING = 300;
const MAX_ARRAY = 50;
const MAX_DEPTH = 4;

function sanitizeDetails(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map(v => sanitizeDetails(v, depth + 1)).filter(v => v !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) continue;
      const clean = sanitizeDetails(v, depth + 1);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  return undefined;
}

// Writes one audit row. Throws on any problem (invalid action, db error).
function recordAudit(db, { serverId, actorId, action, targetType = null, targetId = null, targetName = null, reason = null, details = null }) {
  if (!serverId || !actorId) throw new Error('audit: serverId and actorId are required');
  if (!ACTIONS[action]) throw new Error(`audit: unknown action "${action}"`);
  const id = crypto.randomUUID();
  const cleanDetails = details ? sanitizeDetails(details) : null;
  run(db, `
    INSERT INTO server_audit_log (id, server_id, actor_id, action, target_type, target_id, target_name, reason, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id, serverId, actorId, action,
    targetType, targetId != null ? String(targetId) : null,
    targetName != null ? String(targetName).slice(0, 100) : null,
    reason ? String(reason).slice(0, 300) : null,
    cleanDetails ? JSON.stringify(cleanDetails) : null,
    Date.now()
  ]);
  return id;
}

function escapeLike(s) { return s.replace(/[\\%_]/g, c => '\\' + c); }

// Reads a page of audit entries for one server, newest first.
// Filters (all optional): action (exact, or a group like "member" / "role"),
// actor_id, target_id, q (matches target name or reason), from/to (epoch ms).
function queryAudit(db, serverId, f = {}) {
  const where = ['a.server_id = ?'];
  const params = [serverId];
  if (f.action) {
    if (ACTIONS[f.action]) { where.push('a.action = ?'); params.push(f.action); }
    else if (/^[a-z_]+$/.test(f.action)) { where.push("a.action LIKE ? ESCAPE '\\'"); params.push(escapeLike(f.action) + '.%'); }
    else where.push('1 = 0');
  }
  if (f.actor_id) { where.push('a.actor_id = ?'); params.push(String(f.actor_id)); }
  if (f.target_id) { where.push('a.target_id = ?'); params.push(String(f.target_id)); }
  if (Number.isFinite(f.from)) { where.push('a.created_at >= ?'); params.push(f.from); }
  if (Number.isFinite(f.to)) { where.push('a.created_at <= ?'); params.push(f.to); }
  if (f.q) {
    const like = `%${escapeLike(String(f.q).toLowerCase().slice(0, 100))}%`;
    where.push(`(lower(COALESCE(a.target_name,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(a.reason,'')) LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }
  const W = where.join(' AND ');
  const pageSize = Math.min(Math.max(parseInt(f.page_size, 10) || 25, 1), 50);
  const page = Math.max(parseInt(f.page, 10) || 1, 1);

  const total = get(db, `SELECT COUNT(*) AS c FROM server_audit_log a WHERE ${W}`, params)?.c || 0;
  const rows = all(db, `
    SELECT a.*, u.username AS actor_username, u.display_name AS actor_display_name, u.avatar AS actor_avatar
    FROM server_audit_log a
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE ${W}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ? OFFSET ?
  `, [...params, pageSize, (page - 1) * pageSize]);

  const entries = rows.map(r => {
    let details = null;
    try { details = r.details ? JSON.parse(r.details) : null; } catch (_) { /* keep null */ }
    const actorName = r.actor_display_name || r.actor_username || 'Unknown user';
    return {
      id: r.id,
      server_id: r.server_id,
      action: r.action,
      action_label: ACTIONS[r.action] || r.action,
      actor: { id: r.actor_id, username: r.actor_username || null, display_name: actorName, avatar: r.actor_avatar || null },
      target_type: r.target_type,
      target_id: r.target_id,
      target_name: r.target_name,
      reason: r.reason,
      details,
      description: describe(r.action, actorName, r.target_name, details),
      created_at: r.created_at
    };
  });
  return { entries, page, page_size: pageSize, total, has_more: (page - 1) * pageSize + entries.length < total };
}

function q(name) { return name ? `“${name}”` : 'unknown'; }

// One-line readable description. Built from structured data at read time.
function describe(action, actor, target, d) {
  const t = q(target);
  switch (action) {
    case 'server.update': {
      const fields = d && d.changes ? Object.keys(d.changes) : [];
      return `${actor} changed the server ${fields.length ? fields.join(', ') : 'settings'}`;
    }
    case 'server.ownership_transfer': return `${actor} transferred ownership of the server to ${target || 'another member'}`;
    case 'server.icon_update': return `${actor} ${d && d.removed ? 'removed' : 'changed'} the server icon`;
    case 'invite.create': return `${actor} created an invite`;
    case 'invite.revoke': return `${actor} revoked an invite`;
    case 'role.create': return `${actor} created the role ${t}`;
    case 'role.update': return `${actor} updated the role ${t}`;
    case 'role.permissions_update': return `${actor} changed the permissions of ${t}`;
    case 'role.delete': return `${actor} deleted the role ${t}`;
    case 'role.reorder': return `${actor} reordered the server roles`;
    case 'member.roles_update': {
      const add = (d && d.added) || [], rem = (d && d.removed) || [];
      const bits = [];
      if (add.length) bits.push(`added ${add.map(r => r.name).join(', ')}`);
      if (rem.length) bits.push(`removed ${rem.map(r => r.name).join(', ')}`);
      return `${actor} ${bits.join(' and ') || 'updated roles'} for ${target || 'a member'}`;
    }
    case 'member.nickname_update': return `${actor} changed the nickname of ${target || 'a member'}`;
    case 'member.kick': return `${actor} kicked ${target || 'a member'}`;
    case 'member.ban': return `${actor} banned ${target || 'a member'}`;
    case 'member.unban': return `${actor} unbanned ${target || 'a member'}`;
    case 'member.timeout': return `${actor} timed out ${target || 'a member'}${d && d.duration_seconds ? ` for ${fmtDuration(d.duration_seconds)}` : ''}`;
    case 'member.timeout_remove': return `${actor} removed the timeout from ${target || 'a member'}`;
    case 'channel.create': return `${actor} created the channel ${t}`;
    case 'channel.update': return `${actor} updated the channel ${t}`;
    case 'channel.move': return `${actor} moved the channel ${t}`;
    case 'channel.reorder': return `${actor} reordered the channels`;
    case 'channel.delete': return `${actor} deleted the channel ${t}`;
    case 'channel.permissions_update': return `${actor} changed channel permissions on ${t}`;
    case 'channel.permissions_remove': return `${actor} removed a channel permission override on ${t}`;
    case 'category.create': return `${actor} created the category ${t}`;
    case 'category.update': return `${actor} renamed the category ${t}`;
    case 'category.delete': return `${actor} deleted the category ${t}`;
    case 'category.reorder': return `${actor} reordered the categories`;
    default: return `${actor} performed ${action}`;
  }
}

function fmtDuration(sec) {
  if (sec % 86400 === 0) return `${sec / 86400} day${sec === 86400 ? '' : 's'}`;
  if (sec % 3600 === 0) return `${sec / 3600} hour${sec === 3600 ? '' : 's'}`;
  if (sec % 60 === 0) return `${sec / 60} minute${sec === 60 ? '' : 's'}`;
  return `${sec} seconds`;
}

module.exports = { ACTIONS, recordAudit, queryAudit, sanitizeDetails };
