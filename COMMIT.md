## Summary of Changes

### 1. Authentication – Seed → Email + Password
- Database: Removed `seed_hash`, added `email` and `password_hash` columns.
- Backend (`auth.js`):
  - Registration uses `username`, `email`, `password`, and optional `display_name`.
  - Login accepts `username` or `email` + `password`.
  - Password hashing with `bcrypt`.
- Frontend (`login.html`, `register.html`):
  - Login: email/username + password.
  - Register: username, email, password, confirm password, optional display name.
- Removed: `hashSeed` function, seed phrase validation, all seed-related logic.

---

### 2. Removed `uuid` Dependency
- Replaced `uuidv4()` with Node.js built‑in `crypto.randomUUID()`.
- Removed `uuid` from `package.json`.
- Updated files: `auth.js`, `friends.js`, `rooms.js`, `servers.js`.

---

### 3. Statuses – Only Online / Offline
- Backend (`auth.js`, `users.js`, `websocket.js`):
  - Allowed statuses restricted to `['online', 'offline']`.
  - Removed `idle`, `dnd`.
- Frontend (`dashboard.html`):
  - Status menu shows only "Online" and "Invisible" (offline).
  - `setStatus()` only accepts `'online'` or `'offline'`.

---

### 4. Profile Picture (Avatar) Support
- Database: Added `avatar` column to `users` table.
- Backend (`users.js`):
  - New route `POST /api/users/avatar` using `multer` for file upload.
  - Avatars stored in `data/avatars/` and served from `/avatars/`.
  - Limits: 5MB, allowed formats: JPG, PNG, GIF, WebP.
- Server (`server.js`):
  - Added static route: `app.use('/avatars', express.static(...))`.
- Frontend (`dashboard.html`):
  - Avatar upload via Edit Profile modal.
  - Avatars displayed in sidebar, profile popout, DM list, and friend list.

---

### 5. Bio Support
- Database: Added `bio` column to `users` table.
- Backend (`users.js`):
  - `PATCH /api/users/me` now accepts `bio` field.
  - Bio length limit: 500 characters.
- Frontend (`dashboard.html`):
  - Bio displayed in profile popout.
  - Bio editable in Edit Profile modal.

---

### 6. Full Profile Editing (Modal)
- Backend (`users.js`):
  - `PATCH /api/users/me` accepts `username`, `display_name`, `bio`, `current_password`, `new_password`.
  - Password change requires verification of current password.
- Frontend (`dashboard.html`):
  - New Edit Profile modal with:
    - Username field.
    - Display name field.
    - Bio textarea.
    - Avatar upload with preview.
    - Password change section (current + new + confirm).
  - Removed inline edit from popout – now opens modal.

---

### 7. Message UI Overhaul (Discord-style)
- No avatars in messages – clean text layout.
- Author names are clickable – open user profile popout.
- Compact mode: Consecutive messages from the same user show only the message text, with a timestamp on hover (no repeated name/avatar).
- Date dividers: e.g., "Today", "Yesterday", "March 15, 2025".
- Hover actions: Edit and Delete buttons appear on hover (only for your own messages).
- Edited indicator: Shows `(edited)` next to edited messages.
- Delete: Soft‑delete – message text replaced with "[deleted]" (non‑recoverable).

---

### 8. User Profile Popout (View Others)
- No blur, no overlay – clean floating card.
- Positioned next to the clicked author name (below if space, else above).
- Shows: Avatar, display name, username, bio, status (online/offline).
- Buttons: Close, Message (opens DM with that user).
- Closes when clicking outside or pressing Close.

---

### 9. Self‑Profile Popout
- Positioned at bottom‑left (same as before).
- Shows: Avatar, display name, username, bio.
- Actions: Edit Profile, Status (Online/Invisible), Copy User ID, Log Out.

---

### 10. General Fixes
- Avatar caching – added `?t=Date.now()` to force reload after upload.
- WebSocket presence: User status updates broadcast to all rooms.
- Friend status: Reflects online/offline in friend list.
- DM list: Shows last message, timestamp, unread badge, and status pip.

---

## Files Modified

| File | Changes |
|------|---------|
| `server.js` | Added avatar static route. |
| `src/userDb.js` | Added `email`, `password_hash`, `avatar`, `bio` columns. |
| `src/auth.js` | Replaced seed with email/password auth. |
| `src/users.js` | Added avatar upload, bio, full profile update. |
| `src/friends.js` | Replaced `uuid` with `crypto.randomUUID()`. |
| `src/rooms.js` | Replaced `uuid` with `crypto.randomUUID()`. |
| `src/servers.js` | Replaced `uuid` with `crypto.randomUUID()`. |
| `src/websocket.js` | Status restricted to online/offline, added avatar to presence. |
| `public/login.html` | Email/username + password login. |
| `public/register.html` | Email + password registration (no seed). |
| `public/dashboard.html` | Complete overhaul: Discord-style messages, profile popouts, avatar, bio, edit modal. |
| `public/index.html` | Unchanged (landing page). |

---

## New Database Columns

| Table | Column | Type | Description |
|-------|--------|------|-------------|
| `users` | `email` | TEXT UNIQUE | User email address. |
| `users` | `password_hash` | TEXT | Bcrypt‑hashed password. |
| `users` | `avatar` | TEXT | Path to avatar image (e.g., `/avatars/xxx.jpg`). |
| `users` | `bio` | TEXT | User bio (max 500 chars). |

---

## New Dependencies

```bash
npm install bcrypt multer      # Added
npm uninstall uuid             # Removed
```

---

## Final State

- Authentication: Email + password.
- Profiles: Avatar, bio, display name, username (editable).
- Messages: Clean Discord‑style layout, no avatars, clickable author names.
- User profiles: Floating popout next to the clicked name.
- Status: Only Online / Invisible.
- No seed phrases: Completely removed.