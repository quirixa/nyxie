// state.js — shared session/chat state.
//
// dashboard.js and voice.js are two separate classic <script> files that
// read and write the same handful of bindings directly (no imports —
// see voice.js's header comment for the original rationale). Classic
// scripts loaded into the same document share one global lexical
// environment for top-level `let`/`const`, so declaring these here,
// once, before either of those files loads, is what makes that sharing
// well-defined instead of accidental. dashboard.js's initDashboardView()
// resets these to fresh values every time the view mounts; it assigns
// to them rather than re-declaring with `let`.

let token = localStorage.getItem('nyxie_token');
let currentUser = JSON.parse(localStorage.getItem('nyxie_user') || 'null');
let ws = null;
let wsReady = false;
let currentRoom = null;
let dms = [];
const sentMsgIds = new Set();
// voice.js wraps both of these (captures the original, reassigns the
// bare identifier to a wrapper that calls through to it) once voice
// features initialize — see voice.js's own comments on
// appendMessageBeforeVoice / origConnectWS. For that reassignment to be
// visible to dashboard.js's own internal callers too, both need to be
// plain top-level `let` bindings that dashboard.js *assigns* to (not
// re-declares with `function name(){}`, which would make them local to
// initDashboardView and invisible to voice.js).
let appendMessage = null;
let connectWS = null;

function isLoggedIn() {
  return !!(token && currentUser);
}

function clearSession() {
  token = null;
  currentUser = null;
  localStorage.removeItem('nyxie_token');
  localStorage.removeItem('nyxie_user');
  localStorage.removeItem('nyxie_status');
}
