// server/routes/adminStaff.js — administrators grant the two explicit staff
// permissions (SECURITY_REPORTS, REPORTER_IDENTITY) and can re-run the
// badge→role reconciliation. ADMIN only (requireAdmin), never a developer.
const express = require('express');
const router = express.Router();
const { getUserDb, get, all, run, transaction } = require('../database/userDb');
const { ensureWalletTables } = require('../database/walletDb');
const { audit } = require('../services/walletService');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const staff = require('../services/staff');

router.use(requireAuth, requireAdmin);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const known = p => Object.values(staff.PERMISSIONS).includes(p);

router.get('/permissions', async (req, res) => {
  const db = await getUserDb();
  const rows = all(db, `SELECT p.user_id, p.permission, p.granted_at, u.username, u.display_name, u.role
                        FROM staff_permissions p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.granted_at DESC LIMIT 500`);
  res.json({ permissions: rows, available: Object.values(staff.PERMISSIONS) });
});

router.put('/permissions', async (req, res) => {
  const b = req.body || {};
  if (!ID_RE.test(String(b.user_id || '')) || !known(b.permission)) return res.status(400).json({ error: 'Invalid request' });
  const db = await getUserDb();
  const target = get(db, 'SELECT id, username, role, disabled FROM users WHERE id = ?', [b.user_id]);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!staff.hasWorkspaceAccess(target) || target.disabled) {
    return res.status(409).json({ error: 'Only developers and administrators can hold staff permissions' });
  }
  transaction(db, () => {
    ensureWalletTables(db);
    run(db, 'INSERT OR IGNORE INTO staff_permissions (user_id, permission, granted_by, granted_at) VALUES (?, ?, ?, ?)', [target.id, b.permission, req.user.id, Date.now()]);
    audit(db, req.user.id, 'staff.permission_granted', target.id, { permission: b.permission, targetName: target.username });
  });
  res.json({ ok: true });
});

router.delete('/permissions/:userId/:permission', async (req, res) => {
  if (!ID_RE.test(req.params.userId) || !known(req.params.permission)) return res.status(400).json({ error: 'Invalid request' });
  const db = await getUserDb();
  transaction(db, () => {
    ensureWalletTables(db);
    run(db, 'DELETE FROM staff_permissions WHERE user_id = ? AND permission = ?', [req.params.userId, req.params.permission]);
    audit(db, req.user.id, 'staff.permission_revoked', req.params.userId, { permission: req.params.permission });
  });
  res.json({ ok: true });
});

router.post('/developers/sync', async (req, res) => {
  const db = await getUserDb();
  const result = transaction(db, () => {
    const r = staff.reconcileDeveloperRoles(db);
    ensureWalletTables(db);
    audit(db, req.user.id, 'staff.developer_roles_reconciled', null, r);
    return r;
  });
  res.json({ ok: true, ...result });
});

module.exports = router;
