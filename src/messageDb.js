const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const MESSAGE_DB_PATH = path.join(__dirname, '..', 'data', 'nyxie_messages.db');

let db = null;
let SqlJs = null;

function persist() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(MESSAGE_DB_PATH, buffer);
}

let persistInterval = null;

async function getMessageDb() {
  if (db) return db;

  SqlJs = await initSqlJs();

  const dataDir = path.dirname(MESSAGE_DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  if (fs.existsSync(MESSAGE_DB_PATH)) {
    const fileBuffer = fs.readFileSync(MESSAGE_DB_PATH);
    db = new SqlJs.Database(fileBuffer);
  } else {
    db = new SqlJs.Database();
  }

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

  persist();
  persistInterval = setInterval(persist, 5000);
  return db;
}

function allMessages(db, sql, params = []) {
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

function getMessage(db, sql, params = []) {
  const rows = allMessages(db, sql, params);
  return rows[0] || null;
}

function runMessage(db, sql, params = []) {
  db.run(sql, params);
  persist();
}

module.exports = { getMessageDb, allMessages, getMessage, runMessage };