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