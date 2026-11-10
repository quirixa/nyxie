// server/routes/messageRequests.js — Message Requests (0.12.0).
//
// A message from someone you are not friends with is NOT a direct message.
// It is a request: one end-to-end encrypted initial message that the
// recipient can accept, ignore or deny. Until it is accepted there is no
// room, so the sender has no access to the recipient's DM inbox, cannot send
// follow-ups, and the recipient gets no ordinary DM notification.
//
// Zero-access: this file never decrypts anything. It validates the SHAPE of
// the encrypted payload (ciphertext + nonce + a wrapped key for exactly the
// sender and the recipient) and stores/relays it. On accept the same
// ciphertext is copied into the normal messages table untouched, so the
// conversation continues in the normal encrypted DM system.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getUserDb, all, get, run } = require('../database/userDb');
const { getMessageDb, runMessage } = require('../database/messageDb');
const { requireAuth } = require('../middleware/auth');
const { isBlocked } = require('../services/blocks');
const { areFriends, findDirectRoom, createDirectRoom } = require('../services/dms');
const { MESSAGE_MAX_CIPHERTEXT_B64 } = require('../config/limits');

const MAX_OPEN_OUTGOING = 25;                 // open requests one user may have at once
const DENY_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // after a deny, the same sender must wait
const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const B64_RE = /^[A-Za-z0-9+/=]+$/;

// Same wire shape the DM pipeline uses: { [userId]: { ciphertext, nonce } }.
// For a request it must hold EXACTLY the sender and the recipient — no
// third party can be given a key, and neither side can be left without one.
function cleanEnvelopes(env, senderId, recipientId) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  const keys = Object.keys(env);
  if (keys.length !== 2 || !keys.includes(senderId) || !keys.includes(recipientId)) return null;
  const out = {};
  for (const id of keys) {
    const e = env[id];
    if (!e || typeof e.ciphertext !== 'string' || typeof e.nonce !== 'string') return null;
    if (e.ciphertext.length > 2048 || e.nonce.length > 128 || !B64_RE.test(e.ciphertext) || !B64_RE.test(e.nonce)) return null;
    out[id] = { ciphertext: e.ciphertext, nonce: e.nonce };
  }
  return out;
}

function profileOf(db, id) {
  return get(db, 'SELECT id, username, display_name, avatar, avatar_decoration, public_key FROM users WHERE id = ?', [id]);
}

// Servers both people are in (names only) — context for the recipient.
function mutualServers(db, a, b) {
  return all(db, `
    SELECT s.id, s.name FROM servers s
    JOIN server_members m1 ON m1.server_id = s.id AND m1.user_id = ?
    JOIN server_members m2 ON m2.server_id = s.id AND m2.user_id = ?
    ORDER BY s.name LIMIT 5
  `, [a, b]);
}

// What each side is allowed to learn. The sender never learns that a request
// was ignored (it keeps reading "pending"); a denial is reported only as
// "declined", with no reason and no timestamps.
function present(db, r, viewerId) {
  const isRecipient = r.recipient_id === viewerId;
  let status = r.status;
  if (!isRecipient) status = r.status === 'ignored' ? 'pending' : (r.status === 'denied' ? 'declined' : r.status);
  const out = {
    id: r.id, status, created_at: r.created_at,
    direction: isRecipient ? 'incoming' : 'outgoing',
    ciphertext: r.ciphertext || null, nonce: r.nonce || null,
    key_envelopes: r.key_envelopes ? JSON.parse(r.key_envelopes) : null,
    sender_public_key: r.sender_public_key || null,
    recipient_public_key: r.recipient_public_key || null,
    room_id: r.status === 'accepted' ? r.room_id : null
  };
  if (isRecipient) {
    out.sender = profileOf(db, r.sender_id);
    out.mutual_servers = mutualServers(db, r.sender_id, r.recipient_id);
  } else {
    out.recipient = profileOf(db, r.recipient_id);
  }
  return out;
}

const pendingCount = (db, uid) =>
  (get(db, `SELECT COUNT(*) AS n FROM message_requests WHERE recipient_id = ? AND status = 'pending'`, [uid]) || { n: 0 }).n;

