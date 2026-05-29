const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./auth');
const { getDb, get, run } = require('./db');

// Map of roomId -> Set of WebSocket clients
const roomClients = new Map();
// Map of ws -> { userId, username, display_name, rooms: Set }
const clientMeta = new Map();
// Map of userId -> Set of ws connections
const userConnections = new Map();

function broadcast(roomId, data) {
  const clients = roomClients.get(roomId);
  if (!clients) return;
  const payload = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function broadcastPresence(roomId, userId, status) {
  const clients = roomClients.get(roomId);
  if (!clients) return;
  const payload = JSON.stringify({ type: 'presence', user_id: userId, status });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
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

function cleanupClient(ws) {
  const meta = clientMeta.get(ws);
  if (!meta) return;

  // Remove from all rooms and broadcast offline presence
  for (const roomId of meta.rooms) {
    const clients = roomClients.get(roomId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) roomClients.delete(roomId);
    }
    broadcastPresence(roomId, meta.userId, 'offline');
  }

  // Remove from userConnections
  const conns = userConnections.get(meta.userId);
  if (conns) {
    conns.delete(ws);
    if (conns.size === 0) userConnections.delete(meta.userId);
  }

  clientMeta.delete(ws);
}

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    // Auth via query param: /ws?token=xxx
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    if (!token) {
      ws.send(JSON.stringify({ type: 'error', message: 'No token provided' }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    const db = await getDb();
    const user = get(db, 'SELECT id, username, display_name FROM users WHERE id = ?', [payload.sub]);
    if (!user) {
      ws.close(4001, 'User not found');
      return;
    }

    // Register client
    clientMeta.set(ws, { userId: user.id, username: user.username, display_name: user.display_name, rooms: new Set() });
    if (!userConnections.has(user.id)) userConnections.set(user.id, new Set());
    userConnections.get(user.id).add(ws);

    // Update last_seen
    run(db, 'UPDATE users SET last_seen = ? WHERE id = ?', [Date.now(), user.id]);

    ws.send(JSON.stringify({ type: 'connected', user: { id: user.id, username: user.username, display_name: user.display_name } }));

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      const meta = clientMeta.get(ws);
      if (!meta) return;

      switch (msg.type) {

        case 'join_room': {
          const { room_id } = msg;
          if (!room_id) break;
          // Verify membership
          const db2 = await getDb();
          const isMember = get(db2, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', [room_id, meta.userId]);
          if (!isMember) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not a member of this room' }));
            break;
          }
          joinRoom(ws, room_id);
          broadcastPresence(room_id, meta.userId, 'online');
          ws.send(JSON.stringify({ type: 'joined_room', room_id }));
          break;
        }

        case 'leave_room': {
          const { room_id } = msg;
          if (!room_id) break;
          leaveRoom(ws, room_id);
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
            room_id
          });
          for (const c of clients) {
            if (c !== ws && c.readyState === WebSocket.OPEN) c.send(payload);
          }
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', message: `Unknown type: ${msg.type}` }));
      }
    });

    ws.on('close', () => cleanupClient(ws));
    ws.on('error', () => cleanupClient(ws));
  });

  return { wss, broadcast };
}

module.exports = { setupWebSocket, broadcast };