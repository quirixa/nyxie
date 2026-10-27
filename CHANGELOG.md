# Changelog

All notable changes to Nyxie. The same release notes appear in the app under
Settings → Changelogs (`public/js/settings.js`); keep the two in step.

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
