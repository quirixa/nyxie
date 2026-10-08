// prefs.js — client-side preferences that aren't tied to one settings tab:
// experiments, voice/audio device settings, and cross-device settings sync.
// Classic script (no import/export), loaded after theme.js so the
// experiments apply as early as the theme does. Everything here is used
// by the Settings tabs (settings.js) and by voice.js / notifications.js
// (mic + output preferences).

// ── Project links ────────────────────────────────────────────────
// Fill these in to light up the "View source" and "Donate" buttons in
// Settings. Empty string = the button is hidden.
const NYXIE_LINKS = {
  source: '',   // e.g. 'https://github.com/you/nyxie'
  donate: '',   // e.g. 'https://ko-fi.com/you'
};

// ── Experiments ──────────────────────────────────────────────────
const NYXIE_EXPERIMENTS = [
  { id: 'compact', label: 'Compact messages', desc: 'Tighter spacing between messages so more fits on screen.' },
  { id: 'large-text', label: 'Larger message text', desc: 'Bump up the size of message text for easier reading.' },
  { id: 'reduce-motion', label: 'Reduce motion', desc: 'Turn off most animations and transitions.' },
  { id: 'strong-borders', label: 'Stronger borders', desc: 'Make dividers and outlines easier to see.' },
];

function getExperiments() {
  try { return JSON.parse(localStorage.getItem('nyxie_experiments') || '{}') || {}; } catch (e) { return {}; }
}

function setExperiment(id, on) {
  const cur = getExperiments();
  cur[id] = !!on;
  localStorage.setItem('nyxie_experiments', JSON.stringify(cur));
  applyExperiments();
}

function applyExperiments() {
  const cur = getExperiments();
  NYXIE_EXPERIMENTS.forEach(e => document.body.classList.toggle('exp-' + e.id, !!cur[e.id]));
}
applyExperiments();

// ── Voice / audio preferences ────────────────────────────────────
const NYXIE_VOICE_DEFAULTS = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  inputVolume: 100,          // 0–200 (%), applied as a gain node on the mic
  outputVolume: 100,         // 0–100 (%), applied to playback elements
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
};

function getVoicePrefs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('nyxie_voice') || '{}') || {}; } catch (e) {}
  return Object.assign({}, NYXIE_VOICE_DEFAULTS, saved);
}

function saveVoicePrefs(patch) {
  const next = Object.assign(getVoicePrefs(), patch);
  localStorage.setItem('nyxie_voice', JSON.stringify(next));
  return next;
}

function nyxieAudioConstraints() {
  const p = getVoicePrefs();
  const audio = {
    noiseSuppression: !!p.noiseSuppression,
    echoCancellation: !!p.echoCancellation,
    autoGainControl: !!p.autoGainControl,
  };
  if (p.inputDeviceId && p.inputDeviceId !== 'default') audio.deviceId = { ideal: p.inputDeviceId };
  return { audio };
}

// Drop-in for getUserMedia({ audio: true }) that honours the saved
// device, processing toggles and input volume. Falls back to plain
// { audio: true } if the saved constraints can't be satisfied.
async function nyxieGetMic() {
  let raw;
  try {
    raw = await navigator.mediaDevices.getUserMedia(nyxieAudioConstraints());
  } catch (e) {
    if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
      raw = await navigator.mediaDevices.getUserMedia({ audio: true });
    } else {
      throw e;
    }
  }
  const gainPct = getVoicePrefs().inputVolume;
  if (gainPct === 100 || typeof gainPct !== 'number') return raw;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return raw;
  try {
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(raw);
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, gainPct) / 100;
    const dest = ctx.createMediaStreamDestination();
    src.connect(gain); gain.connect(dest);
    // Callers stop the tracks they were handed; make sure that also
    // releases the real microphone and the audio context.
    dest.stream.getAudioTracks().forEach(track => {
      const origStop = track.stop.bind(track);
      track.stop = () => { origStop(); raw.getTracks().forEach(t => t.stop()); ctx.close().catch(() => {}); };
    });
    return dest.stream;
  } catch (e) {
    return raw;
  }
}

// Apply the saved output volume / device to an <audio> element. `base`
// is that element's own natural level (e.g. 0.5 for the notification ping).
function nyxieApplyOutput(el, base) {
  if (!el) return el;
  const p = getVoicePrefs();
  const b = typeof base === 'number' ? base : 1;
  el.volume = Math.max(0, Math.min(1, b * (p.outputVolume / 100)));
  if (p.outputDeviceId && p.outputDeviceId !== 'default' && typeof el.setSinkId === 'function') {
    el.setSinkId(p.outputDeviceId).catch(() => {});
  }
  return el;
}

