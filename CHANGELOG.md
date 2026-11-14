# Changelog

## [0.12.2] - 2026-11-14

### Changed
- Message Requests is no longer a Friends tab. An Inbox icon in the Friends header opens a popover with Message Requests (shown only while there are incoming requests; compact Accept/Ignore rows plus "View all requests"), Mentions and Unreads. Its badge counts all three. Mentions are kept in memory for the session only and never contain message text.
- The Blocked tab is hidden unless you have blocked users, and now renders a real blocked list with Unblock (previously it showed the friends list). Blocking or unblocking from a profile refreshes it.
- Test ids `ftab-requests` / `ftab-requests-badge` became `inbox-btn` / `inbox-badge`.

### Database
- No migrations or schema changes in 0.12.2.

## [0.12.1] - 2026-11-12

### Changed
- Add Friend and Message Requests removed from the main sidebar; they are tabs inside the existing Friends page (Add Friend in green, Message Requests with a pending count). The Friends sidebar item shows the combined friend-request + message-request badge.
- Add Friend restyled: one bordered form (username + green Send Friend Request, divider, 120-character message with counter), illustration, "Other Places to Make Friends" and an Explore Discoverable Servers card. Green `#248046` is used only here.
- ESC is the default theme everywhere (missing/invalid preference, new accounts, new devices); the class is applied before first paint so Dark no longer flashes. Explicit Light/Dark/Retro choices are respected.
- Tests that looked for the old sidebar ids (`nav-requests`, `nav-requests-badge`, `nav-add-friend`) now use the Friends-page ids (`ftab-requests`, `ftab-requests-badge`); assertions otherwise unchanged.

### Added
- `tests/friends-ui-esc.test.js`.

### Database
- No migrations or schema changes in 0.12.1.

## [0.12.0] - 2026-11-10

### Added
- Friends: a dedicated **Add Friend** view (exact username, optional personal message up to 120 characters with a counter, clear success / error / already-pending states, Discover Servers card). Friend requests are also accepted by username through `POST /api/friends/request`.
- **Message Requests**: messaging a non-friend creates an end-to-end encrypted request (`/api/message-requests`) with Accept, Ignore and Deny. Ignore and Deny are distinct states. Accepting creates (or reuses) the single one-to-one DM and moves the still-encrypted message into it.
- Sidebar: Add Friend and Message Requests (with a pending badge) next to Friends; requests never appear as ordinary conversations.
- **Key pinning, safety numbers, key rotation and key history** (`/api/keys`), plus a user-initiated **Report message** flow that shows exactly what is shared.
- Real-time events: `message_request`, `message_request_sent`, `message_request_updated`, `key_changed` (sent only to the people involved).
- New migration `0.12.0-seed-key-history`; new tables `message_requests`, `key_history`; new columns `friend_requests.message`, `users.encrypted_key_history`, `users.key_history_nonce`.
- Tests: `message-requests.test.js`, `zero-access.test.js`, `keys-and-client.test.js`; `SECURITY.md`; `scripts/auditPlaintext.js`.

### Changed
- The sidebar search (`#search-inner`) only filters existing conversations (name, @username, group name) in memory.
- The New Message modal lists friends only; New Group is unchanged.
- `POST /api/rooms/dm` creates a one-to-one DM only between friends (existing DMs stay reachable).
- One-to-one DMs now require ciphertext with wrapped keys for both participants; plain-text messages, edits and unencrypted attachments are rejected (`E2EE_REQUIRED`).
- Changing an existing public key requires `POST /api/keys/rotate` with the account password; public keys must be 32 bytes.
- The key-restore prompt no longer claims the password is never sent to the server (it is sent at login; see SECURITY.md).
- Existing tests that created DMs between strangers or sent plain-text DM messages now befriend first and send real ciphertext (`befriend`, `dmBetween`, `encryptFor` in `tests/helpers.js`). Assertions are unchanged.

### Removed
- Starting arbitrary one-to-one conversations from user search.

## [0.11.0] - 2026-10-31
Earlier entries are kept in the in-app changelog (Settings → Changelogs).
