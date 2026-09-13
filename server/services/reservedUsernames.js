// server/services/reservedUsernames.js — single source of truth for
// which usernames are reserved, loaded from public/assets/reserved-
// usernames.json instead of being hardcoded in each route that needs
// it (previously duplicated verbatim in routes/auth.js and
// routes/users.js, and again on the client in js/auth.js and
// js/settings.js). Same idea as the emoji list (public/assets/
// emojis.json) — one JSON file is the data, code just reads it.
//
// This reads the file directly off disk (not over HTTP) since this
// runs on the server; the client-side copy of this list (utils.js's
// ReservedUsernames) fetches the same file over HTTP instead, for the
// same reason the emoji picker fetches emojis.json rather than
// bundling it into a script.
//
// Loaded once and cached — the list only changes via a deploy, never
// at runtime, so there's no reason to re-read the file on every
// registration.
//
// There is deliberately no hardcoded fallback list here. The JSON file
// is the only source of truth for what's reserved — if it's missing or
// malformed, that's a deploy bug to fix, not something to silently
// paper over with a second, drifting copy of the list baked into code.
// If it can't be loaded, nothing is treated as reserved.

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', '..', 'public', 'assets', 'reserved-usernames.json');

let cached = null;

function loadReservedUsernames() {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cached = (Array.isArray(parsed))
      ? parsed.map(s => String(s).toLowerCase())
      : [];
    if (!Array.isArray(parsed)) {
      console.error('reservedUsernames:', DATA_PATH, 'did not contain a JSON array — treating list as empty');
    }
  } catch (e) {
    console.error('reservedUsernames: failed to load', DATA_PATH, '- treating list as empty:', e.message);
    cached = [];
  }
  return cached;
}

function isReservedUsername(username) {
  return loadReservedUsernames().includes(String(username || '').toLowerCase());
}

module.exports = { loadReservedUsernames, isReservedUsername };
