// server/services/badges.js — the single home for badge logic.
//
//   DEFINITIONS  what a badge is   → server/config/badge_definitions.json
//                                    (read-only at runtime; see that file's _readme)
//   OWNERSHIP    who has which     → `user_badges` table in the main user DB
//                                    (created in database/userDb.js)
//
// Kept apart on purpose: adding a badge type is a config change, giving a
// badge to a person is a data change, and neither touches UI code.
//
// Authorization is NOT decided in here — routes/adminBadges.js gates every
// mutating endpoint with requireAuth + requireAdmin, which re-reads
// `users.role` from the DB on each request. grantBadge()/revokeBadge() take
// the acting admin row so the audit entry can name them, but they never
// trust a client-supplied role or flag.
//
// Audit: changes are written to the existing `audit_logs` table (the same
// one the wallet uses) via walletService.audit(), inside the same
// transaction as the ownership change, so a badge can never change without
// its audit row (or vice versa).

const fs = require('fs');
const path = require('path');
const { all, get, run } = require('../database/userDb');
const { ensureWalletTables } = require('../database/walletDb');
const { audit } = require('./walletService');

const DEFINITIONS_PATH = path.join(__dirname, '..', 'config', 'badge_definitions.json');

const ACTION_ADDED = 'ADMIN_BADGE_ADDED';
const ACTION_REMOVED = 'ADMIN_BADGE_REMOVED';
const TIERS = ['staff', 'special', 'common'];
const MAX_IDS_PER_LOOKUP = 200;

class BadgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ── Icon validation ─────────────────────────────────────────────────
// Icons are trusted-config SVG fragments that the client injects with
// innerHTML. They're still parsed against a strict allow-list at load and
// re-serialised from the parsed result, so nothing outside the allow-list
// (scripts, event handlers, <use href>, url(#…) paints, foreign content)
// can ever reach the browser even if someone edits the JSON carelessly.
const ICON_TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const PATHLIKE_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;
const NUMBER_RE = /^-?[0-9]*\.?[0-9]+$/;
const ICON_ATTR_RULES = {
  d: v => PATHLIKE_RE.test(v),
  points: v => PATHLIKE_RE.test(v),
  cx: v => NUMBER_RE.test(v), cy: v => NUMBER_RE.test(v), r: v => NUMBER_RE.test(v),
  rx: v => NUMBER_RE.test(v), ry: v => NUMBER_RE.test(v),
  x: v => NUMBER_RE.test(v), y: v => NUMBER_RE.test(v),
  x1: v => NUMBER_RE.test(v), y1: v => NUMBER_RE.test(v),
  x2: v => NUMBER_RE.test(v), y2: v => NUMBER_RE.test(v),
  width: v => NUMBER_RE.test(v), height: v => NUMBER_RE.test(v),
  'stroke-width': v => NUMBER_RE.test(v),
  opacity: v => NUMBER_RE.test(v),
  'fill-opacity': v => NUMBER_RE.test(v),
  'stroke-opacity': v => NUMBER_RE.test(v),
  fill: v => v === 'none' || v === 'currentColor',
  stroke: v => v === 'none' || v === 'currentColor',
  'stroke-linecap': v => ['round', 'butt', 'square'].includes(v),
  'stroke-linejoin': v => ['round', 'miter', 'bevel'].includes(v),
};

