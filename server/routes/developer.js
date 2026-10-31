// server/routes/developer.js — the Developer workspace API (Feedback & Issues).
//
// EVERY route below sits behind requireAuth + requireDeveloper, which read the
// caller's role from the database (never from the request). On top of that
// each handler goes through services/reports.js, which applies the
// object-level rules (e.g. SECURITY reports are 404 unless the caller holds
// SECURITY_REPORTS). Hiding the nav item in the UI is cosmetic only.
//
// NB: /api/dev (singular, ENABLE_DEV_ROUTES=true) is the unrelated
// development-only wallet faucet; this router is /api/developer.
const express = require('express');
const router = express.Router();
const { getUserDb } = require('../database/userDb');
const { requireAuth } = require('../middleware/auth');
const { requireDeveloper } = require('../services/staff');
const reports = require('../services/reports');

router.use(requireAuth, requireDeveloper);

function sendError(res, err) {
  if (err instanceof reports.ReportError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error('Developer route error:', err.message);
  return res.status(500).json({ error: 'Internal server error' });
}
const handler = fn => async (req, res) => {
  try { res.json(fn(await getUserDb(), req)); } catch (err) { sendError(res, err); }
};

router.get('/overview', handler((db, req) => ({ overview: reports.overview(db, req.user, req.query.days) })));
router.get('/staff', handler((db, req) => ({ staff: reports.listAssignable(db, req.user) })));
router.get('/reports', handler((db, req) => reports.listForStaff(db, req.user, req.query)));
router.get('/reports/:number', handler((db, req) => ({ report: reports.getDetail(db, req.user, req.params.number) })));

router.patch('/reports/:number', handler((db, req) => {
  const b = req.body || {};
  const patch = {};
  for (const k of ['status', 'priority', 'assignee_id', 'expected_version']) if (k in b) patch[k] = b[k];
  return reports.updateReport(db, req.user, req.params.number, patch);
}));
router.post('/reports/:number/notes', handler((db, req) => reports.addNote(db, req.user, req.params.number, (req.body || {}).body)));
router.post('/reports/:number/duplicates', handler((db, req) => reports.addRelation(db, req.user, req.params.number, (req.body || {}).of, 'DUPLICATE')));
router.post('/reports/:number/related', handler((db, req) => reports.addRelation(db, req.user, req.params.number, (req.body || {}).with, 'RELATED')));
router.delete('/reports/:number/relations/:other', handler((db, req) => reports.removeRelation(db, req.user, req.params.number, req.params.other)));
router.put('/reports/:number/link', handler((db, req) => reports.setDevLink(db, req.user, req.params.number, (req.body || {}).url === undefined ? null : (req.body || {}).url)));

module.exports = router;
