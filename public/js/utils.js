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
