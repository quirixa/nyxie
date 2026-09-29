const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getUserDb, get, run } = require('../database/userDb');
const { signToken, verifyToken } = require('../services/jwt');
const { isReservedUsername } = require('../services/reservedUsernames');
const { STATUSES } = require('../services/presence');
const { createSession } = require('../services/sessions');
const { tokenIsLive } = require('../middleware/auth');
const totp = require('../services/totp');

const SALT_ROUNDS = 10;

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post('/register', async (req, res) => {
  try {
    const db = await getUserDb();
    const { username, email, password, display_name } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email and password are required' });
    }

    const trimmedUsername = username.trim();
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(trimmedUsername)) {
      return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, _ or -).' });
    }
    if (isReservedUsername(trimmedUsername)) {
      return res.status(400).json({ error: 'Username not available' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const displayName = display_name?.trim() || trimmedUsername;

    const existingUser = get(db, 'SELECT id FROM users WHERE username = ?', [trimmedUsername]);
    if (existingUser) return res.status(409).json({ error: 'Username already taken' });
    const existingEmail = get(db, 'SELECT id FROM users WHERE email = ?', [trimmedEmail]);
    if (existingEmail) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const userId = crypto.randomUUID();
    const now = Date.now();

    // Whoever registers the username "admin" gets the site-wide ADMIN
    // role automatically (everyone else defaults to 'USER' via the
    // column default). This is a deliberate first-come-first-served
    // shortcut requested for this app; it means "admin" is effectively
    // a race — whoever signs up with that exact username owns the
    // account with full ADMIN privileges (see requireAdmin in
    // middleware/auth.js). It is not reserved/blocked like other names
    // specifically so this registration can happen.
    const role = trimmedUsername.toLowerCase() === 'admin' ? 'ADMIN' : 'USER';

    run(db,
      `INSERT INTO users (id, username, email, password_hash, display_name, avatar, banner, banner_color, bio, status, created_at, last_seen, role)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'online', ?, ?, ?)`,
      [userId, trimmedUsername, trimmedEmail, passwordHash, displayName, now, now, role]
    );

    // New users start in zero servers. Servers are opt-in: create one
    // (POST /api/servers), join with an invite code, or join a public
    // one through Discover (GET /api/servers/discover, POST
    // /api/servers/:id/join) — see routes/servers.js. There is
    // deliberately no automatic enrollment into any server here.

    const token = signToken(userId, createSession(db, userId, req));
    res.status(201).json({
      token,
      user: { id: userId, username: trimmedUsername, email: trimmedEmail, display_name: displayName, avatar: null, banner: null, banner_color: null, bio: null, status: 'online' }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const db = await getUserDb();
    const { username, email, password } = req.body;

    if ((!username && !email) || !password) {
      return res.status(400).json({ error: 'username/email and password are required' });
    }

    let user;
    if (username) {
      user = get(db, 'SELECT * FROM users WHERE username = ?', [username.trim()]);
    } else if (email) {
      user = get(db, 'SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.disabled) {
      if (!req.body.reactivate) {
        return res.status(403).json({ error: 'Account disabled', disabled: true });
      }
      run(db, 'UPDATE users SET disabled = 0 WHERE id = ?', [user.id]);
      user.disabled = 0;
    }

    // Two-factor: password was correct, so ask for the second factor.
    // Accepts an authenticator code or a one-time backup code.
    if (user.totp_enabled) {
      const code = String(req.body.code || '').trim();
      if (!code) {
        return res.status(401).json({ error: 'Enter your two-factor code', mfa_required: true });
      }
      if (totp.tooManyAttempts(user.id)) {
        return res.status(429).json({ error: 'Too many wrong codes. Try again in a few minutes.', mfa_required: true });
      }
      let ok = false;
      try { ok = totp.verifyTotp(totp.decryptSecret(user.totp_secret), code); } catch (e) { ok = false; }
      if (!ok) {
        const hash = totp.hashBackupCode(code);
        const row = get(db, 'SELECT code_hash FROM user_backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', [user.id, hash]);
        if (row) {
          run(db, 'UPDATE user_backup_codes SET used_at = ? WHERE user_id = ? AND code_hash = ?', [Date.now(), user.id, hash]);
          ok = true;
        }
      }
      if (!ok) {
        totp.recordFailure(user.id);
        return res.status(401).json({ error: 'Invalid two-factor code', mfa_required: true });
      }
      totp.clearFailures(user.id);
    }

    run(db, 'UPDATE users SET last_seen = ? WHERE id = ?', [Date.now(), user.id]);

    const token = signToken(user.id, createSession(db, user.id, req));
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        avatar: user.avatar || null,
        banner: user.banner || null,
        banner_color: user.banner_color || null,
        bio: user.bio || null,
        pronouns: user.pronouns || null,
        status: user.status || 'online',
        public_key: user.public_key || null,
        encrypted_private_key: user.encrypted_private_key || null,
        key_salt: user.key_salt || null,
        key_nonce: user.key_nonce || null,
        // Included so the frontend can cosmetically show/hide admin-only
        // UI (e.g. the admin nav link/route) without a separate request —
        // this is display-only; every admin endpoint re-checks the real
        // role server-side via requireAdmin (server/middleware/auth.js)
        // and never trusts this client-held copy.
        role: user.role || 'USER',
        totp_enabled: !!user.totp_enabled
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
    const payload = verifyToken(token);
    const db = await getUserDb();
    // `role` is selected here too (see the comment on it in the /login
    // response above) — dashboard.js refreshes currentUser from this
    // endpoint on every app load, so it's the other place the client's
    // cached role can go stale without this.
    const user = get(db, 'SELECT id, username, email, display_name, avatar, banner, banner_color, bio, pronouns, status, public_key, encrypted_private_key, key_salt, key_nonce, created_at, last_seen, role, totp_enabled, tokens_invalid_before FROM users WHERE id = ?', [payload.sub]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!tokenIsLive(db, payload, user.tokens_invalid_before)) {
      return res.status(401).json({ error: 'Session expired or revoked' });
    }
    delete user.tokens_invalid_before;
    user.totp_enabled = !!user.totp_enabled;
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
    const payload = verifyToken(token);
    const { status } = req.body;
    if (!status || !STATUSES.includes(status)) {
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