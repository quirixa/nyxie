const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.PGHOST,
  port: 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: 'nyxie_messages'
});

// Initialize table (run once)
pool.query(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    edited_at BIGINT,
    deleted INTEGER DEFAULT 0
  );
`);

module.exports = pool;