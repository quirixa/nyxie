// server/services/jwt.js — JWT signing config, shared by the auth route
// (issues tokens) and the auth middleware (verifies them).
//
// This used to live inside routes/auth.js, and middleware.js imported
// JWT_SECRET from that route file. That worked (no circular require,
// since auth.js never required middleware.js) but coupled a piece of
// app-wide config to a specific route module. Pulling it out here means
// middleware, websocket auth, and any future route that needs to sign
// or verify a token all depend on one small, obviously-shared module
// instead of on each other.

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}

const JWT_EXPIRES = '7d';

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { JWT_SECRET, signToken, verifyToken };
