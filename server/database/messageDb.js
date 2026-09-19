// server/database/messageDb.js — messages, ported from src/messageDb.js.
// Only the data path changed (this file now lives one directory deeper).
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const MESSAGE_DB_PATH = path.join(__dirname, '..', '..', 'data', 'nyxie_messages.db');

let db = null;
let SqlJs = null;

// See the matching comment in userDb.js's persist() — same fix here:
// atomic temp-file-then-rename instead of a direct writeFileSync onto
// the live path, plus a one-generation .bak, so an interrupted write
// can't leave nyxie_messages.db as a half-written file SQLite then
// refuses to open.
function persist() {
  const data = db.export();
  const buffer = Buffer.from(data);
  const tmpPath = MESSAGE_DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, buffer);
  try {
    if (fs.existsSync(MESSAGE_DB_PATH)) fs.copyFileSync(MESSAGE_DB_PATH, MESSAGE_DB_PATH + '.bak');
  } catch (e) { /* best-effort backup; never block a persist on it */ }
  fs.renameSync(tmpPath, MESSAGE_DB_PATH);
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
      mime_type TEXT,
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
  // mime_type: the actual MIME type MediaRecorder produced for a voice
  // message (e.g. 'audio/webm;codecs=opus', or 'audio/mp4' on Safari,
  // which doesn't support webm). Recorded per-message rather than
  // assumed, since different senders' browsers can pick different
  // formats — the client needs this to reconstruct a valid Blob on
  // playback instead of guessing/hardcoding a type that may not match
  // what was actually recorded.
  try { db.run("ALTER TABLE messages ADD COLUMN mime_type TEXT"); } catch (e) {}
  // attachments: JSON-encoded array of {name, url, type} for uploaded files.
  try { db.run("ALTER TABLE messages ADD COLUMN attachments TEXT"); } catch (e) {}
  // mentions: JSON-encoded array of user IDs pinged by this message
  // (resolved client-side from @username, since the server can't parse
  // E2EE message content). Used to highlight the mention and to notify
  // the mentioned users over the websocket.
  try { db.run("ALTER TABLE messages ADD COLUMN mentions TEXT"); } catch (e) {}
  // reply_to_id: id of the message this one is replying to (or NULL).
  // Only the id is stored — the referenced message's author/content are
  // resolved at read time (see GET /:id/messages) so a reply always
  // reflects that message's *current* content (respecting edits/deletes)
  // instead of a stale copy, and so an E2EE reply doesn't require a
  // plaintext snippet to ever touch the database.
  try { db.run("ALTER TABLE messages ADD COLUMN reply_to_id TEXT"); } catch (e) {}

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

function flush() {
  if (db) persist();
}

module.exports = { getMessageDb, allMessages, getMessage, runMessage, flush };