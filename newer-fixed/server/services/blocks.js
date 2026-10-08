// Shared helpers for the user-blocking feature. Kept in one place so the
// friends routes (block/unblock/list), rooms routes (DM creation +
// messaging) and the websocket layer (call signaling) all agree on what
// "blocked" means without duplicating SQL everywhere.
//
// Blocking is directional and stored in its own table rather than reusing
// `friends`/`friend_requests`, since a block isn't a mutual relationship
// the way a friendship is: A can block B without B blocking A back.

const { run, get, all } = require('../database/userDb');

let ready = false;

function ensureBlocksTable(db) {
  if (ready) return;
  run(db, `
    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY,
      blocker_id TEXT NOT NULL,
      blocked_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(blocker_id, blocked_id)
    )
  `);
  run(db, 'CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks (blocker_id)');
  run(db, 'CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks (blocked_id)');
  ready = true;
}

// True if either user has blocked the other. Use this to gate things like
// "can these two people DM/call each other" where it shouldn't matter who
// blocked whom.
function isBlocked(db, userA, userB) {
  ensureBlocksTable(db);
  return !!get(db, `
    SELECT 1 FROM blocks
    WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
  `, [userA, userB, userB, userA]);
}

// Directional: did `blockerId` specifically block `blockedId`?
function hasBlocked(db, blockerId, blockedId) {
  ensureBlocksTable(db);
  return !!get(db, 'SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [blockerId, blockedId]);
}

function listBlocked(db, blockerId) {
  ensureBlocksTable(db);
  return all(db, `
    SELECT u.id, u.username, u.display_name, u.avatar, b.created_at AS blocked_at
    FROM blocks b
    JOIN users u ON u.id = b.blocked_id
    WHERE b.blocker_id = ?
    ORDER BY b.created_at DESC
  `, [blockerId]);
}

module.exports = { ensureBlocksTable, isBlocked, hasBlocked, listBlocked };