# 🌑 nyxie — self-hosted chat backend

A fully self-hosted chat backend with real-time messaging, BIP-39 seed phrase authentication, and no third-party services.

## Stack

- **Runtime**: Node.js
- **Framework**: Express
- **Database**: SQLite (via sql.js — pure JS, no native build needed)
- **Real-time**: WebSockets (ws)
- **Auth**: JWT + BIP-39 seed phrase hashing (SHA-256, never stored raw)

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

Edit `.env`:

```env
PORT=3000
JWT_SECRET=your-very-long-random-secret-here
```

Generate a strong secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 3. Add frontend files

Put your HTML files in the `public/` folder:
- `public/index.html` — landing page
- `public/login.html` — sign in
- `public/register.html` — create account
- `public/dashboard.html` — chat UI (already included)

### 4. Run

```bash
node server.js
# or for dev with auto-restart:
npx nodemon server.js
```

Open `http://localhost:3000`

---

## API Reference

### Auth

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | `{username, display_name?, seed_phrase}` | Create account |
| POST | `/api/auth/login` | `{seed_phrase, username?}` | Sign in, get JWT |
| GET | `/api/auth/me` | — | Verify token, get user |

### Rooms

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/rooms` | List rooms you're a member of |
| GET | `/api/rooms/public` | List all public channels |
| POST | `/api/rooms` | Create a channel `{name, description?}` |
| POST | `/api/rooms/:id/join` | Join a channel |
| POST | `/api/rooms/:id/leave` | Leave a channel |
| GET | `/api/rooms/:id/members` | List members |
| GET | `/api/rooms/:id/messages` | Get messages (paginated via `?before=<ts>`) |
| POST | `/api/rooms/:id/messages` | Send a message `{content}` |
| PATCH | `/api/rooms/:roomId/messages/:msgId` | Edit your message |
| DELETE | `/api/rooms/:roomId/messages/:msgId` | Delete your message |
| POST | `/api/rooms/dm` | Open/get DM room `{target_user_id}` |

### Users

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users/search?q=` | Search users |
| GET | `/api/users/:id` | Get user profile |
| PATCH | `/api/users/me` | Update display name |

All routes (except `/api/auth/*`) require `Authorization: Bearer <token>`.

---

## WebSocket API

Connect: `ws://localhost:3000/ws?token=<jwt>`

### Client → Server

```json
{ "type": "join_room", "room_id": "..." }
{ "type": "leave_room", "room_id": "..." }
{ "type": "typing", "room_id": "..." }
{ "type": "ping" }
```

### Server → Client

```json
{ "type": "connected", "user": {...} }
{ "type": "joined_room", "room_id": "..." }
{ "type": "new_message", "message": {...} }
{ "type": "message_edited", "message_id": "...", "content": "...", "edited_at": 0 }
{ "type": "message_deleted", "message_id": "..." }
{ "type": "typing", "user_id": "...", "username": "...", "display_name": "...", "room_id": "..." }
{ "type": "presence", "user_id": "...", "status": "online|offline" }
{ "type": "pong" }
```

---

## Production Deployment

### With nginx (recommended)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### With systemd

```ini
[Unit]
Description=nyxie chat server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/path/to/nyxie
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### With PM2

```bash
npm install -g pm2
pm2 start server.js --name nyxie
pm2 save
pm2 startup
```

---

## Auth Design

nyxie uses **BIP-39 seed phrases** as passwords. The seed is:

1. Normalized (lowercase, trimmed, single spaces)
2. Hashed: `SHA-256("nyxie:" + normalized_seed)`  
3. The hash is stored in the DB — the raw seed never touches the server

Users authenticate by providing their seed phrase (and optionally username). The seed is cleared from memory immediately after hashing.

---

## File Structure

```
nyxie/
├── server.js          # Main entry point
├── .env               # Config (JWT secret, port)
├── data/
│   └── nyxie.db       # SQLite database (auto-created)
├── public/            # Static frontend files
│   ├── index.html
│   ├── login.html
│   ├── register.html
│   └── dashboard.html
└── src/
    ├── auth.js        # Register/login routes + JWT
    ├── db.js          # SQLite (sql.js) database layer
    ├── middleware.js  # Auth middleware
    ├── rooms.js       # Rooms + messages REST API
    ├── users.js       # User routes
    └── websocket.js   # WebSocket server (real-time)
```