fix(chat): stop stale author names, ciphertext reply quotes, and unusable reply persistence

- dashboard.js: stop reverting msg.content back to ciphertext after
  render in the E2EE appendMessage wrapper — it was mutating the same
  object cached in window._messagesById, so reply quotes, the
  reply-preview bar, and message editing all ended up reading raw
  ciphertext instead of the decrypted text.

- dashboard.js: refresh already-rendered message rows (and their
  cached msg objects) when the display name is changed via the
  edit-profile modal, instead of only updating the profile popout.
  Exposed as window.refreshOwnDisplayNameEverywhere so settings.js's
  separate /settings profile form can call it too (not yet wired up).

- server: persist reply_to_id server-side (new column + migration in
  messageDb.js; validated, stored, and resolved in rooms.js). Replies
  previously weren't stored at all — reply_to_id/author/snippet sent
  by the client were silently dropped, so the reply quote only ever
  existed as a client-side optimistic patch that vanished on reload
  and never reached the other participant.

- dashboard.js: send only reply_to_id when replying (drop the old
  plaintext reply_to_author/reply_to_snippet fields, which leaked
  E2EE message content unencrypted); decrypt the server-resolved
  reply_to.content the same way as any other message.

- dashboard.js: handle image paste (Ctrl/Cmd+V) into the message
  input by routing clipboard images through the existing
  pendingFiles/handleFileUpload attachment flow — there was
  previously no paste handler at all.

- index.html: add autocomplete="off" to #msg-input, which was the
  only text input in the app missing it — the browser was caching
  and suggesting previously-sent messages (e.g. "hi") via native
  autofill, undermining the point of E2EE.