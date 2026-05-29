const initSqlJs = require('../node_modules/sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'nyxie.db');

let db = null;
let SqlJs = null;

// Save DB to disk
function persist() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Auto-save every 5 seconds
let persistInterval = null;

async function getDb() {
  if (db) return db;

  SqlJs = await initSqlJs();

  // Ensure data dir exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Load existing DB or create fresh
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SqlJs.Database(fileBuffer);
  } else {
    db = new SqlJs.Database();
  }

  // Schema
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      seed_hash TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
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
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      deleted INTEGER DEFAULT 0
    )
  `);

  // Seed default rooms
  const existing = db.exec("SELECT id FROM rooms WHERE id = 'general'");
  if (!existing.length || !existing[0].values.length) {
    db.run(`INSERT OR IGNORE INTO rooms VALUES ('general','general','The main chat room','system',${Date.now()},0)`);
    db.run(`INSERT OR IGNORE INTO rooms VALUES ('random','random','Anything goes','system',${Date.now()},0)`);
    db.run(`INSERT OR IGNORE INTO rooms VALUES ('introductions','introductions','Introduce yourself','system',${Date.now()},0)`);
  }

  persist();

  // Auto-persist
  persistInterval = setInterval(persist, 5000);

  return db;
}

// Thin query helpers
function all(db, sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) {
    return [];
  }
}

function get(db, sql, params = []) {
  const rows = all(db, sql, params);
  return rows[0] || null;
}

function run(db, sql, params = []) {
  db.run(sql, params);
  persist();
}

module.exports = { getDb, all, get, run, persist };