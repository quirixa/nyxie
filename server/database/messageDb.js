// server/database/messageDb.js — messages, ported from src/messageDb.js.
// Only the data path changed (this file now lives one directory deeper).
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const MESSAGE_DB_PATH = path.join(__dirname, '..', '..', 'data', 'nyxie_messages.db');

let db = null;
let SqlJs = null;

function persist() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(MESSAGE_DB_PATH, buffer);
}

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
      nonce TEXT,
      msg_type TEXT DEFAULT 'text',
      duration INTEGER,
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      deleted INTEGER DEFAULT 0
    )
  `);

  // Migration: older nyxie_messages.db files were created before the
  // nonce/msg_type/duration columns existed, so CREATE TABLE IF NOT EXISTS
  // above won't add them to those files. Add them if missing.
  try { db.run("ALTER TABLE messages ADD COLUMN nonce TEXT"); } catch (e) {}
  // msg_type: 'text' (default) or 'voice' — voice messages store an
  // E2EE-encrypted audio blob (base64) in `content`, same as encrypted
  // text does, distinguished by this column so the client knows to
  // render an audio player instead of text.
  try { db.run("ALTER TABLE messages ADD COLUMN msg_type TEXT DEFAULT 'text'"); } catch (e) {}
  // duration: length of a voice message in whole seconds (voice only).
  try { db.run("ALTER TABLE messages ADD COLUMN duration INTEGER"); } catch (e) {}
  // attachments: JSON-encoded array of {name, url, type} for uploaded files.
  try { db.run("ALTER TABLE messages ADD COLUMN attachments TEXT"); } catch (e) {}
  // mentions: JSON-encoded array of user IDs pinged by this message
  // (resolved client-side from @username, since the server can't parse
  // E2EE message content). Used to highlight the mention and to notify
  // the mentioned users over the websocket.
  try { db.run("ALTER TABLE messages ADD COLUMN mentions TEXT"); } catch (e) {}

  persist();
  setInterval(persist, 5000);
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
    console.error('messageDb query failed:', sql, e.message);
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