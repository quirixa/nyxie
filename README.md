# Nyxie

Chat, servers, marketplace and NX wallet. Node.js + Express backend, WebSocket
messaging, SQLite (via `sql.js`) storage, and a vanilla-JS single-page frontend
served from `public/`.

**Current release: beta 0.10.0** (long messages over 2,000 characters are sent as a message.txt attachment, with a multi-line composer and a text-file viewer; 0.10.0 added the Developer role and the Developer workspace for Feedback & Issues; 0.8.0 removed "Last seen" and tightened presence privacy; includes server ownership transfer from 0.7.0, the 0.2.0 Server Settings overhaul and 0.2.1 fixes) — see [CHANGELOG.md](CHANGELOG.md).

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
| `REPORT_REF_SECRET` | no | Key for the opaque reporter reference on reports (defaults to `JWT_SECRET`). |
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
- **Ownership transfer** is owner-only, to a current member, and needs the exact server name as confirmation. The former owner keeps the roles they hold (including the Admin role every server gives its creator) until the new owner removes them; they lose delete/transfer rights and owner protection. Recorded as `server.ownership_transfer` in the audit log.

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

## Developer workspace (Feedback & Issues)

Roles: `USER`, `DEVELOPER`, `ADMIN` (`users.role`).

- **ADMIN** is set only with `node scripts/setRole.js <user> ADMIN` (unchanged).
- **DEVELOPER** is never set by hand or by any client request: it is *derived* from the official `developer` badge. Granting/revoking that badge (Admin → Badges, or `scripts/badges.js`) updates the role in the same database transaction (`server/services/staff.js`). The server also re-derives every account on each start; run `node scripts/syncDeveloperRoles.js` to do it on demand. Both are idempotent and never touch an ADMIN.
- A developer can use the workspace and nothing else: no admin endpoints, accounts, servers, wallets or messages. Administrators can open the workspace through their own role, without the badge.
- Two explicit permissions can be granted by an admin to developers (`PUT /api/admin/staff/permissions`): `SECURITY_REPORTS` (see/handle security reports) and `REPORTER_IDENTITY` (see who sent a report). Admins have both implicitly. They stop working the moment the developer role is lost.

Users send reports from **Settings → Feedback** (bug, feature request, general feedback, security issue; optional version, platform, screenshots/text log, and diagnostics that are **off by default** and shown in full before sending). Staff work them in **Developer** in the Home navigation.

