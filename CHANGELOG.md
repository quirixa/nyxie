# Changelog

All notable changes to Nyxie. The same release notes appear in the app under
Settings → Changelogs (`public/js/settings.js`); keep the two in step.

## [0.10.0] - 2026-10-31

### Added
- **Long messages become a `message.txt` attachment.** The limit is exactly **2,000 characters** (Unicode code points, so an emoji counts as one). A message of 2,000 characters or fewer is sent as normal text. A message of 2,001 or more is sent, complete and unchanged, as an attached `message.txt` instead of text. Nothing is cut: the file contains exactly what was typed (line breaks, spacing and indentation included). If the conversion is impossible (the file would exceed the 10 MB upload limit, all 10 attachment slots are taken, the upload fails, or the room does not allow attachments) the text goes back into the message box and nothing is sent.
- **Text-file attachments** (`message.txt` and any other `.txt`) are shown as a compact card in the existing dark style: file icon, file name, file size, a short preview of the first lines, an **Open** button and a **Download** button. **Open** shows the whole file in a readable viewer (monospace, wrapped, scrollable, with Copy and Download, closes with Escape or a click outside). On phones the viewer fills the screen.
- **Multi-line message box.** The message box is now a growing text area. **Shift+Enter** inserts a line break and **Enter** sends. On touch devices Enter inserts a line break and the send button sends. Pasted multi-line text keeps its line breaks (the old single-line box removed them, which is what produced one long wall of text).
- Shared limits module `server/config/limits.js`.

### Changed
- Messages keep their line breaks, blank lines and spacing when displayed (this was already how messages were drawn; the new message box is what lets you create them).
- The server's message length check now matches the 2,000-character rule. Encrypted text is bounded by the largest ciphertext 2,000 characters can produce (10,688 base64 characters); before, a flat 4,000 characters of ciphertext rejected some messages well under 2,000 characters when they contained non-Latin text or emoji. Unencrypted text and edits use the same 2,000-character rule. Edited messages can be at most 2,000 characters (they cannot become attachments).
- Attachments are validated when a message is posted: the file must be one this server stored and must still exist, the stored size of an encrypted attachment is taken from the file itself instead of the client's number, and file names are cleaned of control characters and path separators. An invalid attachment now returns 400 instead of being silently dropped.

### Security
- **Encrypted attachments are no longer downloadable by anyone with the link.** `/uploads/<name>.nx` now requires a signed-in session, and the user must currently be able to view and read the history of a room that has a message with that file. Everything else (not signed in, not in the room, lost access to the channel, message deleted, unknown file) answers the same 404. Files are still end-to-end encrypted in the browser; this only stops other people from fetching the encrypted bytes.

