// server/database/messageDbPg.js — Postgres-backed messages store.
// Not currently wired into any route (messageDb.js / sql.js is the
// active store, same as before this refactor); kept in sync in case
// it's switched on later.
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.PGHOST,
  port: 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: 'nyxie_messages'
});

pool.query(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    nonce TEXT,
    msg_type TEXT DEFAULT 'text',
    duration INTEGER,
    created_at BIGINT NOT NULL,
    edited_at BIGINT,
    deleted INTEGER DEFAULT 0
  );
`).catch(err => console.error('messageDbPg init error (pool unused unless wired in):', err.message));

pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS nonce TEXT`).catch(() => {});
pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_type TEXT DEFAULT 'text'`).catch(() => {});
pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS duration INTEGER`).catch(() => {});

module.exports = pool;
