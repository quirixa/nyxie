// server/routes/uploadServe.js — serves whatever's in data/uploads.
//
// Users can upload literally any file type (see routes/uploads.js — the
// upload endpoint no longer filters by extension). This route is what
// makes that safe: it decides, per-request, whether a file is allowed to
// be *rendered* by the browser or must be *downloaded* instead.
//
// Only a small allowlist of types that a browser can display without
// ever executing anything (images, audio, video, pdf, plain text) get
// served with a matching Content-Type and `inline` disposition.
//
// Everything else — .html, .svg, .js, .zip, .exe, an image with a fake
// extension, a file with no extension at all — is served as
// `application/octet-stream` with `Content-Disposition: attachment`.
// That forces a download instead of a render no matter what's actually
// inside the file, so an uploaded "photo.jpg" that's secretly an HTML
// file full of <script> can never execute in the site's origin. This is
// the actual fix for upload-based stored XSS; the content-type is
// decided here from a fixed allowlist, never sniffed from the file.
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const { UPLOAD_DIR } = require('../config/paths');
const { requireAuth } = require('../middleware/auth');
const { getUserDb, get } = require('../database/userDb');
const { getMessageDb, allMessages } = require('../database/messageDb');
const { canViewRoom, canReadHistory } = require('../services/permissions');

// Encrypted message attachments (every file attached in the app, including
// long messages converted to .txt) are stored as ciphertext named
// `<timestamp>-<32 hex>.nx`. They are NOT public: the request must carry a
// valid session AND the user must currently be allowed to read the history of
// a room that has a live message referencing the file. Unreferenced, deleted
// and not-allowed all answer the same 404 so a file's existence can't be probed.
// (The bytes are still useless without a key envelope for the requesting user;
// this stops anyone else from even downloading them.)
const ENCRYPTED_ATTACHMENT_RE = /^\d+-[a-f0-9]{32}\.nx$/;

async function authorizeEncryptedAttachment(req, res, next) {
  try {
    const filename = path.basename(req.params.filename);
    if (!ENCRYPTED_ATTACHMENT_RE.test(filename)) return res.status(404).json({ error: 'Not found' });
    const msgDb = await getMessageDb();
    const rooms = allMessages(
      msgDb,
      'SELECT DISTINCT room_id FROM messages WHERE deleted = 0 AND attachments IS NOT NULL AND attachments LIKE ?',
      [`%"url":"/uploads/${filename}"%`]
    );
    if (rooms.length) {
      const userDb = await getUserDb();
      for (const { room_id } of rooms) {
        const room = get(userDb, 'SELECT id, server_id, is_dm, is_group FROM rooms WHERE id = ?', [room_id]);
        if (room && canViewRoom(userDb, room, req.user.id) && canReadHistory(userDb, room, req.user.id)) return next();
      }
    }
    return res.status(404).json({ error: 'Not found' });
  } catch (e) {
    return res.status(500).json({ error: 'Could not load file' });
  }
}

function gateEncryptedAttachments(req, res, next) {
  if (path.extname(path.basename(req.params.filename)).toLowerCase() !== '.nx') return next();
  req.gatedAttachment = true;
  return requireAuth(req, res, () => authorizeEncryptedAttachment(req, res, next));
}

const INLINE_SAFE_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

router.get('/:filename', gateEncryptedAttachments, (req, res) => {
  // path.basename strips any ../ path traversal attempt in the param.
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOAD_DIR, filename);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return res.status(404).json({ error: 'Not found' });

    const ext = path.extname(filename).toLowerCase();
    const safeType = INLINE_SAFE_TYPES[ext];
    const encodedName = encodeURIComponent(filename);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', stat.size);
    // Gated files are re-authorised on every request; everything else is
    // content-addressed by a random name and safe to cache.
    res.setHeader('Cache-Control', req.gatedAttachment ? 'private, no-cache' : 'private, max-age=31536000, immutable');
    if (safeType) {
      res.setHeader('Content-Type', safeType);
      res.setHeader('Content-Disposition', `inline; filename="${encodedName}"`);
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodedName}"`);
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'Not found' }); });
    stream.pipe(res);
  });
});

module.exports = router;
