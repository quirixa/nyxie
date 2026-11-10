# Nyxie privacy and security model (0.12.0)

This document says what is protected, by what, and what is **not**. Nothing here is a promise beyond what the code does; where a limit exists it is stated.

## 1. What is end-to-end encrypted

| Content | E2EE? | Enforced by the server? |
|---|---|---|
| One-to-one DM text, edits, replies, voice messages | Yes | Yes — plaintext `content`, or ciphertext without a wrapped key for both people, is rejected (`E2EE_REQUIRED`). |
| Group DM text | Yes | Yes (since before 0.12.0). |
| Message requests (initial message) | Yes | Yes — must be ciphertext with a wrapped key for exactly the sender and the recipient. |
| Files, images, videos in DMs and groups | Yes (encrypted in the browser before upload) | Yes — an unencrypted attachment in a DM/group is rejected. |
| **Server channels** (text, files) | **No** | n/a |
| **Voice and video calls** (live media) | **Not audited or changed in 0.12.0** | n/a |

**Server channels are not end-to-end encrypted.** Roles, permissions, moderation, audit logs, search and history all rely on the server reading channel messages. Making them E2EE needs a group-key protocol designed for changing membership (for example MLS) and would remove server-side moderation of those channels. That is a separate project, so it was not attempted. Treat server channels as readable by the server operator.

**Live calls:** WebRTC encrypts transport hop-by-hop (DTLS-SRTP). Whether the media is end-to-end encrypted depends on the call architecture in `voice.js`, which was not changed or verified here. Do not describe calls as E2EE until that is done and tested.

## 2. Cryptography actually used

- tweetnacl (audited NaCl implementation): each message gets a random 32-byte key, the text is sealed with `secretbox` (XSalsa20-Poly1305, authenticated), and that key is wrapped separately for every participant using `box.before` (X25519) + `secretbox`.
- Randomness: `nacl.randomBytes` (the browser's CSPRNG). No custom algorithms.
- Each account has **one long-term identity key pair**. Private keys are generated in the browser and stored in `localStorage`. A backup, encrypted in the browser with PBKDF2-SHA256 (210,000 iterations) of your account password, is stored on the server so a new device can restore it.

### Limits you should know about
1. **No forward secrecy and no per-message ratchet.** The identity key is static. If a private key leaks, every message ever encrypted to that key (and to retired keys you still hold) can be read by whoever also has the ciphertext. This is weaker than Signal-style protocols.
2. **No per-device keys.** All your devices share one account key. Revoking a login session does not revoke the key; **key rotation** does. Rotating makes new messages unreadable with the old key, but the old key can still read old messages.
3. **The password reaches the server at login**, and the key backup is wrapped with a key derived from that same password. A server operator who modifies the server, captures passwords at login, **and** has the database could unwrap the backup. A weak password also makes the backup vulnerable to offline guessing by anyone holding the database. This is the largest gap against the "even the developer cannot read" goal. The fix (a recovery key or separate passphrase the server never sees, and a login scheme that does not send the password) is a change to authentication and is not in 0.12.0.
4. **The app is delivered by the server.** In a browser, whoever controls the server can ship altered JavaScript that reads keys or plaintext from your device. End-to-end encryption in a web app protects against passive and database-level access, not against an operator who actively serves malicious code. Native or signed-bundle clients are the usual mitigation.
5. **Key substitution.** The server distributes public keys. Mitigations in 0.12.0: each device pins the first key it sees for a contact and refuses to encrypt to a changed key until you review it; you can compare a 60-digit safety number out-of-band; changing a key needs password-confirmed rotation and is recorded in a public-key history that contacts are notified about. The first contact is trust-on-first-use unless you verify the safety number.
6. Legacy data: DMs sent before 0.12.0 may be stored as plaintext. The server cannot encrypt them (it has no keys). `npm run audit:plaintext` reports how many exist (counts only).

## 3. Who can see what

**The server process** sees: account records; the friend graph and blocks; which two users share a DM and which users are in a group; message and request **timestamps and sizes**; attachment sizes; request status (pending / ignored / denied / accepted / cancelled) and timestamps; public keys and key history; your password-wrapped key backup (opaque). It does **not** see message text, file contents, or private keys.

**Administrators and moderators** can manage accounts, servers, roles, reports and badges. No admin or developer route reads private messages; the tests verify the API refuses them (403) and that no module outside the conversation routes touches the message table. They see only what a user deliberately submits in a report.

**The developer / owner** has no master key, no escrow, no decryption code, and no plaintext logging in the server. The developer **does** control the code that is served and the machine it runs on, so limits 3 and 4 above apply to the developer as to any operator.

**Someone with a copy of the database or backups** gets ciphertext and metadata (above). Message text is not recoverable without a user's private key, except by guessing the password of an account whose backup they hold (limit 3).

**Someone who compromises the running server** can read all metadata, can observe passwords at login, and can serve malicious code (limits 3 and 4). They cannot decrypt stored messages from the database alone.

**Someone who compromises a user's device or session** gets that user's private key from `localStorage` and can read that user's messages. A stolen session token alone cannot change the user's key (rotation needs the password) but can send messages as the user.

## 4. Metadata minimisation

- Presence is optional (Invisible). There is no last-seen tracking. Typing indicators are relayed live over the socket and not stored. No read receipts are stored server-side.
- A message request that is denied, cancelled or accepted has its encrypted payload **erased** from its own row; only who, when and status remain (needed for duplicate prevention and the 7-day re-request cooldown). Blocking someone erases open requests between you.
- The application writes no per-request access log and does not log message or request bodies (tested). Your reverse proxy or host may keep IP and request logs — configure those yourself; this cannot be controlled from the app.
- What cannot be hidden without breaking delivery: sender and recipient IDs, room membership, timing and sizes. These stay readable by the server.

## 5. Message requests

A request is **not** a DM: no room exists, so the sender has no access to the recipient's DM inbox and cannot send follow-ups (one open request per recipient, enforced by a unique database index). Ignore keeps it open and invisible; the sender still sees "pending" and learns nothing. Deny ends it. Accept creates or reuses the single DM and copies the same ciphertext into it — the server never decrypts. Requests and their events are delivered only to the two people involved.

## 6. Reporting without breaking E2EE

"Report message" decrypts the message on your device, shows exactly what will be sent, and submits it through the normal reports system only when you press send. Administrators cannot browse conversations; they see only submitted reports.

## 7. Database changes (all additive, existing data kept)

- `message_requests` (new): id, sender, recipient, status, ciphertext, nonce, key_envelopes, sender/recipient public keys, room_id, created/updated/accepted/ignored/denied timestamps. Unique partial index on `(sender_id, recipient_id)` where status is pending or ignored.
- `key_history` (new): public keys only, with `retired_at` and reason. Seeded from current keys by migration `0.12.0-seed-key-history`.
- `friend_requests.message` (new column) with a unique partial index on pending requests (skipped with a warning if legacy duplicates exist).
- `users.encrypted_key_history`, `users.key_history_nonce` (new columns): retired private keys, encrypted in the browser.
- No table or column is dropped or rewritten. `CREATE ... IF NOT EXISTS` and guarded `ALTER TABLE` make start-up safe on existing databases.

## 8. One legitimate server-side decryption

`server/services/totp.js` encrypts two-factor-authentication secrets with a server-held key (AES-256-GCM). This is a login feature unrelated to messages; the security tests allow decryption in that file only.