function sanitizeIcon(markup) {
  if (typeof markup !== 'string' || !markup.trim() || markup.length > 4000) return null;
  const tagRe = /<\s*([a-zA-Z]+)((?:\s+[a-zA-Z-]+\s*=\s*"[^"<>]*")*)\s*\/?>/g;
  const attrRe = /([a-zA-Z-]+)\s*=\s*"([^"<>]*)"/g;
  const out = [];
  let consumed = 0;
  let m;
  while ((m = tagRe.exec(markup)) !== null) {
    // Anything between tags other than whitespace means unexpected content.
    if (markup.slice(consumed, m.index).trim() !== '') return null;
    consumed = tagRe.lastIndex;
    const tag = m[1].toLowerCase();
    if (!ICON_TAGS.has(tag)) return null;
    const attrs = [];
    let a;
    while ((a = attrRe.exec(m[2])) !== null) {
      const name = a[1];
      const value = a[2].trim();
      const rule = Object.prototype.hasOwnProperty.call(ICON_ATTR_RULES, name) ? ICON_ATTR_RULES[name] : null;
      if (!rule || !rule(value)) return null;
      attrs.push(`${name}="${value}"`);
    }
    out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}/>`);
  }
  if (markup.slice(consumed).trim() !== '' || out.length === 0) return null;
  return out.join('');
}

// ── Definitions ─────────────────────────────────────────────────────
let definitions = null; // Map<badgeId, definition>, sorted by order

function loadDefinitions() {
  if (definitions) return definitions;
  const loaded = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(DEFINITIONS_PATH, 'utf8'));
    const entries = raw && typeof raw.badges === 'object' && raw.badges ? Object.entries(raw.badges) : [];
    for (const [id, d] of entries) {
      const problem = validateDefinition(id, d);
      if (problem) {
        // A bad definition is skipped (badge simply doesn't exist) rather
        // than crashing the server or being half-rendered.
        console.error(`badges: skipping "${id}" in ${DEFINITIONS_PATH} — ${problem}`);
        continue;
      }
      loaded.set(id, {
        id,
        name: d.name.trim(),
        description: (d.description || '').trim(),
        icon: sanitizeIcon(d.icon),
        color: d.color.toLowerCase(),
        tier: d.tier || 'common',
        order: Number.isFinite(d.order) ? d.order : 1000,
        hidden: d.hidden === true,
        derivedFromRole: typeof d.derivedFromRole === 'string' ? d.derivedFromRole : null,
        // A role-derived badge is never manually assignable, whatever the file says.
        assignable: d.derivedFromRole ? false : d.assignable !== false,
      });
    }
  } catch (e) {
    console.error('badges: failed to load', DEFINITIONS_PATH, '- no badges will be available:', e.message);
  }
  definitions = new Map([...loaded.entries()].sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0])));
  return definitions;
}

function validateDefinition(id, d) {
  if (!/^[a-z0-9_]{1,32}$/.test(id)) return 'id must match [a-z0-9_]{1,32}';
  if (!d || typeof d !== 'object') return 'definition is not an object';
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 40) return 'name missing or too long';
  if (d.description !== undefined && (typeof d.description !== 'string' || d.description.length > 140)) return 'description invalid or too long';
  if (typeof d.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(d.color)) return 'color must be a #rrggbb hex value';
  if (d.tier !== undefined && !TIERS.includes(d.tier)) return `tier must be one of ${TIERS.join(', ')}`;
  if (d.derivedFromRole !== undefined && (typeof d.derivedFromRole !== 'string' || !/^[A-Z_]{1,20}$/.test(d.derivedFromRole))) return 'derivedFromRole invalid';
  if (!sanitizeIcon(d.icon)) return 'icon missing or contains disallowed SVG';
  return null;
}

function getDefinition(id) {
  if (typeof id !== 'string') return null;
  return loadDefinitions().get(id) || null;
}

// What the client needs to render a badge. Hidden/internal badges are only
// included for administrators.
function toPublicDefinition(d) {
  return { id: d.id, name: d.name, description: d.description, icon: d.icon, color: d.color, tier: d.tier, order: d.order };
}

function listDefinitions({ includeHidden = false } = {}) {
  return [...loadDefinitions().values()].filter(d => includeHidden || !d.hidden).map(toPublicDefinition);
}

// Admin view adds the management flags.
function listDefinitionsForAdmin() {
  return [...loadDefinitions().values()].map(d => ({
    ...toPublicDefinition(d),
    hidden: d.hidden,
    assignable: d.assignable,
    derived: !!d.derivedFromRole,
  }));
}

// ── Ownership reads ─────────────────────────────────────────────────
function placeholders(n) { return new Array(n).fill('?').join(','); }

function sortByOrder(ids) {
  const defs = loadDefinitions();
  return ids.sort((a, b) => (defs.get(a).order - defs.get(b).order) || a.localeCompare(b));
}

// Returns { [userId]: [badgeId, …] } — every requested id gets a key, so
// callers can cache "no badges" as an answer. Badge ids are ordered by the
// definitions' `order`; hidden badges only appear when includeHidden.
function getBadgeIdsForUsers(db, userIds, { includeHidden = false } = {}) {
  const defs = loadDefinitions();
  const ids = [...new Set(userIds)].slice(0, MAX_IDS_PER_LOOKUP);
  const result = {};
  for (const id of ids) result[id] = [];
  if (!ids.length) return result;

  const ph = placeholders(ids.length);
  const sets = new Map(ids.map(id => [id, new Set()]));

  // Derived badges (e.g. Administrator ← role ADMIN). Stored rows for a
  // derived badge are ignored on purpose, so a stray/imported row can never
  // make a non-admin look like an admin.
  const roleRows = all(db, `SELECT id, role FROM users WHERE id IN (${ph})`, ids);
  for (const u of roleRows) {
    for (const d of defs.values()) {
      if (d.derivedFromRole && d.derivedFromRole === u.role) sets.get(u.id).add(d.id);
    }
  }

  const rows = all(db, `SELECT user_id, badge_id FROM user_badges WHERE user_id IN (${ph})`, ids);
  for (const r of rows) {
    const d = defs.get(r.badge_id);
    if (!d || d.derivedFromRole) continue; // unknown/retired badge, or derived-only
    sets.get(r.user_id).add(r.badge_id);
  }

  for (const [uid, set] of sets) {
    let list = [...set];
    if (!includeHidden) list = list.filter(b => !defs.get(b).hidden);
    result[uid] = sortByOrder(list);
  }
  return result;
}

// ── Admin: search / read ────────────────────────────────────────────
function escapeLike(s) { return s.replace(/[\\%_]/g, ch => '\\' + ch); }

function searchUsers(db, query, limit = 20) {
  const q = String(query || '').trim().slice(0, 64);
  if (!q) return [];
  const pattern = `%${escapeLike(q)}%`;
  const users = all(db, `
    SELECT id, username, display_name, avatar, role, disabled
    FROM users
    WHERE id = ? OR username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'
    ORDER BY username COLLATE NOCASE
    LIMIT ?
  `, [q, pattern, pattern, Math.min(Math.max(limit, 1), 50)]);
  const badges = getBadgeIdsForUsers(db, users.map(u => u.id), { includeHidden: true });
  return users.map(u => ({ ...u, badges: badges[u.id] || [] }));
}

function getUserWithBadges(db, userId) {
  const user = get(db, 'SELECT id, username, display_name, avatar, role, disabled FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  return { ...user, badges: getBadgeIdsForUsers(db, [userId], { includeHidden: true })[userId] || [] };
}

// ── Admin: mutations ────────────────────────────────────────────────
// `actor` is the requireAuth-populated req.user row (id, username, …).
function mutate(db, actor, targetUserId, badgeId, kind) {
  const def = getDefinition(badgeId);
  if (!def) throw new BadgeError(404, 'UNKNOWN_BADGE', 'That badge does not exist');
  if (!def.assignable) {
    throw new BadgeError(400, 'NOT_ASSIGNABLE', `${def.name} is awarded automatically and can't be changed here`);
  }
  const target = get(db, 'SELECT id, username FROM users WHERE id = ?', [targetUserId]);
  if (!target) throw new BadgeError(404, 'USER_NOT_FOUND', 'User not found');

  const existing = get(db, 'SELECT 1 AS x FROM user_badges WHERE user_id = ? AND badge_id = ?', [target.id, def.id]);
  if (kind === 'add' && existing) throw new BadgeError(409, 'ALREADY_HAS_BADGE', `${target.username} already has the ${def.name} badge`);
  if (kind === 'remove' && !existing) throw new BadgeError(404, 'BADGE_NOT_OWNED', `${target.username} doesn't have the ${def.name} badge`);

  ensureWalletTables(db); // makes sure audit_logs exists before we open the transaction
  run(db, 'BEGIN');
  try {
    if (kind === 'add') {
      run(db, 'INSERT INTO user_badges (user_id, badge_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)',
        [target.id, def.id, actor.id, Date.now()]);
    } else {
      run(db, 'DELETE FROM user_badges WHERE user_id = ? AND badge_id = ?', [target.id, def.id]);
    }
    audit(db, actor.id, kind === 'add' ? ACTION_ADDED : ACTION_REMOVED, target.id, {
      badge: def.id,
      badgeName: def.name,
      actorName: actor.username,
      targetName: target.username,
    });
    run(db, 'COMMIT');
  } catch (err) {
    try { run(db, 'ROLLBACK'); } catch (_) { /* transaction may already be gone */ }
    // A concurrent duplicate INSERT hits the (user_id, badge_id) primary key.
    if (/UNIQUE|constraint/i.test(String(err && err.message))) {
      throw new BadgeError(409, 'ALREADY_HAS_BADGE', `${target.username} already has the ${def.name} badge`);
    }
    throw err;
  }

  console.log(`[badges] Admin ${actor.username} ${kind === 'add' ? 'added' : 'removed'} ${def.name} badge ${kind === 'add' ? 'to' : 'from'} user ${target.id}`);
  return getUserWithBadges(db, target.id);
}

