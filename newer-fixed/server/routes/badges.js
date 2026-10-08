// server/routes/badges.js — read-only badge endpoints for any signed-in user.
// Everything that can CHANGE badge ownership lives in adminBadges.js
// behind requireAdmin; nothing in this file writes.

const express = require('express');
const router = express.Router();
const { getUserDb } = require('../database/userDb');
const { requireAuth } = require('../middleware/auth');
const badges = require('../services/badges');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Administrators additionally see hidden/internal badges. The role comes
// from requireAuth's fresh DB read, never from the request.
function canSeeHidden(req) {
  return req.user && req.user.role === 'ADMIN';
}

// GET /api/badges/definitions — the catalogue the client renders from.
router.get('/definitions', requireAuth, (req, res) => {
  res.json({ badges: badges.listDefinitions({ includeHidden: canSeeHidden(req) }) });
});

// GET /api/badges/users?ids=a,b,c — badge ids per user (ordered), batched
// so a screen full of messages or members costs one request.
router.get('/users', requireAuth, async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => ID_RE.test(s));
    if (!ids.length) return res.json({ badges: {} });
    if (ids.length > badges.MAX_IDS_PER_LOOKUP) {
      return res.status(400).json({ error: `Too many ids (max ${badges.MAX_IDS_PER_LOOKUP})` });
    }
    const db = await getUserDb();
    res.json({ badges: badges.getBadgeIdsForUsers(db, ids, { includeHidden: canSeeHidden(req) }) });
  } catch (err) {
    console.error('Badge lookup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
