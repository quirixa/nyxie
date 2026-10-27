# Changelog

All notable changes to Nyxie. The same release notes appear in the app under
Settings → Changelogs (`public/js/settings.js`); keep the two in step.

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
