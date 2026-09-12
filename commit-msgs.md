fix(voice): allow blob: audio playback under CSP and match recorded/stored MIME types

Voice messages failed to play with:

    Loading media from 'blob:https://nyxie.ethiodeploy.com/...' violates
    the following Content Security Policy directive: "default-src 'self'".
    Note that 'media-src' was not explicitly set, so 'default-src' is
    used as a fallback.

    Uncaught (in promise) NotSupportedError: Failed to load because no
    supported source was found.

Root causes:

1. The CSP had no `media-src` directive, so `<audio>` blob: playback
   fell back to `default-src 'self'`, which blocks `blob:` outright.
2. Voice message playback always rebuilt the decrypted audio into a
   `Blob` hardcoded as `type: 'audio/webm'`, regardless of what the
   sender's browser actually recorded. Safari cannot record WebM at
   all (MediaRecorder there only supports MP4/AAC), so any Safari
   sender's clip was mislabeled on every recipient's device and
   failed to decode.
3. The recorded MIME type was never sent to or stored by the server,
   so there was no way for playback to know a message's real format.
4. Recording itself hardcoded a `'audio/webm'` fallback if Opus
   wasn't supported, which throws in browsers (Safari) that support
   neither WebM variant.
5. Decrypted playback Blob URLs (`URL.createObjectURL`) were never
   revoked, leaking for the life of the view.

Changes:

- **server/server.js**: add `media-src 'self' blob:;` to the CSP.
- **server/database/messageDb.js**, **server/database/messageDbPg.js**:
  add a `mime_type` column (migrated via `ALTER TABLE ... IF NOT
  EXISTS`-style guard) to persist the real recorded format per voice
  message. Existing rows default to NULL; client falls back to
  `audio/webm` for those.
- **server/routes/rooms.js**: accept an optional `mimeType` on voice
  message POSTs, validate it against a constrained audio-MIME regex
  (falls back to `audio/webm` if missing/invalid — it's
  client-controlled and gets echoed back to every recipient), store
  it, and return/select it on every message read.
- **public/js/voice.js**:
  - `pickRecordingMimeType()`: tries WebM/Opus → WebM → Ogg/Opus →
    MP4/AAC → AAC via `MediaRecorder.isTypeSupported`, falls back to
    the browser's own default, and surfaces a clear "not supported"
    toast if MediaRecorder is unavailable entirely.
  - Wrap `MediaRecorder` construction in try/catch to release the mic
    gracefully if construction still fails despite a supported-type
    check.
  - Send the recorder's actual `mimeType` alongside the message.
  - Build playback Blobs using `msg.mime_type` from the server
    instead of a hardcoded value.
  - Revoke cached playback Blob URLs on view teardown
    (`destroyVoiceFeatures`) to stop the leak.

No changes to text/image/file/E2EE/WebSocket handling, upload routes,
or UI/markup beyond what's required for voice playback.

Testing:
- Local server boot + CSP header verified to include `media-src 'self'
  blob:;`.
- End-to-end DM round trip (register → DM → POST voice message → GET
  messages) confirms a non-webm `mimeType` (simulated Safari
  `audio/mp4` sender) persists correctly through insert and read.
- Verified a malicious/invalid `mimeType` input safely falls back to
  `audio/webm` server-side.
- Regression-checked text messages, room list previews, and existing
  API responses remain unaffected.

Files changed:
- server/server.js
- server/database/messageDb.js
- server/database/messageDbPg.js
- server/routes/rooms.js
- public/js/voice.js