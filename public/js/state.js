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
// api, getPublicKey, and scrollToBottom used to be plain globals too
// (back when dashboard's logic was one top-level inline <script>,
// before it was wrapped in initDashboardView()). voice.js calls all
// three directly, expecting exactly that. They were missed when
// appendMessage/connectWS got converted to the declare-here-assign-there
// pattern above, leaving them as functions declared with
// `function name(){}` *inside* initDashboardView() — which makes each
// one local to that function and invisible to voice.js, throwing "X is
// not defined" the moment voice.js calls it. Declaring them here and
// having dashboard.js assign to them (same as appendMessage/connectWS)
// fixes that.
//
// NOTE: toast() and escapeHtml() do NOT need this treatment — both are
// already real globals, defined in utils.js (loaded before this file).
// dashboard.js's own toast()/escapeHtml() are separate, locally-scoped
// versions it uses internally; voice.js's calls to toast()/escapeHtml()
// already resolve to the utils.js globals just fine. Declaring `let
// toast`/`let escapeHtml` here would collide with those existing
// function declarations — top-level `let`/`const` and top-level
// `function` share one scope across all classic <script> tags in the
// page, so redeclaring either is an illegal duplicate declaration and
// throws a SyntaxError that takes down this entire file (which is
// exactly what happened when this was tried).
let api = null;
let getPublicKey = null;
let scrollToBottom = null;

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