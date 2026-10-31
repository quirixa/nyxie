// server/routes/reports.js — what an ordinary signed-in user can do with
// reports: submit one, see the status of their OWN, attach files to their own
// recent report, and download attachments they are allowed to see.
//
// There is deliberately no way here to read anyone else's report, internal
// notes, priority, assignee or history — those live in routes/developer.js
// behind the Developer-workspace permission check.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const { getUserDb, get } = require('../database/userDb');
const { requireAuth } = require('../middleware/auth');
const { REPORT_ATTACH_DIR } = require('../config/paths');
const reports = require('../services/reports');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ATTACH_WINDOW_MS = 24 * 3600 * 1000;   // a reporter may add files for a day after submitting

function sendError(res, err) {
  if (err instanceof reports.ReportError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error('Reports route error:', err.message);
  return res.status(500).json({ error: 'Internal server error' });
}

// POST /api/reports — only these fields are read from the body. Anything else
// (status, priority, assignee_id, notes, role, reporter ids…) is ignored.
router.post('/', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const db = await getUserDb();
    const created = reports.createReport(db, req.user, {
      title: b.title, description: b.description, category: b.category,
      app_version: b.app_version, platform: b.platform,
      diagnostics_consent: b.diagnostics_consent === true,
      diagnostics: b.diagnostics,
    });
    res.status(201).json({ report: created });
  } catch (err) { sendError(res, err); }
});

// GET /api/reports/mine — the caller's own reports, reporter-safe fields only.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const db = await getUserDb();
    res.json({ reports: reports.listMine(db, req.user.id) });
  } catch (err) { sendError(res, err); }
});

// ── Attachments ─────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: reports.LIMITS.MAX_ATTACHMENTS, fields: 5 },
}).array('files', reports.LIMITS.MAX_ATTACHMENTS);

// Type is decided from the file's own bytes — never from the client-supplied
// name or Content-Type.
function sniff(buf) {
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString('latin1'))) return { mime: 'image/gif', ext: 'gif' };
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.length > 0 && !buf.includes(0)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return { mime: 'text/plain', ext: 'txt' }; } catch (_) { /* not text */ }
  }
  return null;
}

function safeName(name, ext) {
  const base = path.basename(String(name || 'attachment')).replace(/[\u0000-\u001F\u007F"\\/<>:|?*]/g, '').trim().slice(0, 100);
  return base || `attachment.${ext}`;
}

router.post('/mine/:number/attachments', requireAuth, (req, res) => {
  upload(req, res, async (mErr) => {
    try {
      if (mErr) {
        const tooBig = mErr.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'Each file must be 5 MB or smaller' : 'Invalid upload', code: 'BAD_UPLOAD' });
      }
      const db = await getUserDb();
      const report = reports.getOwnReport(db, req.user.id, req.params.number);
      if (!report) return res.status(404).json({ error: 'Report not found', code: 'NOT_FOUND' });
      if (Date.now() - report.created_at > ATTACH_WINDOW_MS) {
        return res.status(409).json({ error: 'Files can only be added within 24 hours of submitting', code: 'WINDOW_CLOSED' });
      }
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: 'No files received', code: 'NO_FILES' });
      const existing = get(db, 'SELECT COUNT(*) AS c FROM report_attachments WHERE report_id = ?', [report.id]).c;
      if (existing + files.length > reports.LIMITS.MAX_ATTACHMENTS) {
        return res.status(409).json({ error: `A report can have at most ${reports.LIMITS.MAX_ATTACHMENTS} files`, code: 'TOO_MANY_FILES' });
      }
      const checked = files.map(f => ({ f, kind: sniff(f.buffer) }));
      if (checked.some(c => !c.kind)) {
        return res.status(415).json({ error: 'Only PNG, JPEG, GIF, WebP images and plain-text files are accepted', code: 'BAD_TYPE' });
      }
      if (!fs.existsSync(REPORT_ATTACH_DIR)) fs.mkdirSync(REPORT_ATTACH_DIR, { recursive: true, mode: 0o700 });
      const saved = [];
      for (const { f, kind } of checked) {
        const stored = crypto.randomBytes(24).toString('hex') + '.bin';   // extension never trusted or used
        fs.writeFileSync(path.join(REPORT_ATTACH_DIR, stored), f.buffer, { mode: 0o600 });
        saved.push(reports.recordAttachment(db, report, req.user.id, {
          original_name: safeName(f.originalname, kind.ext), stored_name: stored, mime: kind.mime, size: f.size,
        }));
      }
      res.status(201).json({ attachments: saved });
    } catch (err) { sendError(res, err); }
  });
});

// GET /api/reports/attachments/:id/download — checked on EVERY request.
router.get('/attachments/:id/download', requireAuth, async (req, res) => {
  try {
    const db = await getUserDb();
    const auth = reports.authorizeAttachment(db, req.user, req.params.id);
    if (!auth) return res.status(404).json({ error: 'Attachment not found', code: 'NOT_FOUND' });
    const file = path.join(REPORT_ATTACH_DIR, path.basename(auth.attachment.stored_name));
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Attachment not found', code: 'NOT_FOUND' });
    if (auth.report.category === 'SECURITY' && auth.asStaff) {
      reports.auditSensitive(db, req.user.id, 'report.security_attachment_download', auth.report, { attachment: auth.attachment.id });
    }
    const asciiName = auth.attachment.original_name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    res.set({
      'Content-Type': auth.attachment.mime === 'text/plain' ? 'text/plain; charset=utf-8' : auth.attachment.mime,
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(auth.attachment.original_name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.sendFile(file);
  } catch (err) { sendError(res, err); }
});

module.exports = router;
