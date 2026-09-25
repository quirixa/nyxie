# Nyxie

Nyxie is a Discord-style chat application with E2EE messaging, voice messages/calls, servers, group chats, an NX wallet, and marketplace features.

## Requirements

- Node.js 18+
- npm

## Setup

```bash
cp .env.example .env
npm install
npm start
```

The default server listens on `http://localhost:3000`.

For development:

```bash
npm run dev
```

## Environment

`JWT_SECRET` must be a long random secret. Do not commit `.env` or production secrets.

The app uses the local sql.js databases by default. PostgreSQL support is retained in the project for deployments that wire it in.

## E2EE

- New DM/group text messages use a random per-message key.
- The message key is wrapped separately for each current room member using their public encryption key.
- Group messages do not accept a plaintext fallback.
- Voice messages use the same per-message wrapped-key model, with legacy 1-to-1 voice decryption retained for older messages.
- Attachments are encrypted in the browser before `/api/upload` receives them. The server stores only ciphertext for new encrypted attachments.
- Older messages/attachments created by previous builds remain readable through their legacy format where supported.

## Notes

- New group members cannot decrypt historical E2EE messages/attachments that were created before they joined unless a future key-rotation/rekey workflow is added.
- Removing a member does not retroactively erase ciphertext or keys that member already received on their device; this is normal for a client-side E2EE history model.
