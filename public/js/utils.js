// utils.js — small helpers shared by every view. Classic script (no
// import/export) so every other app script can call these directly,
// same as the rest of the app's module set (see state.js for why).

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// highlightMentions — wraps @username occurrences in already-escaped
// message HTML with a styled span. Takes ESCAPED content (i.e. run
// escapeHtml() first) so this never introduces raw HTML from the
// message text itself — it only wraps text that literally matches one
// of the given members' usernames, and the username itself is
// re-escaped before being placed in the output.
//
// `members` is [{id, username}] — the room's member list (or however
// many of them are known), used only to know which @tokens are real
// users worth highlighting, not to render anything unescaped.
function highlightMentions(escapedContent, members, selfId) {
  if (!members || !members.length) return escapedContent;
  let html = escapedContent;
  const sorted = [...members]
    .filter(m => m && m.username)
    .sort((a, b) => b.username.length - a.username.length);
  for (const m of sorted) {
    const uname = escapeHtml(m.username);
    const re = new RegExp(`(^|[^\\w@])@${escapeRegExp(uname)}(?!\\w)`, 'g');
    html = html.replace(re, (match, pre) =>
      `${pre}<span class="mention${m.id === selfId ? ' mention-me' : ''}" data-user-id="${m.id}">@${uname}</span>`);
  }
  return html;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Toast — looks for a #toast (dashboard) or #toastMsg (auth pages)
// element in whichever view is currently mounted.
let _toastTimeout = null;
function toast(message, isError) {
  const el = document.getElementById('toast') || document.getElementById('toastMsg');
  if (!el) return;
  if (_toastTimeout) clearTimeout(_toastTimeout);
  el.textContent = message;
  el.style.opacity = '1';
  if (el.id === 'toastMsg') {
    if (isError) {
      el.style.background = '#2c1a1a';
      el.style.borderColor = '#aa4a4a';
      el.style.color = '#ffc6c6';
    } else {
      el.style.background = '#1e2a1e';
      el.style.borderColor = '#4f7a4f';
      el.style.color = '#c6ffc6';
    }
  }
  _toastTimeout = setTimeout(() => { el.style.opacity = '0'; }, 4000);
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (isToday) return 'Today';
  if (isYesterday) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function debounce(fn, wait) {
  let t = null;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

// versionedMediaUrl — cache-friendly replacement for the old
// `url + '?t=' + Date.now()` pattern. Appending a fresh timestamp on
// *every* render defeated the browser cache entirely, so avatars/banners
// re-fetched from the network on every navigation (visible flash/reload
// each time). Instead we memoize one cache-busting token per distinct
// URL, so repeated renders of the same URL reuse the same token (cache
// hit), and only actual uploads (which pass bump=true) get a fresh one.
const _mediaCacheTokens = new Map();
function versionedMediaUrl(url, bump) {
  if (!url) return url;
  if (bump || !_mediaCacheTokens.has(url)) {
    _mediaCacheTokens.set(url, Date.now());
  }
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'v=' + _mediaCacheTokens.get(url);
}