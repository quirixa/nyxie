# Changelog

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
