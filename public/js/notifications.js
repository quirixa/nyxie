// notifications.js — a tiny notification-sound player.
//
// Drop the actual audio file at public/assets/sounds/notification.mp3
// (referenced below) — this script just wires up when to play it.
//
// Respects a mute toggle stored in localStorage under
// 'switch-toggle-notif-sound', using the exact same key convention
// settings.js already uses for every other toggle switch on the
// Notifications settings tab (see the generic `.switch input` handler
// in settings.js — it persists as `switch-<element id>`). That means
// wiring a `<input type="checkbox" id="toggle-notif-sound">` into that
// tab (already done in index.html) "just works" with no extra JS.

const NotifSound = (() => {
  let audio = null;
  let unlocked = false;

  function getAudio() {
    if (!audio) {
      audio = new Audio('/assets/sounds/notification.mp3');
      audio.volume = 0.5;
    }
    return audio;
  }

  function isMuted() {
    return localStorage.getItem('switch-toggle-notif-sound') === 'false';
  }

  // Browsers block audio playback before the user has interacted with
  // the page at all. There's no way around that (nor should there be),
  // so the first click/keydown anywhere just primes it — this fires long
  // before the first real notification in practice, so it's invisible.
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    const a = getAudio();
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
    a.pause();
    a.currentTime = 0;
  }
  document.addEventListener('click', unlock, { once: true, capture: true });
  document.addEventListener('keydown', unlock, { once: true, capture: true });

  function play() {
    if (isMuted()) return;
    try {
      const a = getAudio();
      a.currentTime = 0;
      const p = a.play();
      // Playback can still legitimately fail (autoplay policy before the
      // unlock above has run, tab not focused on some platforms, the mp3
      // not having been added yet) — never let that surface as an error
      // in the console for something this minor.
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }

  return { play };
})();

function playNotificationSound() {
  NotifSound.play();
}

// Ringtone.play('incoming' | 'outgoing') / Ringtone.stop() — looping audio
// for calls, played while a call is ringing (incoming) or being dialed
// (outgoing/ringback), and stopped as soon as the call is answered,
// declined, or cancelled. Separate from NotifSound above (a call needs a
// *looping* sound that something else explicitly stops, not a one-shot),
// but shares its mute setting and unlock-on-first-interaction handling —
// a muted "Notification sound" toggle silences call ringing too, since
// there's no separate ringtone toggle in Settings.
const Ringtone = (() => {
  const files = {
    incoming: '/assets/sounds/ringtone-incoming.mp3',
    outgoing: '/assets/sounds/ringtone-outgoing.mp3'
  };
  let audio = null;
  let current = null;

  function isMuted() {
    return localStorage.getItem('switch-toggle-notif-sound') === 'false';
  }

  function play(kind) {
    if (kind === current) return; // already ringing with this tone
    stop();
    if (isMuted() || !files[kind]) return;
    current = kind;
    audio = new Audio(files[kind]);
    audio.loop = true;
    audio.volume = 0.6;
    const p = audio.play();
    // Same reasoning as NotifSound.play(): autoplay can legitimately be
    // blocked before the page's first click/keydown has fired, and that
    // shouldn't surface as a console error for something this minor.
    if (p && p.catch) p.catch(() => {});
  }

  function stop() {
    if (audio) { audio.pause(); audio.currentTime = 0; audio = null; }
    current = null;
  }

  return { play, stop };
})();
