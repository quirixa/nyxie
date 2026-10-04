// avatars.js — default (GitHub-style identicon) avatars and avatar-themed
// default banners. Top-level on purpose: both the dashboard and the settings
// view use these, and settings can be opened without the dashboard ever
// having been initialised (e.g. refreshing on /settings).

// ─── DEFAULT AVATARS (GitHub-style identicons) ───────────────
// A 5x5 mirrored grid drawn from a random per-account seed
// (users.avatar_seed, generated once at registration). The color comes
// from the seed too, so every account gets its own random color that
// stays the same everywhere. The SVG paints its own background, so
// nothing here ever tints an uploaded profile picture.
function seededRng(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (let i = 0; i < String(seed).length; i++) {
    h = Math.imul(h ^ String(seed).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
const _identiconCache = {};
function defaultAvatarHtml(seed) {
  seed = String(seed || '?');
  if (_identiconCache[seed]) return _identiconCache[seed];
  const rnd = seededRng(seed);
  const hue = Math.floor(rnd() * 360);
  const color = `hsl(${hue},${55 + Math.floor(rnd() * 25)}%,${48 + Math.floor(rnd() * 10)}%)`;
  let cells = '';
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (rnd() < 0.5) continue;
      cells += `<rect x="${x + 1}" y="${y + 1}" width="1" height="1"/>`;
      if (x < 2) cells += `<rect x="${5 - x}" y="${y + 1}" width="1" height="1"/>`;
    }
  }
  const svg = `<svg viewBox="0 0 7 7" width="100%" height="100%" shape-rendering="crispEdges" style="display:block"><rect width="7" height="7" fill="#f0f0f0"/><g fill="${color}">${cells}</g></svg>`;
  return (_identiconCache[seed] = svg);
}
function avatarSeedOf(u, fallbackName) {
  return (u && (u.avatar_seed || u.id)) || fallbackName || '?';
}
function setDefaultAvatar(el, seed) {
  if (!el) return;
  el.style.background = 'transparent';
  el.innerHTML = defaultAvatarHtml(seed);
}

// ─── DEFAULT BANNERS THEMED FROM THE AVATAR ───────────────────
// No banner / banner colour set -> the banner is a gradient built from
// the avatar's colour: the identicon's own colour for default avatars,
// or the dominant colour of the uploaded picture.
function identiconColor(seed) {
  const rnd = seededRng(String(seed || '?'));
  const hue = Math.floor(rnd() * 360);
  const sat = 55 + Math.floor(rnd() * 25);
  const light = 48 + Math.floor(rnd() * 10);
  return { hue, sat, light };
}
function bannerGradient(h, s, l) {
  h = Math.round(h); s = Math.round(s); l = Math.round(l);
  return `linear-gradient(135deg, hsl(${h},${s}%,${l}%), hsl(${(h + 28) % 360},${s}%,${Math.max(l - 14, 25)}%))`;
}
function defaultBannerFor(user) {
  const c = identiconColor(avatarSeedOf(user));
  return bannerGradient(c.hue, c.sat, c.light);
}
const _avatarThemeCache = {};
function avatarThemeFromImage(url) {
  if (_avatarThemeCache[url]) return _avatarThemeCache[url];
  return (_avatarThemeCache[url] = new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 24, 24);
        const d = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 128) continue;
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const wt = 0.05 + (mx - mn) / 255;   // favour colourful pixels over grey ones
          r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
        }
        if (!w) return resolve(null);
        r /= w; g /= w; b /= w;
        const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, dl = mx - mn;
        let h = 0;
        if (dl) {
          if (mx === r / 255) h = ((g - b) / 255 / dl) % 6;
          else if (mx === g / 255) h = (b - r) / 255 / dl + 2;
          else h = (r - g) / 255 / dl + 4;
          h *= 60; if (h < 0) h += 360;
        }
        const l = (mx + mn) / 2;
        const sat = dl ? dl / (1 - Math.abs(2 * l - 1)) : 0;
        resolve(bannerGradient(h, Math.min(Math.max(sat * 100, 40), 80), Math.min(Math.max(l * 100, 38), 56)));
      } catch (e) { resolve(null); }   // tainted canvas etc. -> keep the fallback
    };
    img.onerror = () => resolve(null);
    img.src = url;
  }));
}
function applyDefaultBanner(el, user) {
  if (!el || !user) return;
  el.style.background = defaultBannerFor(user);
  if (!user.avatar) return;
  const set = el.style.background;
  avatarThemeFromImage(versionedMediaUrl(user.avatar)).then(g => {
    if (g && el.isConnected && el.style.background === set) el.style.background = g;
  });
}
