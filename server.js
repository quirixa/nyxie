require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRouter = require('./src/auth');
const roomsRouter = require('./src/rooms');
const { setupWebSocket, broadcast } = require('./src/websocket');
const { getDb } = require('./src/db');

const app = express();
const server = http.createServer(app);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // CSP off for dev
app.use(cors({
  origin: '*', // tighten in production
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Expose broadcast to route handlers ──────────────────────────────────────
app.locals.broadcast = broadcast;

// ─── API Routes ──────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/users', require('./src/users'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// Catch-all: serve index.html for SPA routing
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const { wss } = setupWebSocket(server);

// ─── Boot ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  await getDb(); // initialize DB
  server.listen(PORT, () => {
    console.log(`\n  🌑 nyxie server running`);
    console.log(`  ➜  http://localhost:${PORT}`);
    console.log(`  ➜  ws://localhost:${PORT}/ws`);
    console.log(`  ➜  API: http://localhost:${PORT}/api\n`);
  });
})();

// Graceful shutdown
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });