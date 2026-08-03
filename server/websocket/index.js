const WebSocket = require('ws');
const { verifyToken } = require('../services/jwt');
const { getUserDb, get, run, all } = require('../database/userDb');

const roomClients = new Map();
const clientMeta = new Map();
const userConnections = new Map();

// Voice-call signaling state. The server only ever relays opaque SDP/ICE
// payloads between the two participants — it never sees call audio (that
// flows peer-to-peer once WebRTC negotiation completes) and never sees
// the call's encryption key (the two ends exchange ephemeral public keys
// through this same relay and derive a shared secret client-side via
// nacl.box, which the server cannot compute). This map just tracks who's
// currently in a call with whom so we can enforce "one call at a time"
// and clean things up if someone disconnects mid-call.
// call_id -> { callerId, calleeId, roomId }
const activeCalls = new Map();
// userId -> call_id, for quick "are you already on a call?" checks
const userActiveCall = new Map();

function endCallForUser(userId, reason) {
  const callId = userActiveCall.get(userId);
  if (!callId) return;
  const call = activeCalls.get(callId);
  if (!call) { userActiveCall.delete(userId); return; }
  const otherId = call.callerId === userId ? call.calleeId : call.callerId;
  activeCalls.delete(callId);
  userActiveCall.delete(call.callerId);
  userActiveCall.delete(call.calleeId);
  broadcastToUser(otherId, { type: 'call_end', call_id: callId, reason: reason || 'peer_disconnected' });
}

function broadcast(roomId, data) {
  const clients = roomClients.get(roomId);
  if (!clients) return;
  const payload = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function broadcastToUser(userId, data) {
  const conns = userConnections.get(userId);
  if (!conns) return;
  const payload = JSON.stringify(data);
  for (const ws of conns) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function broadcastPresence(roomId, userId, status, displayName, avatar) {
  broadcast(roomId, {
    type: 'presence_update',
    user_id: userId,
    status,
    display_name: displayName || null,
    avatar: avatar || null
  });
}

function joinRoom(ws, roomId) {
  if (!roomClients.has(roomId)) roomClients.set(roomId, new Set());
  roomClients.get(roomId).add(ws);
  const meta = clientMeta.get(ws);
  if (meta) meta.rooms.add(roomId);
}

function leaveRoom(ws, roomId) {
  const clients = roomClients.get(roomId);
  if (clients) {
    clients.delete(ws);
    if (clients.size === 0) roomClients.delete(roomId);
  }
  const meta = clientMeta.get(ws);
  if (meta) meta.rooms.delete(roomId);
}

async function cleanupClient(ws) {
  const meta = clientMeta.get(ws);
  if (!meta) return;

  const remainingConns = userConnections.get(meta.userId);
  const isLastConnection = !remainingConns || remainingConns.size <= 1;
  if (isLastConnection) endCallForUser(meta.userId, 'peer_disconnected');

  for (const roomId of meta.rooms) {
    const clients = roomClients.get(roomId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) roomClients.delete(roomId);
    }
    broadcastPresence(roomId, meta.userId, 'offline', meta.display_name, meta.avatar);
  }

  const conns = userConnections.get(meta.userId);
  if (conns) {
    conns.delete(ws);
    if (conns.size === 0) userConnections.delete(meta.userId);
  }

  clientMeta.delete(ws);
  const db = await getUserDb();
  run(db, 'UPDATE users SET status = ?, last_seen = ? WHERE id = ?', ['offline', Date.now(), meta.userId]);
}

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) {
      ws.send(JSON.stringify({ type: 'error', message: 'No token' }));
      ws.close(4001);
      return;
    }
    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
      ws.close(4001);
      return;
    }

    const db = await getUserDb();
    const user = get(db, 'SELECT id, username, display_name, avatar FROM users WHERE id = ?', [payload.sub]);
    if (!user) {
      ws.close(4001);
      return;
    }

    run(db, 'UPDATE users SET status = ?, last_seen = ? WHERE id = ?', ['online', Date.now(), user.id]);

    clientMeta.set(ws, { userId: user.id, username: user.username, display_name: user.display_name, avatar: user.avatar, rooms: new Set() });
    if (!userConnections.has(user.id)) userConnections.set(user.id, new Set());
    userConnections.get(user.id).add(ws);

    const userRooms = all(db, 'SELECT room_id FROM room_members WHERE user_id = ?', [user.id]);
    for (const row of userRooms) {
      broadcast(row.room_id, { type: 'presence_update', user_id: user.id, status: 'online', display_name: user.display_name, avatar: user.avatar });
    }

    ws.send(JSON.stringify({ type: 'connected', user: { id: user.id, username: user.username, display_name: user.display_name, avatar: user.avatar } }));

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const meta = clientMeta.get(ws);
      if (!meta) return;

      switch (msg.type) {
        case 'join_room': {
          const { room_id } = msg;
          if (!room_id) break;
          const db2 = await getUserDb();
          const isMember = get(db2, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', [room_id, meta.userId]);
          if (!isMember) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not a member' }));
            break;
          }
          joinRoom(ws, room_id);
          broadcastPresence(room_id, meta.userId, 'online', meta.display_name, meta.avatar);

          const members = all(db2, `
            SELECT u.id, u.username, u.display_name, u.avatar, u.status
            FROM room_members rm
            JOIN users u ON u.id = rm.user_id
            WHERE rm.room_id = ?
          `, [room_id]);
          ws.send(JSON.stringify({
            type: 'room_state',
            room_id,
            members: members.map(m => ({
              id: m.id,
              username: m.username,
              display_name: m.display_name,
              avatar: m.avatar || null,
              status: m.status || 'offline'
            }))
          }));

          ws.send(JSON.stringify({ type: 'joined_room', room_id }));
          break;
        }
        case 'leave_room': {
          const { room_id } = msg;
          if (room_id) leaveRoom(ws, room_id);
          break;
        }
        case 'typing': {
          const { room_id } = msg;
          if (!room_id || !meta.rooms.has(room_id)) break;
          const clients = roomClients.get(room_id);
          if (!clients) break;
          const payload = JSON.stringify({
            type: 'typing',
            user_id: meta.userId,
            username: meta.username,
            display_name: meta.display_name,
            avatar: meta.avatar,
            room_id
          });
          for (const c of clients) {
            if (c !== ws && c.readyState === WebSocket.OPEN) c.send(payload);
          }
          break;
        }
        case 'set_status': {
          const { status } = msg;
          const allowed = ['online', 'offline'];
          if (!allowed.includes(status)) break;
          const db2 = await getUserDb();
          run(db2, 'UPDATE users SET status = ?, status_updated_at = ? WHERE id = ?', [status, Date.now(), meta.userId]);
          for (const roomId of meta.rooms) {
            broadcast(roomId, { type: 'presence_update', user_id: meta.userId, status, display_name: meta.display_name, avatar: meta.avatar });
          }
          break;
        }
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        // ── Voice call signaling ──────────────────────────────────────
        // All of these just relay an opaque payload from one participant
        // to the other over their existing authenticated socket. The
        // server validates that caller and callee actually share the
        // named DM room (so a stranger can't ring an arbitrary user_id)
        // but never inspects/stores SDP or media.

        case 'call_offer': {
          const { target_user_id, room_id, call_id, sdp, ephemeral_pubkey } = msg;
          if (!target_user_id || !room_id || !call_id || !sdp || !ephemeral_pubkey) break;
          if (userActiveCall.has(meta.userId)) {
            ws.send(JSON.stringify({ type: 'call_busy', call_id, self: true }));
            break;
          }
          const db2 = await getUserDb();
          const sharedRoom = get(db2, `
            SELECT 1 FROM room_members rm1
            JOIN room_members rm2 ON rm2.room_id = rm1.room_id
            WHERE rm1.room_id = ? AND rm1.user_id = ? AND rm2.user_id = ?
          `, [room_id, meta.userId, target_user_id]);
          if (!sharedRoom) {
            ws.send(JSON.stringify({ type: 'call_error', message: 'Not in a shared conversation with that user' }));
            break;
          }
          if (userActiveCall.has(target_user_id)) {
            ws.send(JSON.stringify({ type: 'call_busy', call_id }));
            break;
          }
          activeCalls.set(call_id, { callerId: meta.userId, calleeId: target_user_id, roomId: room_id });
          userActiveCall.set(meta.userId, call_id);
          userActiveCall.set(target_user_id, call_id);
          broadcastToUser(target_user_id, {
            type: 'call_offer',
            call_id,
            room_id,
            sdp,
            ephemeral_pubkey,
            from_user_id: meta.userId,
            from_username: meta.username,
            from_display_name: meta.display_name,
            from_avatar: meta.avatar
          });
          break;
        }

        case 'call_answer': {
          const { call_id, sdp, ephemeral_pubkey } = msg;
          const call = activeCalls.get(call_id);
          if (!call || call.calleeId !== meta.userId) break;
          broadcastToUser(call.callerId, { type: 'call_answer', call_id, sdp, ephemeral_pubkey, from_user_id: meta.userId });
          break;
        }

        case 'call_ice_candidate': {
          const { call_id, candidate } = msg;
          const call = activeCalls.get(call_id);
          if (!call) break;
          const targetId = call.callerId === meta.userId ? call.calleeId : (call.calleeId === meta.userId ? call.callerId : null);
          if (!targetId) break;
          broadcastToUser(targetId, { type: 'call_ice_candidate', call_id, candidate, from_user_id: meta.userId });
          break;
        }

        case 'call_reject': {
          const { call_id } = msg;
          const call = activeCalls.get(call_id);
          if (!call || call.calleeId !== meta.userId) break;
          activeCalls.delete(call_id);
          userActiveCall.delete(call.callerId);
          userActiveCall.delete(call.calleeId);
          broadcastToUser(call.callerId, { type: 'call_reject', call_id });
          break;
        }

        case 'call_end': {
          const { call_id } = msg;
          const call = activeCalls.get(call_id);
          if (!call || (call.callerId !== meta.userId && call.calleeId !== meta.userId)) break;
          const otherId = call.callerId === meta.userId ? call.calleeId : call.callerId;
          activeCalls.delete(call_id);
          userActiveCall.delete(call.callerId);
          userActiveCall.delete(call.calleeId);
          broadcastToUser(otherId, { type: 'call_end', call_id, reason: 'hangup' });
          break;
        }
      }
    });

    ws.on('close', () => cleanupClient(ws));
    ws.on('error', () => cleanupClient(ws));
  });

  return { wss, broadcast, broadcastToUser };
}

module.exports = { setupWebSocket, broadcast, broadcastToUser };