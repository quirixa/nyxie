// server/database/userDb.js — users, servers, rooms, memberships,
// friends. Ported from src/userDb.js with two fixes:
//   1. Paths updated for this file's new location (server/database/
//      instead of src/) so data/ still resolves to <project root>/data.
//   2. The `messages` table definition + its ALTER TABLE migration were
//      removed. It was dead code: messages actually live in the
//      separate nyxie_messages.db (see messageDb.js), and nothing in
//      the app ever reads/writes a `messages` row through *this*
//      database handle — it was just unused schema left over from
//      before messages were split into their own DB file.
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const USER_DB_PATH = path.join(__dirname, '..', '..', 'data', 'nyxie_users.db');

let db = null;
let SqlJs = null;

function persist() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(USER_DB_PATH, buffer);
}

async function getUserDb() {
  if (db) return db;

  SqlJs = await initSqlJs();

  const dataDir = path.dirname(USER_DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  if (fs.existsSync(USER_DB_PATH)) {
    const fileBuffer = fs.readFileSync(USER_DB_PATH);
    db = new SqlJs.Database(fileBuffer);
  } else {
    db = new SqlJs.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT,
      banner TEXT,
      banner_color TEXT,
      bio TEXT,
      public_key TEXT,          -- E2EE: base64 encoded public key
      encrypted_private_key TEXT, -- E2EE: private key, encrypted client-side with a
                                   -- password-derived key (server never sees the
                                   -- plaintext private key or the password)
      key_salt TEXT,             -- base64 PBKDF2 salt used to derive the wrapping key
      key_nonce TEXT,            -- base64 nacl.secretbox nonce for encrypted_private_key
      status TEXT DEFAULT 'online',
      status_updated_at INTEGER,
      created_at INTEGER NOT NULL,
      last_seen INTEGER,
      disabled INTEGER DEFAULT 0
    )
  `);

  // Add missing columns if they don't exist (older DB files predate them)
  try { db.run("ALTER TABLE users ADD COLUMN public_key TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE users ADD COLUMN encrypted_private_key TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE users ADD COLUMN key_salt TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE users ADD COLUMN key_nonce TEXT"); } catch (e) {}
  // banner/banner_color were added to the CREATE TABLE above after some
  // DBs already existed on disk — CREATE TABLE IF NOT EXISTS is a no-op
  // against an existing table, so those DBs never actually got the new
  // columns without a migration here (same reason the four above exist).
  try { db.run("ALTER TABLE users ADD COLUMN banner TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE users ADD COLUMN banner_color TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE users ADD COLUMN bio TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE users ADD COLUMN status_updated_at INTEGER"); } catch (e) {}
  try { db.run("ALTER TABLE users ADD COLUMN disabled INTEGER DEFAULT 0"); } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS server_members (
      server_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, user_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      is_dm INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS friends (
      id TEXT PRIMARY KEY,
      user_a TEXT NOT NULL,
      user_b TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted',
      created_at INTEGER NOT NULL,
      UNIQUE(user_a, user_b)
    )
  `);

  // Default server
  const defaultServer = db.exec("SELECT id FROM servers WHERE name = 'Nyxie'");
  if (!defaultServer.length || !defaultServer[0].values.length) {
    const serverId = 'nyxie-default';
    const now = Date.now();
    db.run(`INSERT INTO servers (id, name, owner_id, created_at) VALUES (?, 'Nyxie', 'system', ?)`, [serverId, now]);
    db.run(`INSERT OR IGNORE INTO rooms (id, server_id, name, description, created_by, created_at, is_dm)
            VALUES ('general', ?, 'general', 'The main chat room', 'system', ?, 0)`, [serverId, now]);
    db.run(`INSERT OR IGNORE INTO rooms (id, server_id, name, description, created_by, created_at, is_dm)
            VALUES ('random', ?, 'random', 'Anything goes', 'system', ?, 0)`, [serverId, now]);
    db.run(`INSERT OR IGNORE INTO rooms (id, server_id, name, description, created_by, created_at, is_dm)
            VALUES ('introductions', ?, 'introductions', 'Introduce yourself', 'system', ?, 0)`, [serverId, now]);
  }

  persist();
  setInterval(persist, 5000);
  return db;
}

function all(db, sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) {
    console.error('userDb query failed:', sql, e.message);
    return [];
  }
}

function get(db, sql, params = []) {
  const rows = all(db, sql, params);
  return rows[0] || null;
}

// Tracks whether we're inside a BEGIN/COMMIT block so `run()` below can
// skip persisting mid-transaction. This matters because sql.js's
// `Database.export()` — which persist() calls — quietly invalidates any
// in-progress transaction (calling it between BEGIN and COMMIT makes the
// subsequent COMMIT fail with "cannot commit - no transaction is
// active"). walletService.js's writeTransaction() relies on
// BEGIN/COMMIT for atomicity (see its header comment), so persisting on
// every single statement — as this function used to do unconditionally
// — silently broke every multi-statement transaction, including the
// double-spend protection in transfer(). Persisting once, after COMMIT/
// ROLLBACK, preserves that guarantee while still writing to disk after
// every statement outside of a transaction, same as before.
let inTransaction = false;

function run(db, sql, params = []) {
  const kind = sql.trim().slice(0, 12).toUpperCase();
  db.run(sql, params);
  if (kind.startsWith('BEGIN')) {
    inTransaction = true;
    return;
  }
  if (kind.startsWith('COMMIT') || kind.startsWith('ROLLBACK')) {
    inTransaction = false;
    persist();
    return;
  }
  if (!inTransaction) persist();
}

module.exports = { getUserDb, all, get, run };
