// Load .env from the project root regardless of the current working
// directory the process was started from (e.g. `node server/server.js`
// from the project root, vs `cd server && node server.js` — both should
// find the same .env).
require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env')
});

const express = require('express');
const path = require('path');
const http = require('http');
const rateLimit = require('express-rate-limit');

const { setupWebSocket, isUserConnected, broadcastPresenceChange } = require('./websocket');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const roomRoutes = require('./routes/rooms');
const serverRoutes = require('./routes/servers');
const channelRoutes = require('./routes/channels');
const inviteRoutes = require('./routes/invites');
const groupRoutes = require('./routes/groups');
const friendRoutes = require('./routes/friends');
const walletRoutes = require('./routes/wallet');
const marketplaceRoutes = require('./routes/marketplace');
const adminMarketplaceRoutes = require('./routes/adminMarketplace');
const badgeRoutes = require('./routes/badges');
const adminBadgeRoutes = require('./routes/adminBadges');
const adminWalletRoutes = require('./routes/adminWallet');
const { getUserDb, flush: flushUserDb } = require('./database/userDb');
const { flush: flushMessageDb } = require('./database/messageDb');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ─── Project paths ──────────────────────────────────────────────
const PROJECT_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// ── Security: validate JWT secret before starting ─────────────────
// A missing, placeholder, or short secret would make token forgery
// materially easier. Require at least 32 characters at startup.
const JWT_SECRET = process.env.JWT_SECRET || '';
const WEAK_JWT_SECRETS = new Set([
  'secret',
  'jwt-secret',
  'change-me',
  'changeme',
  'password',
  'replace-with-a-long-random-secret-at-least-32-characters'
]);

if (JWT_SECRET.length < 32 || WEAK_JWT_SECRETS.has(JWT_SECRET.toLowerCase())) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters and must not be a default/placeholder value.');
  process.exit(1);
}

// ── Reverse proxy configuration ─────────────────────────────────
//
// Nyxie may run behind a reverse proxy such as Render's proxy.
// The proxy forwards the original client IP using X-Forwarded-For.
//
// Trust only the first proxy hop. This allows Express and
// express-rate-limit to correctly determine the real client IP
// without blindly trusting arbitrary forwarded headers.
app.set('trust proxy', 1);

// ── Rate limiting ────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests, please try again later.'
  }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many login attempts, please try again later.'
  }
});

// ── Dedicated upload limiter ────────────────────────────────────
// Uploads are much more expensive than ordinary API requests because
// they consume disk, bandwidth and multer parsing work. Keep this
// separate from the broad API limiter so a client cannot spend its
// entire API allowance on 10MB uploads. This is intentionally per IP;
// the route also requires authentication.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many uploads, please wait before uploading more files.'
  }
});

// ── Security headers ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Referrer-Policy',
    'strict-origin-when-cross-origin'
  );

  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "img-src 'self' blob: data:; " +
    // Voice messages are recorded/played back as `blob:` object URLs
    // (MediaRecorder -> Blob -> URL.createObjectURL) and previously
    // recorded messages are decrypted client-side into a Blob too — so
    // <audio> playback needs blob: allowed here. media-src isn't covered
    // by img-src, and without it explicitly set it falls back to
    // default-src 'self', which blocks blob: audio entirely.
    "media-src 'self' blob:; " +
    "connect-src 'self' ws: wss:; " +
    "frame-ancestors 'none';"
  );

  next();
});

// ── Body parsing & static files ──────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    // The SPA shell and frontend JS must always revalidate so deployed
    // fixes cannot be hidden behind a stale browser/proxy cache.
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ─── Serve uploaded media (avatars / banners / uploads) ──────────
app.use(
  '/avatars',
  express.static(path.join(DATA_DIR, 'avatars'))
);

app.use(
  '/banners',
  express.static(path.join(DATA_DIR, 'banners'))
);

