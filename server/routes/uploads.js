const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Any file extension is accepted here now — users can attach whatever
// they want. The thing that used to make that dangerous (opening an
// uploaded .html/.svg/.js file from /uploads would execute it in the
// site's origin — stored XSS) is no longer handled by blocking file
// types at upload time. It's handled at *serve* time instead, in
// server/routes/uploadServe.js: only a small allowlist of genuinely
// inert types (images/audio/video/pdf/txt) is ever served with a
// content-type that a browser will render — everything else is forced
// to download as application/octet-stream, so it can never run as a
// script regardless of what's inside it or what extension it claims.
// See that file for the actual security boundary.

// A max extension length just guards against someone uploading a
// filename with an absurdly long "extension" (e.g. no real dot, just a
// very long name) — not a security control, just hygiene for the
// filename we generate.
const MAX_EXT_LEN = 20;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    let ext = path.extname(file.originalname).toLowerCase();
    if (ext.length > MAX_EXT_LEN) ext = '';
    // Random filename — avoids leaking a guessable, predictable name
    // (previously Date.now() + userId) that would let someone enumerate
    // or race another user's just-uploaded file.
    cb(null, `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

router.post('/', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File is too large (max 10MB)' });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const url = `/uploads/${req.file.filename}`;
    res.json({ ok: true, url });
  });
});

module.exports = router;