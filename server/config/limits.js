// server/config/limits.js — message and attachment limits shared by the REST
// routes (rooms.js) and the upload-serving route.
//
// MESSAGE_MAX_CHARS is the Discord-style cap on a normal message. The client
// counts Unicode code points and converts anything longer into a .txt
// attachment instead of sending it as text, so a text message never exceeds
// this. The server cannot read end-to-end encrypted text, so for ciphertext it
// enforces the largest encoded size a message of that many characters can
// produce: 4 UTF-8 bytes per code point + 16 bytes of secretbox overhead,
// base64-encoded.
const MESSAGE_MAX_CHARS = 2000;
const MESSAGE_MAX_CIPHERTEXT_B64 = Math.ceil((MESSAGE_MAX_CHARS * 4 + 16) / 3) * 4;

// Upload endpoint cap (routes/uploads.js) and the nacl.secretbox overhead the
// client adds to every encrypted attachment, so the real plaintext size of an
// encrypted attachment is (stored size - SECRETBOX_OVERHEAD).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SECRETBOX_OVERHEAD = 16;

// Number of Unicode code points (not UTF-16 units), so an emoji counts as 1.
function charLength(s) {
  let n = 0;
  for (const _ of String(s)) n++;
  return n;
}

module.exports = { MESSAGE_MAX_CHARS, MESSAGE_MAX_CIPHERTEXT_B64, MAX_UPLOAD_BYTES, SECRETBOX_OVERHEAD, charLength };