// Custom route (not express.static) — decides Content-Type/Disposition
// per file instead of letting the browser sniff/render whatever an
// uploaded file's extension claims. See routes/uploadServe.js.
app.use(
  '/uploads',
  require('./routes/uploadServe')
);

// ── Upload route ─────────────────────────────────────────────────
app.use(
  '/api/upload',
  uploadLimiter,
  require('./routes/uploads')
);

// ── Rate-limited API routes ──────────────────────────────────────
app.use('/api/', globalLimiter);

app.use(
  '/api/auth/login',
  authLimiter
);

app.use(
  '/api/auth/register',
  authLimiter
);

// Servers, invites, and groups all have creation/join endpoints that are
// cheap to call and abusable (spamming servers, brute-forcing invite
// codes, mass-adding to groups) — cap those more tightly than the
// general 1000/15min API limit.
const creationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});
const inviteJoinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many invite attempts, please slow down.' }
});

app.use(['/api/servers', '/api/groups'], (req, res, next) => {
  if (req.method === 'POST' && (req.path === '/' || /^\/[^/]+\/(invites|channels|members)$/.test(req.path))) {
    return creationLimiter(req, res, next);
  }
  next();
});
app.use('/api/invites/:code/join', inviteJoinLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/admin/marketplace', adminMarketplaceRoutes);
app.use('/api/badges', badgeRoutes);
// Badge ownership changes: requireAuth + requireAdmin inside the router.
app.use('/api/admin/badges', adminBadgeRoutes);
// Admin fund grants: requireAuth + requireAdmin inside the router.
// Unlike the dev faucet below, this works in production.
app.use('/api/admin/wallet', adminWalletRoutes);

// ── Dev-only test funding — explicit opt-in only ─────────────────
if (process.env.ENABLE_DEV_ROUTES === 'true') {
  app.use(
    '/api/dev',
    require('./routes/dev')
  );
}

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// ── SPA fallback ─────────────────────────────────────────────────
//
// All non-API, non-asset routes fall back to index.html so the SPA
// router can handle them.
app.get(
  /^\/(?!api\/|avatars\/|banners\/|uploads\/|health).*/,
  (req, res, next) => {
    // If the path has a file extension, it's a static asset that
    // 404'd — don't mask it.
    if (path.extname(req.path)) {
      return next();
    }

    res.sendFile(
      path.join(PUBLIC_DIR, 'index.html')
    );
  }
);

// ── 404 handler ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found'
  });
});

// ── Global error handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  res.status(500).json({
    error: 'Internal server error'
  });
});

// ── WebSocket setup ──────────────────────────────────────────────
const { broadcast, broadcastToUser, broadcastAll } = setupWebSocket(server);

app.locals.broadcast = broadcast;
app.locals.broadcastToUser = broadcastToUser;
app.locals.broadcastAll = broadcastAll;
app.locals.isUserConnected = isUserConnected;
app.locals.broadcastPresenceChange = broadcastPresenceChange;

// ── Start server ─────────────────────────────────────────────────
getUserDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(
        `Server running on http://localhost:${PORT}`
      );
    });
  })
  .catch(err => {
    console.error(
      'Failed to initialize database:',
      err
    );

    process.exit(1);
  });

// ── Graceful shutdown ─────────────────────────────────────────────
// Flush both sql.js databases to disk before exiting, so a normal
// deploy/restart (SIGTERM) doesn't lose the last (up to) 5s of writes
// that were only sitting in memory waiting for the next periodic
// persist() tick. This narrows, but doesn't replace, the atomic-write
// fix in userDb.js/messageDb.js's persist() — a hard kill (SIGKILL,
// OOM, power loss) still can't run this handler, which is exactly why
// persist() itself needed to become interruption-safe.
function shutdown(signal) {
  console.log(
    `${signal} received, shutting down gracefully`
  );

  try { flushUserDb(); } catch (e) { console.error('Failed to flush user db on shutdown:', e); }
  try { flushMessageDb(); } catch (e) { console.error('Failed to flush message db on shutdown:', e); }

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

