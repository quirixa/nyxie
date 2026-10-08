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

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');

const INLINE_SAFE_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

router.get('/:filename', (req, res) => {
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
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
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