### Known limitations
- The server cannot read encrypted text, so the exact 2,000-character rule is applied by the app; the server enforces a ciphertext size bound that no message of 2,000 characters can exceed.
- Files uploaded before this version (plain, not `.nx`) are still served as before, without a sign-in check, because images and media tags cannot send a login header.
- Members who join a room later cannot read earlier attachments (each file's key is wrapped only for the people in the room when it was sent), the same as for every encrypted attachment.
- Open shows a file in one piece; a `.txt` file near the 10 MB limit can take a moment to appear.
- Not checked in a real browser: the UI was exercised in jsdom (no layout or CSS rendering).

## [0.10.0] - 2026-10-31

### Added
- **Developer role.** `users.role` gains `DEVELOPER`. It is derived from the official `developer` badge by one shared service (`server/services/staff.js`): granting or revoking the badge updates the role in the same transaction, the server re-derives all roles on every start, and `node scripts/syncDeveloperRoles.js` does it on demand. It is idempotent and never changes an `ADMIN`. Nothing a client sends (profile fields, headers, local storage, the badge shown in the UI) can grant it.
- **Developer navigation item** in the Home navigation, right after Admin, for developers and administrators only, opening the new workspace at `/developer`. Regular users never see it, never receive its data, and the `/developer` URL sends them back to the app. Administrators get access through their own role, not the badge, and developers do **not** get Admin.
- **Developer workspace (Feedback & Issues).**
  - Overview with metrics computed from the database (total, open, awaiting review, in progress, resolved in a chosen period, needs attention, by category, recent) and honest empty states.
  - Queues for All, Bug, Feature requests, General feedback and Security, with search by ID or title, filters (status, priority, assignee), sorting (newest, oldest, priority, recently updated), pagination, per-queue counts, and loading/empty/error states.
  - Report details: description, category, priority, status, opaque reporter reference, timestamps, app version and platform, opted-in diagnostics, attachments, assignee, related/duplicate reports, development link, internal notes and a full activity history with actor and time.
  - Real actions: change status (transitions validated on the server) and priority, assign to a developer or administrator, add internal notes, link duplicates and related reports (duplicates are closed, never deleted), attach an `https://` issue/pull-request link. Stale edits are rejected with 409.
  - Statuses: `OPEN`, `UNDER_REVIEW`, `PLANNED`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`, `DECLINED`.
- **Report submission** in Settings → Feedback: bug report, feature request, general feedback or security issue, with title, description, optional app version and platform, optional screenshots / text log (up to 3 files, 5 MB each) and a confirmation with the report ID (`NYX-<n>`). Reporters see the status of their own reports only.
- **Security reports** are restricted: invisible (404, and excluded from lists, counts, search and metrics) to developers unless an administrator grants `SECURITY_REPORTS`. A second explicit permission, `REPORTER_IDENTITY`, controls who can see who sent a report. Views, updates, notes and attachment downloads of security reports, and identity lookups, are written to `audit_logs`.
- `/api/reports` (users), `/api/developer` (staff), `/api/admin/staff` (administrators); see the README.
- New tables `reports`, `report_events`, `report_attachments`, `report_relations`, `staff_permissions` (all `CREATE TABLE IF NOT EXISTS`).
- Optional `REPORT_REF_SECRET` (defaults to `JWT_SECRET`).

### Changed
- **Feedback is now stored as reports.** Migration `0.10.0-feedback-to-reports` copies existing `user_feedback` rows into `reports` (bug → Bug, idea → Feature request, other → General), once and without duplicates; the old table is left untouched. `POST/GET /api/account/feedback` still work and use the same store and rules.
- **Diagnostics are opt-in.** The Feedback form used to have diagnostics ticked and sent the full browser user-agent string. They are now off by default, show the exact text before sending, and contain only the browser name, screen size, language and theme.
- Migration `0.10.0-sync-developer-roles` brings existing databases in line with the developer badge.
- `scripts/setRole.js` explains that `DEVELOPER` follows the badge, and demoting an admin who still holds the badge leaves them a developer.
- Test helper stops a leftover test server with `SIGKILL` after 4 s so a lingering test connection cannot hang the test run.

### Security
- Every `/api/developer` route runs behind `requireAuth` + a server-side role check and object-level checks; there is no developer data on WebSocket messages. Report attachments are stored outside `/uploads` under random names, validated by content, and authorised on every download.
- Report and note text is stored as plain text (control and bidi-override characters removed) and escaped on render. Reporters cannot set status, priority, assignee, notes or links; those fields in a submission are ignored. Submissions are rate limited per IP and per user.

### Known limitations
- A role change (badge granted or revoked) applies to API calls immediately, but an already-open page only updates its navigation after a reload.
- Security-report permissions are managed through the admin API only (no UI yet). There is no export endpoint.
- No GitHub integration: links are entered manually and are not verified.
- The server operator and administrators can read everything stored in the database, including reports and attachments; reports are not end-to-end encrypted.
- Not checked in a real browser: the UI was exercised in jsdom (no layout or CSS rendering).

## [0.8.0] - 2026-10-28

### Removed
- **"Last seen" is gone everywhere.** Nyxie no longer records, stores or shows when a user was last connected.
  - The DM header no longer shows "last seen 5m ago" for offline users; it shows "Offline" (and `public/js/dashboard.js` no longer contains the formatter at all).
  - `last_seen` is no longer returned by `GET /api/users/:id`, `GET /api/users/search`, `GET /api/auth/me`, `GET /api/friends`, or the `friend_accepted` WebSocket payload.
  - `users.last_seen` is no longer written on registration, login, WebSocket connect or disconnect. The column is kept (so existing databases and tools still work) but is always `NULL`; migration `0.8.0-clear-last-seen` wipes values stored by earlier versions, once.

### Fixed (presence privacy)
- **Invisible users no longer emit presence events.** Connecting, reconnecting, opening a conversation, disconnecting, or re-selecting Invisible used to broadcast an `offline` `presence_update`, which told watchers exactly when a "hidden" user came or went. These now send nothing. Switching *to* Invisible still sends one `offline` so others' views update.
- **Stale presence with several tabs/devices.** Status changes (and the REST fallback) only reached the rooms joined by one of the user's sockets, so another room could keep showing the old status (for example "Online" after switching to Invisible). They now reach every room the user has joined.
- **Stale "Online" after disconnect.** When a user's last socket closed, only that socket's rooms were told "offline". All of the user's rooms are now notified, and no stale "offline" is sent if the user reconnected meanwhile.
- `PATCH /api/auth/status` (a second status endpoint) saved the status but never notified anyone; it now broadcasts like `PATCH /api/users/status`.
- A call to an Invisible user who is already on a call no longer answers `call_busy` (which revealed they were online); it behaves like calling an offline user.

### Kept
- Online / Idle / Do Not Disturb / Invisible work as before, including the masking rules in `server/services/presence.js`.
- Session `last_active` (Settings → Security, only your own devices; also used for session expiry), `status_updated_at` (never returned by any endpoint), message timestamps, audit and rate-limit data are unchanged.

### Added
- `tests/privacy.test.js`: no last-seen fields in any user-facing response or event, `last_seen` never written to the database, the migration clears old values, Invisible users produce no presence traffic and look offline in every endpoint, and normal presence still works.

### Known limitations (what others and the server can still observe)
- Other users still see your live status (Online, Idle, Do Not Disturb) and see you go offline when your last connection drops. This is real-time presence, not history.
- Anything you *do* is visible to the people it reaches, even when Invisible: sending a message (and its timestamp), typing in a room, editing, answering a call. Calling an Invisible user who is connected still rings them.
- Someone watching an account can still infer activity from the above. Hiding the timestamp does **not** make anyone untraceable.
- The server operator can still see who is connected, IP addresses and user agents, session `last_active`, the stored status preference (including Invisible), logs, and message metadata.
- Database copies made before upgrading (backups, snapshots, `nyxie_users.db.pre-0.2.0.bak`) can still contain old `last_seen` values; delete them if that matters.
- Not checked in a real browser (see 0.2.1); the UI change was exercised in jsdom only.

## [0.7.0] - 2026-10-28

### Added
- **Server ownership transfer.** `POST /api/servers/:serverId/transfer-ownership` with `{ user_id, confirm_name }`, and a "Make owner" button on each other member's row in Server Settings → Members (Overview's danger zone points to it).
  - Only the current owner may transfer, only to a current member (never yourself, a banned user, or a non-member), and `confirm_name` must equal the server's exact name. All enforced on the server.
  - The ownership change, lifting any timeout the new owner had, and the audit entry happen in one transaction; a lost race (ownership changed meanwhile) aborts without an audit record and returns `409`.
  - New audit action `server.ownership_transfer` ("Ownership transferred").
  - New WebSocket event `server_ownership_changed`; the dashboard refreshes permissions, the settings button and the owner crown live, and an open Server Settings panel closes itself if the former owner has nothing left to manage.
  - The members endpoint reports `actions.can_transfer` (true only for the owner, never for themselves).
- `tests/ownership.test.js` (backend), plus UI and live-dashboard tests for the flow.

### Notes
- The former owner **keeps the roles they hold**. Servers give their creator the Admin role, so they remain an Administrator until the new owner removes it. They lose only the owner-only powers (delete the server, transfer it, protection from kick/ban/timeout).
- The owner still cannot leave a server; they must transfer it (or delete it) first. The former owner can leave afterwards.

### Known limitations
- No undo: only the new owner can transfer it back.
- Deleting an account that owns a server does not hand the server on and leaves it without a valid owner (present since the original beta, unchanged). Transfer ownership before deleting an account.

## [0.6.0] - 2026-10-27

Versioned as beta 0.6.0. Contains all the changes listed under 0.2.1 and 0.2.0 below (those entries are kept as history).

### Fixed
- Removed the remaining static placeholder usernames from the interface, including the wallet "Receive" dialog (a one-line text change in `public/index.html`; the dialog is still filled from the API in `public/js/wallet.js`, which is unchanged). Usernames are now only ever rendered from account/API data.

### Added
- A regression test that scans the whole project for sample/placeholder usernames and static `@username` text.

### Known limitations
- The "Discover themes" button in Appearance opens a placeholder link (`example.com/themes`); there is no theme gallery.
- Input hint text such as `you@example.com` in the email fields is standard placeholder hinting, not account data, and was left as is.
- Not checked in a real browser (see 0.2.1).

## [0.2.1] - 2026-10-26

Fix release for 0.2.0.

### Fixed
- `toggleMemberList is not defined` / `loadChannelMemberList is not defined`: 0.2.0 deleted the right-hand member list (`loadChannelMemberList`, `toggleMemberList` and their helpers) from `public/js/dashboard.js` while replacing the old server-settings popup. They are restored unchanged from 0.1.0.
- Seven dashboard functions (`loadServers`, `renderServerRail`, `loadServerChannels`, `loadServerRoles`, `selectServer`, `showDMView`, `renderChannelList`) were defined twice after the 0.2.0 edit; the stale second copies silently overrode the new ones, so the sidebar did not group channels by category and Administrators did not get the Server Settings button. The duplicates are removed.
- Static placeholder usernames that could display instead of real data: in the chat header, the user panel and the Account settings field. They now stay empty until the real value is set from the API.
- Revealing the email in Account settings showed `user@example.com` when the account had no email; it now shows `—`.
- The Friends "Refresh" button (`loadFriendsData`/`renderFriendsList`) and the mobile "Settings" back button (`showSettingsList`) referenced functions that were never exported to `window` (present since 0.1.0).

### Added
- `tests/ui-dashboard.test.js`: boots the real `index.html` and every `public/js` file in jsdom against a live server and checks the member list (real usernames only, toggle in wide and narrow layouts), live updates (role change, kick, rejoin), category grouping and live channel hiding, opening Server Settings from the dashboard, and the handlers above.
- Static guards in `tests/regression.test.js`: no function defined twice in a frontend closure; every `window.x = x` export refers to a real function.
- Dev dependencies `tweetnacl` and `tweetnacl-util` (served to the jsdom page in place of the CDN copies).

### Known limitations
- The "Discover themes" button in Appearance opens a placeholder link (`example.com/themes`); there is no theme gallery.
- The dashboard and Server Settings were exercised in jsdom (a DOM simulation) only; layout, CSS and phone responsiveness have not been checked in a real browser. jsdom does not attach inline `onclick` attributes on elements cloned from a `<template>`, so for those buttons the tests execute the button's own `onclick` code.

## [0.2.0] - 2026-10-24

Server Settings overhaul.

### Added
- A full-screen Server Settings panel with six sections: Overview, Members, Roles, Channels, Moderation and Audit Log.
- **Overview:** edit the server name, description, icon, discovery category and Discover visibility; manage invite links (create with expiry/use limit, copy, revoke); leave the server, or delete it (owner only, requires typing the server name — enforced by the server).
- **Members:** searchable, paginated member list with role filter; edit roles, view the profile popout, time out, kick or ban with an optional reason.
- **Roles:** create, rename, recolour, reorder and delete roles; permissions grouped by category; member count per role; "show members separately" option.
- **Channels:** create, rename, set topic, reorder, move between categories and delete text channels; create, rename, reorder and delete categories; per-role channel permission overrides.
- **Moderation:** ban a member, searchable ban list with unban, active timeouts list.
- **Audit Log:** persistent, append-only record of administrative actions with filters (action, moderator, text, date range) and pagination.
- New permissions: `VIEW_AUDIT_LOG`, `MODERATE_MEMBERS` (timeouts), `READ_MESSAGE_HISTORY`, `ATTACH_FILES`.
- Member timeouts (1 minute – 28 days) that block sending messages and typing signals.
- `NYXIE_DATA_DIR` environment variable to relocate all on-disk data.
- Automated test suite (`npm test`), `package.json`, `.env.example`, README.

### Improved
- The channel list in a server groups channels under their categories.
- Open Server Settings panels and channel lists update live when another admin changes something.
- Unsaved changes are guarded when switching sections or closing the panel.
- Permission checks no longer rewrite the database on every request when nothing is missing.

### Security
- All settings actions are authorised on the server, including role hierarchy (act only on members and roles ranked below your highest role) and a "cannot grant what you don't hold" rule for role permissions and channel overrides.
- Per-channel View/Send/History/Attach permissions are enforced in the REST message endpoints and on the WebSocket (`join_room`, typing). Live subscriptions are re-validated whenever access changes (kick, ban, role or override change).
- Hidden channels are omitted from channel lists and previews.
- Audit entries are written in the same transaction as the change, use the authenticated user as actor, are only written for successful actions, and never store message content or secrets.
- Server icons are validated by extension, magic bytes and size.

### Fixed
- A kicked, banned or departed member kept their role assignments and got them back on rejoining (e.g. a kicked Admin became Admin again).
- Administrators who were not the owner could not see the Server Settings button (only the Manage Server bit was checked).
- Roles created by an Administrator who was not the owner silently lost permissions that Administrator did not hold individually (e.g. Kick Members).
- A server-update broadcast cleared the owner's `is_owner` state in the open app until reload.
- Kicked or banned members' open connections kept receiving the server's live messages.
- Deleting a server left its role assignments behind.

### Migration
Runs automatically at startup, once, inside a transaction each, and is recorded in `schema_migrations`:
- adds `server_roles.color`, `server_members.timeout_until`, `rooms.category_id`;
- adds tables `server_categories`, `channel_permission_overrides`, `server_audit_log`, `schema_migrations`;
- `0.2.0-permission-backfill` — gives existing roles the new permission bits that preserve what they could already do;
- `0.2.0-role-positions` — renumbers roles to unique positions (ties broken older-first; order otherwise unchanged);
- `0.2.0-orphan-member-roles` — removes role assignments of people who are no longer members.

A copy of the database is written once to `nyxie_users.db.pre-0.2.0.bak` before the first migration runs.

### Known limitations
- Text channels only; no voice channels, no ownership transfer.
- Timeouts stop sending and typing; they do not stop reactions or editing existing messages.
- Channel overrides cover View channel, Send messages, Read message history and Attach files only.
- No "embed links" permission and no automated spam filtering: neither can be enforced in Nyxie today.
- Role assignment requires Manage Roles **or** Manage Members (unchanged from 0.1.0, where Manage Members was required).
- Server Settings is an overlay and is not part of the URL; the browser Back button closes it.
- Audit entries are kept indefinitely; there is no export or retention setting.
- The dashboard integration of Server Settings (category grouping in the channel list, live refresh events) and the panel’s layout on desktop and mobile were not verified in a real browser; the panel’s logic was tested in a simulated DOM only.
- Because the audit log is written in the same transaction as the change, a failure to write it aborts the change (the action returns an error).

## [0.1.0]
Initial versioned state of the uploaded project (direct messages, groups, servers with channels/roles/invites, E2EE messaging, NX wallet, marketplace, themes).
