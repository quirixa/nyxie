// server/services/staff.js — roles and staff permissions for the Developer
// workspace. The ONLY place that decides who is a developer.
//
// Model (least privilege, nothing client-controlled):
//
//   users.role = 'USER' | 'DEVELOPER' | 'ADMIN'
//
//   * ADMIN      set only through scripts/setRole.js (existing mechanism).
//   * DEVELOPER  never set directly: it is DERIVED from the official
//                `developer` badge (user_badges, which only an admin can
//                grant through services/badges.js). syncDeveloperRole() is
//                called inside the badge grant/revoke transaction, and
//                reconcileDeveloperRoles() re-derives it for everyone on
//                start-up / from scripts/syncDeveloperRoles.js. Both are
//                idempotent. An ADMIN is never downgraded.
//
//   Developer workspace access = role in (DEVELOPER, ADMIN). It grants NO
//   admin capability: requireAdmin still demands role === 'ADMIN'.
//
//   Two extra, explicit permissions live in staff_permissions and can only
//   be granted by an admin (routes/adminStaff.js):
//     SECURITY_REPORTS    read/handle SECURITY reports (admins implicitly)
//     REPORTER_IDENTITY   see who a report's author is   (admins implicitly)
//   They only count for someone who also has workspace access, so losing the
//   developer badge also neutralises them.
const { all, get, run } = require('../database/userDb');

const DEVELOPER_BADGE = 'developer';
const PERMISSIONS = Object.freeze({
  SECURITY_REPORTS: 'SECURITY_REPORTS',
  REPORTER_IDENTITY: 'REPORTER_IDENTITY',
});

function hasWorkspaceAccess(user) {
  return !!user && (user.role === 'ADMIN' || user.role === 'DEVELOPER');
}

function hasExplicitPermission(db, user, permission) {
  if (!hasWorkspaceAccess(user)) return false;
  if (user.role === 'ADMIN') return true;
  return !!get(db, 'SELECT 1 AS x FROM staff_permissions WHERE user_id = ? AND permission = ?', [user.id, permission]);
}

const canViewSecurityReports = (db, user) => hasExplicitPermission(db, user, PERMISSIONS.SECURITY_REPORTS);
const canViewReporterIdentity = (db, user) => hasExplicitPermission(db, user, PERMISSIONS.REPORTER_IDENTITY);

// ── Developer role derived from the badge ───────────────────────────
// Returns the user's resulting role, or null if the user doesn't exist.
// Call inside the transaction that changed user_badges.
function syncDeveloperRole(db, userId) {
  const user = get(db, 'SELECT id, role FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  const hasBadge = !!get(db, 'SELECT 1 AS x FROM user_badges WHERE user_id = ? AND badge_id = ?', [userId, DEVELOPER_BADGE]);
  const role = user.role || 'USER';
  if (hasBadge && role === 'USER') {
    run(db, "UPDATE users SET role = 'DEVELOPER' WHERE id = ? AND role = 'USER'", [userId]);
    return 'DEVELOPER';
  }
  if (!hasBadge && role === 'DEVELOPER') {
    run(db, "UPDATE users SET role = 'USER' WHERE id = ? AND role = 'DEVELOPER'", [userId]);
    // The developer-only grants die with the role.
    run(db, 'DELETE FROM staff_permissions WHERE user_id = ?', [userId]);
    return 'USER';
  }
  return role;
}

// Re-derive every account. Safe to run any number of times.
// Returns { promoted, demoted } counts.
function reconcileDeveloperRoles(db) {
  const before = all(db, "SELECT COUNT(*) AS c FROM users WHERE role = 'DEVELOPER'")[0].c;
  const promote = all(db, `SELECT id FROM users WHERE role = 'USER'
                           AND id IN (SELECT user_id FROM user_badges WHERE badge_id = ?)`, [DEVELOPER_BADGE]);
  const demote = all(db, `SELECT id FROM users WHERE role = 'DEVELOPER'
                          AND id NOT IN (SELECT user_id FROM user_badges WHERE badge_id = ?)`, [DEVELOPER_BADGE]);
  for (const u of promote) syncDeveloperRole(db, u.id);
  for (const u of demote) syncDeveloperRole(db, u.id);
  // Grants belonging to accounts that no longer have workspace access.
  run(db, `DELETE FROM staff_permissions WHERE user_id NOT IN (SELECT id FROM users WHERE role IN ('DEVELOPER','ADMIN'))`);
  const after = all(db, "SELECT COUNT(*) AS c FROM users WHERE role = 'DEVELOPER'")[0].c;
  return { promoted: promote.length, demoted: demote.length, developers: after, developersBefore: before };
}

// ── Express middleware (run after requireAuth) ──────────────────────
// Deny by default. requireAuth has already loaded req.user.role from the
// database, so nothing the client sends can influence this.
function requireDeveloper(req, res, next) {
  if (!hasWorkspaceAccess(req.user)) return res.status(403).json({ error: 'Developer access required' });
  next();
}

module.exports = {
  PERMISSIONS,
  DEVELOPER_BADGE,
  hasWorkspaceAccess,
  canViewSecurityReports,
  canViewReporterIdentity,
  syncDeveloperRole,
  reconcileDeveloperRoles,
  requireDeveloper,
};