// Ends a request without accepting it. The encrypted payload is erased so a
// request that never became a conversation leaves nothing behind.
function endRequest(db, id, status, { roomId = null } = {}) {
  const now = Date.now();
  run(db, `UPDATE message_requests SET status = ?, updated_at = ?,
             accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_at END,
             denied_at = CASE WHEN ? = 'denied' THEN ? ELSE denied_at END,
             room_id = COALESCE(?, room_id),
             ciphertext = NULL, nonce = NULL, key_envelopes = NULL WHERE id = ?`,
    [status, now, status, now, status, now, roomId, id]);
}

// Used by the block flow: blocking someone removes every open request
// between you, in both directions, and erases its payload.
function cancelOpenBetween(db, a, b) {
  const rows = all(db, `SELECT id FROM message_requests WHERE status IN ('pending','ignored') AND
    ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))`, [a, b, b, a]);
  for (const r of rows) endRequest(db, r.id, 'cancelled');
  return rows.length;
}

// ── POST /api/message-requests — send the one initial (encrypted) message ──
router.post('/', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const me = req.user.id;
  const { recipient_id, ciphertext, nonce, key_envelopes, sender_public_key, recipient_public_key } = req.body || {};

  if (typeof recipient_id !== 'string' || !ID_RE.test(recipient_id)) return res.status(400).json({ error: 'recipient_id required' });
  if (recipient_id === me) return res.status(400).json({ error: 'You cannot message yourself' });
  const target = get(db, 'SELECT id, disabled, public_key FROM users WHERE id = ?', [recipient_id]);
  if (!target || target.disabled) return res.status(404).json({ error: 'User not found' });

  // 1. blocked either way → generic refusal (does not say who blocked whom)
  if (isBlocked(db, me, recipient_id)) return res.status(403).json({ error: 'You cannot send a message request to this user', code: 'UNAVAILABLE' });
  // 2. friends → no request: use the normal DM
  if (areFriends(db, me, recipient_id)) {
    return res.status(409).json({ error: 'You are already friends — send a normal message instead', code: 'ALREADY_FRIENDS', room_id: findDirectRoom(db, me, recipient_id) });
  }
  // 3. an existing DM is available (e.g. a former friend) → use it
  const existingRoom = findDirectRoom(db, me, recipient_id);
  if (existingRoom) return res.status(409).json({ error: 'You already have a conversation with this user', code: 'DM_EXISTS', room_id: existingRoom });
  // 4. duplicate open request (pending OR ignored — the sender cannot tell which)
  const open = get(db, `SELECT id FROM message_requests WHERE sender_id = ? AND recipient_id = ? AND status IN ('pending','ignored')`, [me, recipient_id]);
  if (open) return res.status(409).json({ error: 'You already have a message request waiting for this user', code: 'REQUEST_PENDING', request_id: open.id });
  // 5. recipient denied recently → generic refusal, no hint it was a denial
  const denied = get(db, `SELECT denied_at FROM message_requests WHERE sender_id = ? AND recipient_id = ? AND status = 'denied' ORDER BY denied_at DESC LIMIT 1`, [me, recipient_id]);
  if (denied && Date.now() - (denied.denied_at || 0) < DENY_COOLDOWN_MS) {
    return res.status(403).json({ error: 'You cannot send a message request to this user right now', code: 'UNAVAILABLE' });
  }
  // 6. cap on simultaneous open requests (anti-spam)
  const openCount = (get(db, `SELECT COUNT(*) AS n FROM message_requests WHERE sender_id = ? AND status IN ('pending','ignored')`, [me]) || { n: 0 }).n;
  if (openCount >= MAX_OPEN_OUTGOING) return res.status(429).json({ error: 'You have too many message requests waiting. Wait for some to be answered.', code: 'TOO_MANY' });

  // 7. the payload must be real ciphertext for exactly sender + recipient
  if (typeof ciphertext !== 'string' || typeof nonce !== 'string' || !ciphertext || !nonce ||
      !B64_RE.test(ciphertext) || !B64_RE.test(nonce) || nonce.length > 128 || ciphertext.length > MESSAGE_MAX_CIPHERTEXT_B64) {
    return res.status(400).json({ error: 'A message request must be end-to-end encrypted', code: 'E2EE_REQUIRED' });
  }
  const envelopes = cleanEnvelopes(key_envelopes, me, recipient_id);
  if (!envelopes) return res.status(400).json({ error: 'A message request must be end-to-end encrypted for the sender and the recipient', code: 'E2EE_REQUIRED' });

  // 8. the keys the sender encrypted to must be the keys currently on file,
  // otherwise the request would be unreadable (stale key) — the client
  // re-fetches and retries. (Detecting a *malicious* key swap is the
  // client's job: key pinning + safety numbers.)
  const meRow = get(db, 'SELECT public_key FROM users WHERE id = ?', [me]);
  if (!target.public_key) return res.status(409).json({ error: 'This user has not set up encryption yet', code: 'NO_KEY' });
  if (!meRow || !meRow.public_key || sender_public_key !== meRow.public_key || recipient_public_key !== target.public_key) {
    return res.status(409).json({ error: 'Encryption keys changed. Try again.', code: 'KEY_MISMATCH' });
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    run(db, `INSERT INTO message_requests (id, sender_id, recipient_id, status, ciphertext, nonce, key_envelopes, sender_public_key, recipient_public_key, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      [id, me, recipient_id, ciphertext, nonce, JSON.stringify(envelopes), sender_public_key, recipient_public_key, now, now]);
  } catch (e) {
    // the partial unique index is the final word on duplicates
    return res.status(409).json({ error: 'You already have a message request waiting for this user', code: 'REQUEST_PENDING' });
  }

  const row = get(db, 'SELECT * FROM message_requests WHERE id = ?', [id]);
  const { broadcastToUser } = req.app.locals;
  // The recipient gets the encrypted payload only on their own socket(s) —
  // never in a room broadcast — and a badge count, but no DM notification.
  broadcastToUser(recipient_id, { type: 'message_request', request: present(db, row, recipient_id), pending_count: pendingCount(db, recipient_id) });
  broadcastToUser(me, { type: 'message_request_sent', request: present(db, row, me) });
  res.status(201).json({ ok: true, request: present(db, row, me) });
});

// ── GET /api/message-requests?box=incoming|ignored|outgoing ───────────────
router.get('/', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const me = req.user.id;
  const box = req.query.box || 'incoming';
  let rows;
  if (box === 'incoming') rows = all(db, `SELECT * FROM message_requests WHERE recipient_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 100`, [me]);
  else if (box === 'ignored') rows = all(db, `SELECT * FROM message_requests WHERE recipient_id = ? AND status = 'ignored' ORDER BY created_at DESC LIMIT 100`, [me]);
  else if (box === 'outgoing') rows = all(db, `SELECT * FROM message_requests WHERE sender_id = ? AND status IN ('pending','ignored') ORDER BY created_at DESC LIMIT 100`, [me]);
  else return res.status(400).json({ error: 'Unknown box' });
  res.json({ requests: rows.map(r => present(db, r, me)), pending_count: pendingCount(db, me) });
});

router.get('/count', requireAuth, async (req, res) => {
  const db = await getUserDb();
  res.json({ pending_count: pendingCount(db, req.user.id) });
});

// Ownership is enforced here, in the query: another user's request id is
// indistinguishable from a request that does not exist (404).
function loadMine(db, id, userId, role) {
  const col = role === 'recipient' ? 'recipient_id' : 'sender_id';
  return get(db, `SELECT * FROM message_requests WHERE id = ? AND ${col} = ?`, [id, userId]);
}

router.get('/:id', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const r = get(db, 'SELECT * FROM message_requests WHERE id = ? AND (sender_id = ? OR recipient_id = ?)', [req.params.id, req.user.id, req.user.id]);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  res.json({ request: present(db, r, req.user.id) });
});

// ── Accept: creates/activates the normal DM and moves the ciphertext in ───
router.post('/:id/accept', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const msgDb = await getMessageDb();   // every await is above; what follows is synchronous (race-free)
  const me = req.user.id;
  const r = loadMine(db, req.params.id, me, 'recipient');
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (r.status === 'accepted' && r.room_id) return res.json({ ok: true, room_id: r.room_id });   // idempotent
  if (r.status !== 'pending' && r.status !== 'ignored') return res.status(404).json({ error: 'Request not found' });
  if (isBlocked(db, me, r.sender_id)) {
    endRequest(db, r.id, 'cancelled');
    return res.status(403).json({ error: 'You cannot accept this request' });
  }
  // sanity: the stored payload must still be intact
  if (!r.ciphertext || !r.nonce || !r.key_envelopes) return res.status(409).json({ error: 'This request can no longer be accepted' });

  let roomId = findDirectRoom(db, me, r.sender_id);   // never create a duplicate DM
  const created = !roomId;
  if (!roomId) roomId = createDirectRoom(db, r.sender_id, me);

  runMessage(msgDb,
    'INSERT INTO messages (id, room_id, user_id, content, nonce, msg_type, key_envelopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), roomId, r.sender_id, r.ciphertext, r.nonce, 'text', r.key_envelopes, r.created_at]);
  endRequest(db, r.id, 'accepted', { roomId });
  // endRequest erases the request's own copy: the one remaining copy of the
  // ciphertext is the message in the normal DM, still encrypted.

  const { broadcastToUser } = req.app.locals;
  const sender = profileOf(db, r.sender_id), recipient = profileOf(db, me);
  const brief = u => ({ id: u.id, username: u.username, display_name: u.display_name || u.username });
  broadcastToUser(r.sender_id, { type: 'dm_created', room_id: roomId, with_user: brief(recipient) });
  broadcastToUser(me, { type: 'dm_created', room_id: roomId, with_user: brief(sender) });
  broadcastToUser(r.sender_id, { type: 'message_request_updated', request_id: r.id, status: 'accepted', room_id: roomId });
  broadcastToUser(me, { type: 'message_request_updated', request_id: r.id, status: 'accepted', room_id: roomId, pending_count: pendingCount(db, me) });
  res.json({ ok: true, room_id: roomId, created });
});

// ── Ignore: hidden from the recipient's pending list; sender is NOT told ──
router.post('/:id/ignore', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const r = loadMine(db, req.params.id, req.user.id, 'recipient');
  if (!r || (r.status !== 'pending' && r.status !== 'ignored')) return res.status(404).json({ error: 'Request not found' });
  if (r.status === 'pending') run(db, `UPDATE message_requests SET status = 'ignored', ignored_at = ?, updated_at = ? WHERE id = ?`, [Date.now(), Date.now(), r.id]);
  // only the recipient's own sessions hear about it — never the sender
  req.app.locals.broadcastToUser(req.user.id, { type: 'message_request_updated', request_id: r.id, status: 'ignored', pending_count: pendingCount(db, req.user.id) });
  res.json({ ok: true });
});

// ── Deny: ends the request for good (payload erased), sender gets a bare "declined"
router.post('/:id/deny', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const r = loadMine(db, req.params.id, req.user.id, 'recipient');
  if (!r || (r.status !== 'pending' && r.status !== 'ignored')) return res.status(404).json({ error: 'Request not found' });
  endRequest(db, r.id, 'denied');
  const { broadcastToUser } = req.app.locals;
  broadcastToUser(r.sender_id, { type: 'message_request_updated', request_id: r.id, status: 'declined' });
  broadcastToUser(req.user.id, { type: 'message_request_updated', request_id: r.id, status: 'denied', pending_count: pendingCount(db, req.user.id) });
  res.json({ ok: true });
});

// ── Cancel: the sender withdraws their own request ────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const r = loadMine(db, req.params.id, req.user.id, 'sender');
  if (!r || (r.status !== 'pending' && r.status !== 'ignored')) return res.status(404).json({ error: 'Request not found' });
  endRequest(db, r.id, 'cancelled');
  const { broadcastToUser } = req.app.locals;
  broadcastToUser(r.recipient_id, { type: 'message_request_updated', request_id: r.id, status: 'cancelled', pending_count: pendingCount(db, r.recipient_id) });
  broadcastToUser(req.user.id, { type: 'message_request_updated', request_id: r.id, status: 'cancelled' });
  res.json({ ok: true });
});

module.exports = router;
module.exports.cancelOpenBetween = cancelOpenBetween;
module.exports.pendingCount = pendingCount;
