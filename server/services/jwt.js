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
  throw new Error('JWT_SECRET must be at least 32 characters and must not be a default/placeholder value.');
}

const JWT_EXPIRES = '7d';

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { JWT_SECRET, signToken, verifyToken };
