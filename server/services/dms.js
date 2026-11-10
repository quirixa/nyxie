// Shared helpers for one-to-one direct messages. Kept in one place so the
// rooms route (POST /rooms/dm), the message-request accept flow and the
// friend/profile flows all agree on what an existing DM is and how a new one
// is created — there must never be two implementations that could disagree
// and produce duplicate conversations.
const crypto = require('crypto');
const { get, run } = require('../database/userDb');

function areFriends(db, a, b) {
  return !!get(db, `
    SELECT 1 FROM friends
    WHERE ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)) AND status = 'accepted'
  `, [a, b, b, a]);
}

// The existing 1:1 DM room between two users, if any (group DMs excluded).
function findDirectRoom(db, a, b) {
  const row = get(db, `
    SELECT r.id FROM rooms r
    JOIN room_members rm1 ON rm1.room_id = r.id AND rm1.user_id = ?
    JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id = ?
    WHERE r.is_dm = 1 AND (r.is_group IS NULL OR r.is_group = 0)
    AND (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) = 2
    LIMIT 1
  `, [a, b]);
  return row ? row.id : null;
}

// Creates the room + both memberships. Caller has already decided that these
// two users are allowed to have a DM; this never checks friendship itself.
function createDirectRoom(db, creatorId, otherId) {
  const roomId = crypto.randomUUID();
  const now = Date.now();
  run(db, 'INSERT INTO rooms (id, name, description, created_by, created_at, is_dm) VALUES (?, ?, ?, ?, ?, 1)',
    [roomId, `dm-${creatorId}-${otherId}`, '', creatorId, now]);
  run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [roomId, creatorId, now]);
  run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [roomId, otherId, now]);
  return roomId;
}

module.exports = { areFriends, findDirectRoom, createDirectRoom };