Statuses: `OPEN`, `UNDER_REVIEW`, `PLANNED`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`, `DECLINED` (transitions validated server-side; `CLOSED`/`DECLINED` can only be reopened to `OPEN`). Priorities: `LOW`, `NORMAL`, `HIGH`, `URGENT`. Nothing is ever deleted: duplicates are closed and linked.

| Endpoint | Who |
|---|---|
| `POST /api/reports`, `GET /api/reports/mine`, `POST /api/reports/mine/:n/attachments` | any signed-in user (own reports only; reporter-safe fields) |
| `GET /api/reports/attachments/:id/download` | the reporter, or staff who may see that report (checked on every request) |
| `GET /api/developer/overview`, `/staff`, `/reports`, `/reports/:n` | DEVELOPER or ADMIN; security reports only with `SECURITY_REPORTS` (otherwise 404, and excluded from lists, counts, search and metrics) |
| `PATCH /api/developer/reports/:n`, `POST …/notes`, `POST …/duplicates`, `POST …/related`, `DELETE …/relations/:other`, `PUT …/link` | same rules; `expected_version` rejects stale edits (409) |
| `GET/PUT/DELETE /api/admin/staff/permissions`, `POST /api/admin/staff/developers/sync` | ADMIN only |

Attachments live in `<data dir>/report-attachments/` under random names (never under the public `/uploads`), are validated by content (PNG/JPEG/GIF/WebP or plain text, 5 MB, 3 per report) and are only served through the authorised endpoint with `Content-Disposition: attachment` and `nosniff`.

Hosting: reports are stored in the SQLite database and attachments on disk, both under `NYXIE_DATA_DIR`. On a host with an ephemeral filesystem (many PaaS containers) mount a persistent volume there, otherwise reports and attachments disappear on redeploy, like everything else Nyxie stores. Nothing here relies on background jobs.

Privacy: a report contains only what the person typed or explicitly chose to attach. Message contents, keys, tokens, presence and browsing activity are never collected for a report. Staff see an opaque reporter reference unless they hold `REPORTER_IDENTITY`; access to security reports, attachments and identities is written to `audit_logs`. The server operator can still read everything in the database; this does not change the end-to-end encryption of messages.

## Privacy: presence and "last seen"

Nyxie does **not** record or show when a user was last online. `users.last_seen`
is deprecated (kept, always `NULL`; migration `0.8.0-clear-last-seen` clears old values).

What other users can see: your live status (Online / Idle / Do Not Disturb), going
offline when your last connection closes, and anything you do (messages and their
timestamps, typing, answering calls). Invisible shows as offline everywhere (profile,
friends, server and group member lists, room state, search, WebSocket) and produces no
presence events when you connect, disconnect, open a chat or re-select it.

What the server (operator) can still see: live connections, IPs and user agents,
session `last_active` (also shown to you, only for your own devices, in Settings →
Security; used for session expiry), the stored status preference including Invisible,
`status_updated_at` (never sent to clients), logs, message metadata. Old database
copies/backups can still contain pre-0.8.0 `last_seen` values.

This reduces what is exposed; it does not make anyone untraceable.

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
| `tests/ui-dashboard.test.js` | The real `index.html` + all frontend scripts in jsdom against a live server: member list, toggle, live updates, categories, opening Server Settings, no placeholder usernames |
| `tests/ownership.test.js` | Ownership transfer: authorization, validation, consequences for old/new owner, audit entry, live event |
| `tests/developer.test.js` | Developer role derived from the badge, workspace API authorization (users / developers / admins), security-report isolation, notes never exposed, forged fields ignored, queues (filter/search/sort/pagination), workflow + history, attachments, migration of an existing database |
| `tests/ui-developer.test.js` | Developer nav item visibility per role, workspace rendering from real data, report text escaped, Admin still works, feedback form opt-in |
| `tests/privacy.test.js` | No last-seen data in any API response/event or the database, migration clears old values, Invisible produces no presence traffic and looks offline everywhere, normal presence still works |
| `tests/long-messages.test.js` | The 2,000-character limit (code points, ciphertext bound, edits), attachment validation, permission-checked downloads of encrypted attachments (sign-in, DM/channel membership, Read Message History, Attach Files, leaving, deleting), and the real dashboard in jsdom: multi-line messages, conversion to `message.txt`, text-file card, viewer, another member decrypting it, text kept when it cannot be sent |
| `tests/ui-settings.test.js` | The real settings panel code running in **jsdom** against a live server: navigation, dirty guards, forms, dialogs, lists, error/empty states, XSS escaping |

Tests never touch `./data`; they use temporary directories via `NYXIE_DATA_DIR`.

**What is not covered:** there is no real-browser testing. The jsdom tests do not
render CSS, so layout and phone responsiveness are unverified. The NX wallet and other
pre-existing features were not modified apart from what `tests/regression.test.js` exercises.

## Layout

```
server/            Express app, routes/, services/, database/, websocket/, config/
public/            SPA (index.html, js/, css/)
  js/serverSettings.js, serverSettingsPanels.js, css/serverSettings.css   ← Server Settings
scripts/           CLI helpers (setRole, grantFunds, checkUser, badges, syncDeveloperRoles)
tests/             Automated tests
```

## Known limitations

See the "Known limitations" section of [CHANGELOG.md](CHANGELOG.md) for 0.2.0.
