// server/routes/adminProfileEffects.js — authorise / revoke the animated
// profile effect (ring + sparks) for a user. Administrators only.
//
// Same gate as routes/adminBadges.js: requireAuth loads the caller's role
// from the database on every request and requireAdmin rejects non-admins.
// The profile card hiding the menu item from non-admins is cosmetic; this
// router is the enforcement. There is no way for a user to set this flag
// on themselves (PATCH /users/me ignores it).

const express = require('express');
const router = express.Router();
const { getUserDb, get, run } = require('../database/userDb');
const { ensureWalletTables } = require('../database/walletDb');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../services/walletService');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

router.use(requireAuth, requireAdmin);

// GET /api/admin/profile-effects/users/:userId — current state.
router.get('/users/:userId', async (req, res) => {
  if (!ID_RE.test(req.params.userId)) return res.status(404).json({ error: 'User not found' });
  const db = await getUserDb();
  const user = get(db, 'SELECT id, username, profile_effect FROM users WHERE id = ?', [req.params.userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: { id: user.id, username: user.username, profile_effect: user.profile_effect ? 1 : 0 } });
});

// PUT /api/admin/profile-effects/users/:userId  { enabled: true|false }
router.put('/users/:userId', async (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (!ID_RE.test(req.params.userId) || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'A valid user and boolean "enabled" are required' });
    }
    const db = await getUserDb();
    const user = get(db, 'SELECT id, username, avatar_decoration, card_decoration FROM users WHERE id = ?', [req.params.userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    run(db, 'UPDATE users SET profile_effect = ? WHERE id = ?', [enabled ? 1 : 0, user.id]);
    ensureWalletTables(db); // audit_logs lives with the wallet tables
    audit(db, req.user.id, enabled ? 'PROFILE_EFFECT_GRANTED' : 'PROFILE_EFFECT_REVOKED', user.id, { username: user.username });

    if (typeof req.app.locals.broadcastAll === 'function') {
      req.app.locals.broadcastAll({
        type: 'profile_updated',
        user_id: user.id,
        avatar_decoration: user.avatar_decoration || 'none',
        card_decoration: user.card_decoration || 'none',
        profile_effect: enabled ? 1 : 0,
      });
    }
    res.json({ ok: true, user: { id: user.id, username: user.username, profile_effect: enabled ? 1 : 0 } });
  } catch (err) {
    console.error('Admin profile effect error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