// ── Settings sync ────────────────────────────────────────────────
// Which localStorage keys travel with the account. Deliberately excludes
// the token, the cached user, and anything device-specific.
function nyxieIsSyncKey(k) {
  return ['theme', 'accent', 'font', 'nyxie_language', 'nyxie_voice', 'nyxie_experiments'].includes(k) || /^switch-/.test(k);
}

function nyxieCollectSyncable() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (nyxieIsSyncKey(k)) out[k] = localStorage.getItem(k);
  }
  // Device ids only make sense on the device that produced them.
  try {
    const v = JSON.parse(out.nyxie_voice || 'null');
    if (v) { v.inputDeviceId = 'default'; v.outputDeviceId = 'default'; out.nyxie_voice = JSON.stringify(v); }
  } catch (e) {}
  return out;
}

async function nyxieSyncApi(method, body) {
  const t = localStorage.getItem('nyxie_token');
  if (!t) throw new Error('Not signed in');
  const res = await fetch('/api/account/settings-sync', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Sync failed');
  return data;
}

function nyxieSyncAuto() { return localStorage.getItem('nyxie_sync_auto') === 'true'; }
function nyxieSyncLast() { return Number(localStorage.getItem('nyxie_sync_last') || 0); }

async function nyxiePushSettings() {
  const r = await nyxieSyncApi('PUT', { data: nyxieCollectSyncable() });
  localStorage.setItem('nyxie_sync_last', String(r.updatedAt));
  return r.updatedAt;
}

let _nyxieApplyingSync = false;
function nyxieApplySynced(data) {
  _nyxieApplyingSync = true;
  try {
    const keep = {};
    // Keep this device's own audio device choices.
    const localVoice = getVoicePrefs();
    Object.keys(data).forEach(k => { if (nyxieIsSyncKey(k)) keep[k] = data[k]; });
    if (keep.nyxie_voice) {
      try {
        const v = JSON.parse(keep.nyxie_voice);
        v.inputDeviceId = localVoice.inputDeviceId; v.outputDeviceId = localVoice.outputDeviceId;
        keep.nyxie_voice = JSON.stringify(v);
      } catch (e) { delete keep.nyxie_voice; }
    }
    Object.keys(keep).forEach(k => localStorage.setItem(k, keep[k]));
  } finally { _nyxieApplyingSync = false; }
  if (typeof applyTheme === 'function') applyTheme(localStorage.getItem('theme') || 'dark');
  if (typeof applyAccent === 'function') applyAccent();
  const font = localStorage.getItem('font');
  if (font) document.body.style.fontFamily = font + ', sans-serif';
  applyExperiments();
  const lang = localStorage.getItem('nyxie_language');
  if (lang && window.setLanguage && window.getLanguage && window.getLanguage() !== lang) window.setLanguage(lang);
  document.dispatchEvent(new CustomEvent('nyxie:settingsapplied'));
}

// Returns { applied, updatedAt }. `force` ignores the "server newer?" check.
async function nyxiePullSettings(force) {
  const r = await nyxieSyncApi('GET');
  if (!r.data) return { applied: false, updatedAt: null };
  if (!force && r.updatedAt <= nyxieSyncLast()) return { applied: false, updatedAt: r.updatedAt };
  nyxieApplySynced(r.data);
  localStorage.setItem('nyxie_sync_last', String(r.updatedAt));
  return { applied: true, updatedAt: r.updatedAt };
}

// Auto-sync: push (debounced) whenever a synced key changes on this device.
(function hookAutoPush() {
  const orig = Storage.prototype.setItem;
  let timer = null;
  Storage.prototype.setItem = function (k, v) {
    orig.call(this, k, v);
    if (this === window.localStorage && !_nyxieApplyingSync && nyxieIsSyncKey(k) && nyxieSyncAuto() && localStorage.getItem('nyxie_token')) {
      clearTimeout(timer);
      timer = setTimeout(() => { nyxiePushSettings().catch(() => {}); }, 2000);
    }
  };
})();

// Called on app start and right after login.
async function nyxieAutoPull() {
  if (!nyxieSyncAuto() || !localStorage.getItem('nyxie_token')) return;
  try { await nyxiePullSettings(false); } catch (e) { /* offline or signed out — ignore */ }
}
document.addEventListener('DOMContentLoaded', () => { nyxieAutoPull(); });
