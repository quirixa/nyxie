const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getUserDb, all, get, run } = require('./userDb');

const JWT_SECRET = process.env.JWT_SECRET || 'nyxie-dev-secret-change-in-production';
const JWT_EXPIRES = '7d';

function hashSeed(seedPhrase) {
  const normalized = seedPhrase.trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update('nyxie:' + normalized).digest('hex');
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

router.post('/register', async (req, res) => {
  try {
    const db = await getUserDb();
    const { username, display_name, seed_phrase } = req.body;

    if (!username || !seed_phrase) {
      return res.status(400).json({ error: 'username and seed_phrase are required' });
    }

    const trimmedUsername = username.trim();
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(trimmedUsername)) {
      return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, _ or -).' });
    }
    const reserved = ['admin', 'root', 'system', 'nyxie', 'support'];
    if (reserved.includes(trimmedUsername.toLowerCase())) {
      return res.status(400).json({ error: 'Username not available' });
    }

    const seedWords = seed_phrase.trim().toLowerCase().replace(/\s+/g, ' ').split(' ');
    const validLengths = [12, 15, 18, 21, 24];
    if (!validLengths.includes(seedWords.length)) {
      return res.status(400).json({ error: `Seed phrase must contain 12,15,18,21 or 24 words (got ${seedWords.length})` });
    }

    const seedHash = hashSeed(seed_phrase);
    const displayName = display_name?.trim() || trimmedUsername;

    const existingUser = get(db, 'SELECT id FROM users WHERE username = ?', [trimmedUsername]);
    if (existingUser) return res.status(409).json({ error: 'Username already taken' });
    const existingSeed = get(db, 'SELECT id FROM users WHERE seed_hash = ?', [seedHash]);
    if (existingSeed) return res.status(409).json({ error: 'Seed phrase already registered' });

    const userId = uuidv4();
    const now = Date.now();
    run(db,
      `INSERT INTO users (id, username, display_name, seed_hash, status, created_at, last_seen)
       VALUES (?, ?, ?, ?, 'online', ?, ?)`,
      [userId, trimmedUsername, displayName, seedHash, now, now]
    );

    const defaultServer = get(db, "SELECT id FROM servers WHERE name = 'Nyxie'");
    if (defaultServer) {
      run(db, 'INSERT OR IGNORE INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)',
          [defaultServer.id, userId, now]);
      const channels = all(db, 'SELECT id FROM rooms WHERE server_id = ?', [defaultServer.id]);
      for (const ch of channels) {
        run(db, 'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)',
            [ch.id, userId, now]);
      }
    }

    const token = signToken(userId);
    res.status(201).json({
      token,
      user: { id: userId, username: trimmedUsername, display_name: displayName, status: 'online' }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const db = await getUserDb();
    const { seed_phrase } = req.body;

    if (!seed_phrase) {
      return res.status(400).json({ error: 'seed_phrase is required' });
    }

    const seedHash = hashSeed(seed_phrase);
    const user = get(db, 'SELECT * FROM users WHERE seed_hash = ?', [seedHash]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid seed phrase. Not registered?' });
    }

    run(db, 'UPDATE users SET last_seen = ? WHERE id = ?', [Date.now(), user.id]);

    const token = signToken(user.id);
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        status: user.status || 'online'
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const db = await getUserDb();
    const user = get(db, 'SELECT id, username, display_name, status, created_at, last_seen FROM users WHERE id = ?', [payload.sub]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

router.patch('/status', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token' });
    }
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const { status } = req.body;
    const allowed = ['online', 'idle', 'dnd', 'offline'];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const db = await getUserDb();
    run(db, 'UPDATE users SET status = ?, status_updated_at = ? WHERE id = ?',
        [status, Date.now(), payload.sub]);
    res.json({ ok: true, status });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
module.exports.JWT_SECRET = JWT_SECRET;
module.exports.hashSeed = hashSeed;