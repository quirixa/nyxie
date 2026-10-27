# Nyxie

Chat, servers, marketplace and NX wallet. Node.js + Express backend, WebSocket
messaging, SQLite (via `sql.js`) storage, and a vanilla-JS single-page frontend
served from `public/`.

**Current release: 0.2.0** (Server Settings overhaul) — see [CHANGELOG.md](CHANGELOG.md).

## Requirements

- Node.js 18 or newer (`bcrypt@6` requires ≥ 18). Developed and tested on Node 22.
- npm.

## Install and run

```bash
npm install
cp .env.example .env          # then set JWT_SECRET (see below)
npm start                     # = node server/server.js  → http://localhost:3000
```

The entry point is `server/server.js`. `npm run dev` is currently identical to `npm start`.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `JWT_SECRET` | **yes** | ≥ 32 characters, not a placeholder. The server refuses to start otherwise (no fallback secret). |
| `PORT` | no | HTTP/WebSocket port, default `3000`. |
| `NYXIE_DATA_DIR` | no | Where SQLite files and uploads/avatars/banners live. Default `./data`. |
| `GROUP_MAX_MEMBERS` | no | Max members per group chat (default 50). |
| `WALLET_MAX_TRANSFER_NX`, `WALLET_MAX_DAILY_TRANSFER_NX`, `WALLET_MAX_TRANSFERS_PER_MIN` | no | Wallet limits. |
| `ENABLE_DEV_ROUTES` | no | `true` enables `/api/dev` test funding routes. Never in production. |
| `PGHOST`, `PGUSER`, `PGPASSWORD` | no | Only read by `server/database/messageDbPg.js`, which the running server does not currently use. |

Generate a secret: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

## Database

Two SQLite files are created automatically in the data directory on first start:
`nyxie_users.db` (users, servers, roles, channels, …) and `nyxie_messages.db`
(messages). `sql.js` keeps the database in memory and writes it to disk after
changes; `*.bak` copies are written next to them.

### Upgrading to 0.2.0 (migrations)

Nothing to run by hand: migrations apply automatically at startup, once each,
each inside a transaction, and are recorded in the `schema_migrations` table.
Restarting never re-applies them. Details are in the CHANGELOG ("Migration").
Before the first migration runs, a copy of the existing database is written to
`data/nyxie_users.db.pre-0.2.0.bak`. **Back up `data/` yourself before
upgrading a production install**, and try the upgrade on a copy first:

```bash
cp -r data /tmp/nyxie-data-copy
NYXIE_DATA_DIR=/tmp/nyxie-data-copy PORT=3999 JWT_SECRET=<secret> node server/server.js
```

To roll back, stop the server and restore the `.pre-0.2.0.bak` file over `nyxie_users.db`.

## Server Settings (0.2.0)

Opened from the gear button in a server's channel panel by the owner or anyone
with a management permission. Sections: Overview, Members, Roles, Channels,
Moderation, Audit Log. The panel is an overlay on the dashboard; it does not
change the URL, selected server or open channel.

All authorization is enforced by the server (`server/routes/servers.js`,
`server/routes/serverSettings.js`, `server/routes/channels.js`,
`server/services/permissions.js`). The UI hides controls as a convenience only.

### Permissions

Bitmask on each role; a member's permissions are the union of their roles.
The owner and `ADMINISTRATOR` have everything. The catalog (labels, grouping)
is served by `GET /api/servers/:id/permissions`.

`VIEW_CHANNEL` 1 · `SEND_MESSAGES` 2 · `MANAGE_CHANNELS` 4 · `MANAGE_SERVER` 8 ·
`MANAGE_MEMBERS` 16 · `CREATE_INVITES` 32 · `KICK_MEMBERS` 64 · `BAN_MEMBERS` 128 ·
`MANAGE_MESSAGES` 256 · `MANAGE_ROLES` 512 · `ADMINISTRATOR` 1024 ·
`VIEW_AUDIT_LOG` 2048 · `MODERATE_MEMBERS` (timeouts) 4096 ·
`READ_MESSAGE_HISTORY` 8192 · `ATTACH_FILES` 16384.

### Hierarchy rules

- Roles are strictly ordered (position 0 = default role; higher number = higher rank).
- You can only edit, delete, reorder, assign or remove roles **below** your highest role; the owner can touch all.
- You can only act on (kick, ban, time out, change roles/nickname of) members whose highest role is **below** yours. Nobody can act on the owner, and nobody can kick/ban/time out themselves.
- You can only put permissions on a role, or in a channel override, that you hold yourself (owner/Administrator: any). Bits you don't hold can't be changed by you.
- New roles are created at the bottom. Reordering can never move a role to or above the actor's own rank.
- Role assignment requires `MANAGE_ROLES` or `MANAGE_MEMBERS`.

### Channel permission overrides

Per channel and per role, an *allow* mask and a *deny* mask over four
permissions: View channel, Send messages, Read message history, Attach files.
Evaluation for a member (owner/Administrator skip this and keep everything):

1. Start with the union of the member's role permissions.
2. Apply the **default role's** override: `perms = (perms & ~deny) | allow`.
3. Apply the **combined overrides of the member's other roles** (all denies OR-ed, all allows OR-ed) the same way.

So an Allow from any role beats a Deny from another; any Deny beats a plain server-level grant.
These are enforced for message listing, posting, attachments, channel lists, `GET /api/rooms?server_id=`, and the WebSocket (`join_room`, typing). When access changes, live subscriptions are re-validated and dropped.

### Timeouts

`timeout_until` on the membership. While in the future the member cannot send
messages (REST) or send typing signals (WebSocket). It expires by itself.
It does **not** block reactions or editing existing messages.

### Audit log

`server_audit_log`, append-only. Written inside the same transaction as the
change, only for successful changes, with the authenticated user as actor.
Detail objects are sanitized (secret-like and content-like keys are dropped,
strings truncated). Visible to `VIEW_AUDIT_LOG` holders only. Entries are kept
until the server is deleted.

## Tests

```bash
npm test      # node --test tests/*.test.js — starts real servers on temp data dirs
npm run check # syntax check of the main files
```

| File | What it covers |
|---|---|
| `tests/server-settings.test.js` | REST + WebSocket: overview validation/persistence, icon validation, roles/hierarchy/escalation, members, kick/ban/timeout, categories/layout, channel overrides (REST + live WS), permission enforcement, audit log, server deletion |
| `tests/migration.test.js` | Upgrade of a rewound "pre-0.2.0" database: data preserved, migrations applied once, safety copy written |
| `tests/regression.test.js` | Login/registration, DMs with live delivery, server messaging, uploads, SPA shell, wallet route still guarded, JWT_SECRET enforcement, version consistency |
| `tests/ui-settings.test.js` | The real settings panel code running in **jsdom** against a live server: navigation, dirty guards, forms, dialogs, lists, error/empty states, XSS escaping |

Tests never touch `./data`; they use temporary directories via `NYXIE_DATA_DIR`.

**What is not covered:** there is no real-browser testing. The jsdom tests do not
render CSS, so layout/responsiveness of the panel is unverified, as are the
dashboard integration points in `public/js/dashboard.js` (opening the panel,
category grouping in the sidebar, live websocket event handling) — these were
checked by code review and syntax checks only. The NX wallet and other
pre-existing features were not modified apart from what `tests/regression.test.js` exercises.

## Layout

```
server/            Express app, routes/, services/, database/, websocket/, config/
public/            SPA (index.html, js/, css/)
  js/serverSettings.js, serverSettingsPanels.js, css/serverSettings.css   ← Server Settings
scripts/           CLI helpers (setRole, grantFunds, checkUser, badges)
tests/             Automated tests
```

## Known limitations

See the "Known limitations" section of [CHANGELOG.md](CHANGELOG.md) for 0.2.0.
