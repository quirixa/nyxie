const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./auth');
const { getUserDb, get, run, all } = require('./userDb');

const roomClients = new Map();
const clientMeta = new Map();
const userConnections = new Map();

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
      payload = jwt.verify(token, JWT_SECRET);
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
      }
    });

    ws.on('close', () => cleanupClient(ws));
    ws.on('error', () => cleanupClient(ws));
  });

  return { wss, broadcast, broadcastToUser };
}

module.exports = { setupWebSocket, broadcast, broadcastToUser };