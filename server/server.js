// Load .env from the project root regardless of the current working
// directory the process was started from (e.g. `node server/server.js`
// from the project root, vs `cd server && node server.js` — both should
// find the same .env).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const path = require('path');
const http = require('http');
const rateLimit = require('express-rate-limit');

const { setupWebSocket } = require('./websocket');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const roomRoutes = require('./routes/rooms');
const serverRoutes = require('./routes/servers');
const friendRoutes = require('./routes/friends');
const walletRoutes = require('./routes/wallet');
const { getUserDb } = require('./database/userDb');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ─── Project paths ──────────────────────────────────────────────
const PROJECT_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// ── Security: refuse to start without a real JWT secret ──────────
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}

// ── Rate limiting ────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' }
});

// ── Security headers ───────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "img-src 'self' blob: data:; " +
    "connect-src 'self' ws: wss:; " +
    "frame-ancestors 'none';"
  );
  next();
});

// ── Body parsing & static files ──────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

// ─── Serve uploaded media (avatars / banners / uploads) ──────────
app.use('/avatars', express.static(path.join(DATA_DIR, 'avatars')));
app.use('/banners', express.static(path.join(DATA_DIR, 'banners')));
// Custom route (not express.static) — decides Content-Type/Disposition
// per file instead of letting the browser sniff/render whatever an
// uploaded file's extension claims. See routes/uploadServe.js.
app.use('/uploads', require('./routes/uploadServe'));

// ── Upload route ────────────────────────────────────────────────────
app.use('/api/upload', require('./routes/uploads'));

// ── Rate-limited API routes ──────────────────────────────────────
app.use('/api/', globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/wallet', walletRoutes);

// ── Dev-only test funding (spec section 17) — never mounted in prod ─
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/dev', require('./routes/dev'));
}

// ── Health check ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── SPA fallback ───────────────────────────────────────────────────
// All non-API, non-asset routes fall back to index.html so the SPA router can handle them.
app.get(/^\/(?!api\/|avatars\/|banners\/|uploads\/|health).*/, (req, res, next) => {
  // If the path has a file extension, it's a static asset that 404'd – don't mask it.
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── 404 & global error handler ───────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── WebSocket setup ────────────────────────────────────────────────
const { broadcast, broadcastToUser } = setupWebSocket(server);
app.locals.broadcast = broadcast;
app.locals.broadcastToUser = broadcastToUser;

// ── Start server ─────────────────────────────────────────────────
getUserDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

// ── Graceful shutdown ────────────────────────────────────────────
function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully`);
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));