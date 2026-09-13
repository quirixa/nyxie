// server/routes/invites.js — everything addressed by an invite *code*
// rather than a serverId: previewing an invite before joining, redeeming
// it, and revoking it. Creating/listing a server's invites lives in
// routes/servers.js (see the comment there) since those need serverId
// for the CREATE_INVITES/MANAGE_SERVER permission check.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getUserDb, all, get, run } = require('../database/userDb');
const {
  PERMISSIONS,
  createDefaultRoles,
  getDefaultRoleId,
  ensureServerRoles,
  getServerContext,
  hasPermission
} = require('../services/permissions');
const { requireAuth } = require('../middleware/auth');

function loadInvite(db, code) {
  const invite = get(db, 'SELECT * FROM server_invites WHERE code = ?', [code]);
  if (!invite) return { invite: null, error: 'Invite not found', status: 404 };
  if (invite.revoked) return { invite, error: 'This invite has been revoked', status: 410 };
  if (invite.expires_at && invite.expires_at < Date.now()) return { invite, error: 'This invite has expired', status: 410 };
  if (invite.max_uses != null && invite.uses >= invite.max_uses) return { invite, error: 'This invite has reached its use limit', status: 410 };
  return { invite, error: null };
}

// Preview an invite (server name/icon/member count) before joining —
// authenticated so we don't leak server metadata to anonymous scrapers,
// but does not require membership.
router.get('/:code', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { invite, error, status } = loadInvite(db, req.params.code);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });

  const server = get(db, 'SELECT id, name, description, icon FROM servers WHERE id = ?', [invite.server_id]);
  if (!server) return res.status(404).json({ error: 'Server no longer exists' });
  const memberCount = get(db, 'SELECT COUNT(*) AS c FROM server_members WHERE server_id = ?', [server.id])?.c || 0;
  const alreadyMember = !!get(db, 'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?', [server.id, req.user.id]);
  const banned = !!get(db, 'SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?', [server.id, req.user.id]);

  res.json({
    server: { ...server, member_count: memberCount },
    valid: !error,
    error: error || null,
    already_member: alreadyMember,
    banned
  });
});

router.post('/:code/join', requireAuth, async (req, res) => {
  try {
    const db = await getUserDb();
    const { invite, error } = loadInvite(db, req.params.code);
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (error) return res.status(410).json({ error });

    const server = get(db, 'SELECT * FROM servers WHERE id = ?', [invite.server_id]);
    if (!server) return res.status(404).json({ error: 'Server no longer exists' });

    if (get(db, 'SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?', [server.id, req.user.id])) {
      return res.status(403).json({ error: 'You are banned from this server' });
    }
    if (get(db, 'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?', [server.id, req.user.id])) {
      return res.status(200).json({ ok: true, server_id: server.id, already_member: true });
    }

    ensureServerRoles(db, server.id);
    const defaultRoleId = getDefaultRoleId(db, server.id);
    const now = Date.now();
    run(db, 'INSERT INTO server_members (server_id, user_id, joined_at, role_id) VALUES (?, ?, ?, ?)',
      [server.id, req.user.id, now, defaultRoleId]);
    run(db, 'UPDATE server_invites SET uses = uses + 1 WHERE code = ?', [req.params.code]);

    const channels = all(db, 'SELECT id FROM rooms WHERE server_id = ? AND is_dm = 0', [server.id]);
    for (const ch of channels) {
      run(db, 'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [ch.id, req.user.id, now]);
    }

    const joined = { id: req.user.id, username: req.user.username, display_name: req.user.display_name };
    const memberIds = all(db, 'SELECT user_id FROM server_members WHERE server_id = ?', [server.id]).map(m => m.user_id);
    memberIds.forEach(uid => req.app.locals.broadcastToUser(uid, { type: 'server_member_joined', server_id: server.id, member: joined }));
    req.app.locals.broadcastToUser(req.user.id, { type: 'server_joined', server_id: server.id });

    res.json({ ok: true, server_id: server.id });
  } catch (err) {
    console.error('Error joining invite:', err);
    res.status(500).json({ error: 'Failed to join server' });
  }
});

router.delete('/:code', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const invite = get(db, 'SELECT * FROM server_invites WHERE code = ?', [req.params.code]);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });

  const ctx = getServerContext(db, invite.server_id, req.user.id);
  const canRevoke = invite.creator_id === req.user.id || hasPermission(ctx, PERMISSIONS.MANAGE_SERVER);
  if (!canRevoke) return res.status(403).json({ error: 'Missing permission' });

  run(db, 'UPDATE server_invites SET revoked = 1 WHERE code = ?', [req.params.code]);
  res.json({ ok: true });
});

module.exports = router;
