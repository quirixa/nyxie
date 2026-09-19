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

// Persisting used to be a single fs.writeFileSync straight onto the live
// .db path. That's not atomic: sql.js's Database.export() -> writeFileSync
// takes a moment for a database of any size, and this file is a SQLite
// file format, not an append-only log — a write that gets interrupted
// partway (process killed, container restarted, host OOM, deploy) leaves
// a *partial* file on disk, which SQLite then refuses to open at all
// ("database disk image is malformed"). Every user/server/room query
// then fails, which is exactly what surfaced as broken member lists and
// profile lookups — the queries themselves were fine, the file backing
// them wasn't.
//
// Fixed by writing to a temp file in the same directory and only then
// renaming it over the real path. rename(2) on the same filesystem is
// atomic on POSIX — the live file is either the old complete version or
// the new complete version, never a half-written one. We also keep a
// one-generation backup of the last known-good file (best effort) so a
// corruption from any other cause (disk fault, etc.) has something to
// restore from instead of losing everything.
function persist() {
  const data = db.export();
  const buffer = Buffer.from(data);
  const tmpPath = USER_DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, buffer);
  try {
    if (fs.existsSync(USER_DB_PATH)) fs.copyFileSync(USER_DB_PATH, USER_DB_PATH + '.bak');
  } catch (e) { /* best-effort backup; never block a persist on it */ }
  fs.renameSync(tmpPath, USER_DB_PATH);
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
      pronouns TEXT,
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
  // pronouns is free-text (like Discord's), optional, shown in the profile
  // popout under the username — added defensively the same way as the
  // columns above so existing DB files pick it up without a full migration.
  try { db.run("ALTER TABLE users ADD COLUMN pronouns TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE users ADD COLUMN status_updated_at INTEGER"); } catch (e) {}
  try { db.run("ALTER TABLE users ADD COLUMN disabled INTEGER DEFAULT 0"); } catch (e) {}
  // `role` also gets added defensively by walletDb.js's ensureWalletTables(),
  // but that only runs lazily on first use of a wallet route — too late for
  // middleware/auth.js, which selects `role` on every authenticated request
  // starting from server startup. Adding it here too guarantees it exists
  // before any request can hit that query.
  try { db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'USER'"); } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  // description was added after some servers.db files already existed —
  // same reasoning as the users-table migrations above.
  try { db.run("ALTER TABLE servers ADD COLUMN description TEXT"); } catch (e) {}
  // is_discoverable: whether the server shows up in GET /api/servers/discover
  // search results. Servers are private (invite-only) by default — an
  // owner has to opt in via "Make discoverable" at creation or later in
  // server settings. See routes/servers.js.
  try { db.run("ALTER TABLE servers ADD COLUMN is_discoverable INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  db.run('CREATE INDEX IF NOT EXISTS idx_servers_discoverable ON servers (is_discoverable)');
  // category: one of the fixed Discovery categories in
  // services/discoveryCategories.js (Gaming, Music, Entertainment,
  // Science & Tech, Education, Student Hubs), or NULL/uncategorized.
  // Added after existing servers.db files already existed — same
  // migration pattern as description/is_discoverable above.
  try { db.run("ALTER TABLE servers ADD COLUMN category TEXT"); } catch (e) {}
  db.run('CREATE INDEX IF NOT EXISTS idx_servers_category ON servers (category)');
  // Composite index for the Discovery listing's actual query shape:
  // WHERE is_discoverable = 1 [AND category = ?], joined against
  // server_members and ordered by member count. This index lets that
  // WHERE clause resolve without a full table scan as the servers table
  // grows; the JOIN/GROUP BY still does the member-count aggregation
  // (member counts are never cached/stale — see GET /servers/discover).
  db.run('CREATE INDEX IF NOT EXISTS idx_servers_discoverable_category ON servers (is_discoverable, category)');

  db.run(`
    CREATE TABLE IF NOT EXISTS server_members (
      server_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, user_id)
    )
  `);
  // role_id: FK (informal — sql.js doesn't enforce it) into server_roles.
  // nickname: per-server display name override; does NOT touch the
  // user's global username/display_name (see server_members section of
  // the servers/groups feature spec).
  // muted: server-wide mute (blocks SEND_MESSAGES regardless of role).
  try { db.run("ALTER TABLE server_members ADD COLUMN role_id TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE server_members ADD COLUMN nickname TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE server_members ADD COLUMN muted INTEGER DEFAULT 0"); } catch (e) {}

  // Roles a server can assign to members. Every server gets three
  // default roles (Admin/Moderator/Member) created in
  // services/permissions.js at server-creation time; MANAGE_SERVER
  // holders can also create further custom roles via the API, which is
  // why `permissions` is a plain bitmask column rather than a fixed enum.
  db.run(`
    CREATE TABLE IF NOT EXISTS server_roles (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      permissions INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_server_roles_server ON server_roles (server_id)');

  // Server-level bans. Kept separate from `blocks` (which is a per-user,
  // cross-server relationship) — a server ban only prevents rejoining
  // *this* server via invite, it has nothing to do with DMs.
  db.run(`
    CREATE TABLE IF NOT EXISTS server_bans (
      server_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      banned_by TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, user_id)
    )
  `);

  // Server invites. `code` doubles as the shareable /invite/<code> path
  // segment, so it's the primary key rather than a separate uuid id.
  db.run(`
    CREATE TABLE IF NOT EXISTS server_invites (
      code TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      max_uses INTEGER,
      uses INTEGER DEFAULT 0,
      revoked INTEGER DEFAULT 0
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_server_invites_server ON server_invites (server_id)');

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
  // is_group: distinguishes a multi-member private group chat (is_dm=1,
  // is_group=1) from a plain 1-to-1 DM (is_dm=1, is_group=0). Channels
  // inside a server are is_dm=0 with server_id set, same as before.
  // icon: group chat icon (servers already had one via `servers.icon`;
  // channels don't have their own icon, only groups do).
  // position: display order of channels within a server's sidebar.
  try { db.run("ALTER TABLE rooms ADD COLUMN is_group INTEGER DEFAULT 0"); } catch (e) {}
  try { db.run("ALTER TABLE rooms ADD COLUMN icon TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE rooms ADD COLUMN position INTEGER DEFAULT 0"); } catch (e) {}
  db.run('CREATE INDEX IF NOT EXISTS idx_rooms_server ON rooms (server_id)');
  db.run(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members (user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members (user_id)');
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

  // Badge OWNERSHIP (which user has which badge). Badge DEFINITIONS (name,
  // icon, colour, order…) are not in the database — they live in
  // server/config/badge_definitions.json; see services/badges.js. The
  // composite primary key is what prevents duplicate badges.
  db.run(`
    CREATE TABLE IF NOT EXISTS user_badges (
      user_id TEXT NOT NULL,
      badge_id TEXT NOT NULL,
      assigned_by TEXT,
      assigned_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, badge_id)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_user_badges_badge ON user_badges (badge_id)');

  // NOTE: this used to unconditionally seed a hardcoded 'nyxie-default'
  // server (owner_id 'system', a user that doesn't exist) and silently
  // enroll every newly-registered user into it (see the removed block in
  // routes/auth.js's /register handler). That produced an unexplained
  // server nobody actually created and nobody could actually own/manage
  // (no real user ever matches owner_id 'system', so the owner crown,
  // MANAGE_SERVER, and delete never worked for it either). Servers are
  // now only ever created by a real, authenticated user via
  // POST /api/servers, so there is no default/seeded server for fresh
  // installs.
  //
  // Migration for installs that already have the old seeded server: keep
  // the data (don't destroy existing channels/messages/members) but make
  // it a normal, intentional, publicly-discoverable server instead of a
  // mystery one, so it still shows up (opt-in, via Discover) rather than
  // being force-injected into every account.
  try { db.run("UPDATE servers SET is_discoverable = 1 WHERE id = 'nyxie-default'"); } catch (e) {}

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

function flush() {
  if (db) persist();
}

module.exports = { getUserDb, all, get, run, flush };
