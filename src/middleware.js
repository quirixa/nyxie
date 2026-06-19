const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./auth');
const { getUserDb, get } = require('./userDb');

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const db = await getUserDb();
    const user = get(db, 'SELECT id, username, display_name, disabled FROM users WHERE id = ?', [payload.sub]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.disabled) return res.status(403).json({ error: 'Account disabled' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth };