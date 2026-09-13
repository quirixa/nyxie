// server/middleware/auth.js — requireAuth, ported from src/middleware.js.
// Now imports verifyToken from services/jwt.js instead of JWT_SECRET
// from routes/auth.js, so middleware doesn't depend on a route module.
const { verifyToken } = require('../services/jwt');
const { getUserDb, get } = require('../database/userDb');

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    const db = await getUserDb();
    // `role` is included so downstream middleware (requireAdmin) doesn't
    // need a second DB round-trip; walletDb.js's ensureWalletTables()
    // defensively ALTERs this column onto `users` before any request
    // that could reach here would run (server.js initializes the user
    // DB before listening), so it's always present by the time we query.
    const user = get(db, 'SELECT id, username, display_name, disabled, role FROM users WHERE id = ?', [payload.sub]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.disabled) return res.status(403).json({ error: 'Account disabled' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Admin-only routes (marketplace dispute resolution, etc.). Must run
// after requireAuth. Never trust a client-supplied role — this only
// ever reads req.user.role, which requireAuth populated from the DB.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