function grantBadge(db, actor, targetUserId, badgeId) { return mutate(db, actor, targetUserId, badgeId, 'add'); }
function revokeBadge(db, actor, targetUserId, badgeId) { return mutate(db, actor, targetUserId, badgeId, 'remove'); }

function listBadgeLog(db, limit = 30) {
  ensureWalletTables(db);
  const rows = all(db, `
    SELECT id, actor_id, action, target, metadata, created_at
    FROM audit_logs
    WHERE action IN (?, ?)
    ORDER BY created_at DESC
    LIMIT ?
  `, [ACTION_ADDED, ACTION_REMOVED, Math.min(Math.max(limit, 1), 100)]);
  return rows.map(r => {
    let meta = {};
    try { meta = r.metadata ? JSON.parse(r.metadata) : {}; } catch (_) { /* keep empty */ }
    const added = r.action === ACTION_ADDED;
    const badgeName = meta.badgeName || meta.badge || 'unknown';
    return {
      id: r.id,
      action: added ? 'added' : 'removed',
      actorId: r.actor_id,
      actorName: meta.actorName || null,
      targetId: r.target,
      targetName: meta.targetName || null,
      badge: meta.badge || null,
      badgeName,
      createdAt: r.created_at,
      // Same wording as the audit example in the spec.
      text: `Admin ${meta.actorName || r.actor_id} ${added ? 'added' : 'removed'} ${badgeName} badge ${added ? 'to' : 'from'} user ${r.target}`,
    };
  });
}

module.exports = {
  BadgeError,
  MAX_IDS_PER_LOOKUP,
  loadDefinitions,
  getDefinition,
  listDefinitions,
  listDefinitionsForAdmin,
  getBadgeIdsForUsers,
  searchUsers,
  getUserWithBadges,
  grantBadge,
  revokeBadge,
  listBadgeLog,
  sanitizeIcon, // exported for tests / the import script
};
