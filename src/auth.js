const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb, all, get, run } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'nyxie-dev-secret-change-in-production';
const JWT_EXPIRES = '7d';

function hashSeed(seedPhrase) {
  // Normalize: lowercase, trim, single spaces
  const normalized = seedPhrase.trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update('nyxie:' + normalized).digest('hex');
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const db = await getDb();
    const { username, display_name, seed_phrase } = req.body;

    if (!username || !seed_phrase) {
      return res.status(400).json({ error: 'username and seed_phrase are required' });
    }

    // Username validation
    const trimmedUsername = username.trim();
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(trimmedUsername)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    const reserved = ['admin', 'root', 'system', 'nyxie', 'support'];
    if (reserved.includes(trimmedUsername.toLowerCase())) {
      return res.status(400).json({ error: 'Username not available' });
    }

    // Seed validation: 12/15/18/21/24 words
    const seedWords = seed_phrase.trim().toLowerCase().replace(/\s+/g, ' ').split(' ');
    const validLengths = [12, 15, 18, 21, 24];
    if (!validLengths.includes(seedWords.length)) {
      return res.status(400).json({ error: `Seed must be 12, 15, 18, 21, or 24 words (got ${seedWords.length})` });
    }

    const seedHash = hashSeed(seed_phrase);
    const displayName = (display_name && display_name.trim()) ? display_name.trim() : trimmedUsername;

    // Check username taken
    const existingUser = get(db, 'SELECT id FROM users WHERE username = ?', [trimmedUsername]);
    if (existingUser) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Check seed already registered
    const existingSeed = get(db, 'SELECT id FROM users WHERE seed_hash = ?', [seedHash]);
    if (existingSeed) {
      return res.status(409).json({ error: 'This seed phrase is already registered' });
    }

    const userId = uuidv4();
    const now = Date.now();

    run(db,
      'INSERT INTO users (id, username, display_name, seed_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      [userId, trimmedUsername, displayName, seedHash, now]
    );

    // Auto-join default rooms
    for (const roomId of ['general', 'random', 'introductions']) {
      run(db, 'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)',
        [roomId, userId, now]);
    }

    const token = signToken(userId);

    return res.status(201).json({
      token,
      user: { id: userId, username: trimmedUsername, display_name: displayName }
    });

  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const db = await getDb();
    const { seed_phrase, username } = req.body;

    if (!seed_phrase) {
      return res.status(400).json({ error: 'seed_phrase is required' });
    }

    const seedHash = hashSeed(seed_phrase);
    let user = get(db, 'SELECT * FROM users WHERE seed_hash = ?', [seedHash]);

    // If username provided, also verify it matches
    if (user && username) {
      if (user.username !== username.trim()) {
        return res.status(401).json({ error: 'Seed phrase does not match that username' });
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid seed phrase. Not registered?' });
    }

    // Update last seen
    run(db, 'UPDATE users SET last_seen = ? WHERE id = ?', [Date.now(), user.id]);

    const token = signToken(user.id);

    return res.json({
      token,
      user: { id: user.id, username: user.username, display_name: user.display_name }
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me  (verify token)
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token' });
    }
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const db = await getDb();
    const user = get(db, 'SELECT id, username, display_name, created_at, last_seen FROM users WHERE id = ?', [payload.sub]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    return res.json({ user });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
module.exports.JWT_SECRET = JWT_SECRET;
module.exports.hashSeed = hashSeed;