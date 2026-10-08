// server/routes/adminBadges.js — badge management, administrators only.
//
// Same gate as routes/adminMarketplace.js: requireAuth loads the caller's
// row (including `role`) from the database on every request, and
// requireAdmin refuses anyone whose DB role isn't ADMIN. The Admin panel
// hiding its Badges tab from non-admins is cosmetic; this router is the
// actual enforcement, so a normal user calling these endpoints by hand
// gets a 403 and nothing changes.
//
// There is intentionally NO endpoint that edits badge definitions: those
// live in server/config/badge_definitions.json and only change via a
// deploy, so there is nothing here to abuse.

const express = require('express');
const router = express.Router();
const { getUserDb } = require('../database/userDb');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const badges = require('../services/badges');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function sendError(res, err) {
  if (err instanceof badges.BadgeError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error('Admin badges route error:', err);
  return res.status(500).json({ error: 'Internal server error' });
}

// Tells connected clients to re-fetch that user's badges. The payload
// carries only the user id — never the badge list — so hidden badges can't
// leak through the socket; each client re-reads through the normal
// (visibility-filtered) endpoint.
function notify(req, userId) {
  if (typeof req.app.locals.broadcastAll === 'function') {
    req.app.locals.broadcastAll({ type: 'badges_updated', user_id: userId });
  }
}

router.use(requireAuth, requireAdmin);

// GET /api/admin/badges/definitions — every badge type, with management flags.
router.get('/definitions', (req, res) => {
  res.json({ badges: badges.listDefinitionsForAdmin() });
});

// GET /api/admin/badges/users?q=… — find users by username, display name or id.
router.get('/users', async (req, res) => {
  try {
    const db = await getUserDb();
    res.json({ users: badges.searchUsers(db, req.query.q, 20) });
  } catch (err) { sendError(res, err); }
});

// GET /api/admin/badges/users/:userId — one user with all their badges (incl. hidden).
router.get('/users/:userId', async (req, res) => {
  try {
    if (!ID_RE.test(req.params.userId)) return res.status(404).json({ error: 'User not found' });
    const db = await getUserDb();
    const user = badges.getUserWithBadges(db, req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    res.json({ user });
  } catch (err) { sendError(res, err); }
});

// POST /api/admin/badges/users/:userId/badges  { badge_id }
router.post('/users/:userId/badges', async (req, res) => {
  try {
    const { badge_id } = req.body || {};
    if (!ID_RE.test(req.params.userId) || typeof badge_id !== 'string') {
      return res.status(400).json({ error: 'A valid user and badge_id are required' });
    }
    const db = await getUserDb();
    const user = badges.grantBadge(db, req.user, req.params.userId, badge_id);
    notify(req, user.id);
    res.status(201).json({ user });
  } catch (err) { sendError(res, err); }
});

// DELETE /api/admin/badges/users/:userId/badges/:badgeId
router.delete('/users/:userId/badges/:badgeId', async (req, res) => {
  try {
    if (!ID_RE.test(req.params.userId)) return res.status(404).json({ error: 'User not found' });
    const db = await getUserDb();
    const user = badges.revokeBadge(db, req.user, req.params.userId, req.params.badgeId);
    notify(req, user.id);
    res.json({ user });
  } catch (err) { sendError(res, err); }
});

// GET /api/admin/badges/log?limit=30 — recent badge changes from the audit log.
router.get('/log', async (req, res) => {
  try {
    const db = await getUserDb();
    const limit = parseInt(req.query.limit, 10) || 30;
    res.json({ entries: badges.listBadgeLog(db, limit) });
  } catch (err) { sendError(res, err); }
});

module.exports = router;
