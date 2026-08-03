# Nyxie — refactor notes

This is a restructure of the original Nyxie codebase (5 HTML pages +
17 backend/frontend files, ~12,000 lines, two of the pages being a
single giant inline `<script>`+`<style>` block each) into:

- a proper `server/` (routes / middleware / websocket / database /
  services) instead of one flat `src/` folder,
- a real single-page app with client-side (History API) routing instead
  of five separate HTML pages, and
- frontend logic split into named modules instead of two ~2,500-line
  inline scripts.

Functionality is unchanged. Nothing was removed. Where something was
broken or fragile, it's fixed and explained below rather than papered
over.

## Running it

```
npm install
cp .env.example .env   # then set JWT_SECRET (see the comment in that file)
npm start
```

Visit `http://localhost:3000`. Client-side routes: `/`, `/login`,
`/register`, `/app` (the dashboard), `/settings` — all served by one
`index.html`; direct navigation/refresh on any of them works too (see
the SPA fallback in `server/server.js`).

> **I could not run `npm install` or boot the server myself** — this
> sandbox has no network access (a real attempt hit `403` from the npm
> registry). Everything below was verified statically: every file
> passes `node --check`, every `require()` path was checked to resolve
> to a real file, and every internal cross-reference (element IDs,
> shared globals, route names) was traced by hand. It has not been
> runtime-tested. Please run it and report anything that breaks —
> given the size of this change, I'd treat the first real run as a
> verification pass, not a formality.

## Layout

```
server/
  routes/        auth, users, rooms, servers, friends — one file each
  middleware/     requireAuth
  websocket/      WebSocket setup + voice-call signaling relay
  database/       userDb (sql.js), messageDb (sql.js), messageDbPg (unused, kept)
  services/       jwt.js — sign/verify, shared by routes + middleware
  server.js       entry point
public/
  index.html      SPA shell: <template> per view + router outlet
  css/            one stylesheet per view, all scoped (see below)
  js/             one module per concern (see below)
  assets/         emojis.json
data/             sql.js database files + uploaded avatars/banners (gitignored)
```

## The backend reorg

Mostly mechanical — same logic, moved into `server/routes|middleware|
websocket|database|services` and `require()` paths updated to match.
Three real changes:

1. **`services/jwt.js` is new.** `middleware.js` used to import
   `JWT_SECRET` from `routes/auth.js`. That worked (no circular
   `require`), but it meant a piece of app-wide config lived inside a
   route file and everything else depended on that route file just to
   check a token. Token signing/verification is its own concern now;
   routes and middleware both depend on it instead of on each other.

2. **A dead `messages` table was removed from `userDb.js`.** The
   original file created a `messages` table with a `nonce` column, but
   messages actually live in the separate `nyxie_messages.db` (see
   `messageDb.js`) — nothing in the app ever queried the `messages`
   table through the *user* DB handle. It was unused schema, presumably
   left over from before messages were split into their own database.

3. **SPA fallback route added to `server.js`.** Client-side routes
   (`/app`, `/settings`, ...) aren't real files, so a direct navigation
   or hard refresh needs the server to still serve `index.html` for
   those paths (letting the router take over client-side) while still
   returning real 404s for genuinely missing static files. See the
   comment above that route in `server.js`.

4. **CSP note (read this one):** the original
   `Content-Security-Policy` had `script-src 'self' https://cdn.jsdelivr.net`
   — no `'unsafe-inline'`. But the app's own markup uses `onclick="..."`
   attributes throughout (`onclick="toggleSidebar()"`, etc.), and inline
   event-handler attributes are governed by `script-src`. **That means
   the original CSP, if actually enforced, would have already silently
   broken every one of those buttons** — this predates the refactor,
   it's just easier to spot once you're looking at the whole app in one
   place. I added `'unsafe-inline'` to `script-src` so the (preserved)
   `onclick` handlers actually work, and left a comment at that exact
   line explaining the trade-off and the real fix: migrate every
   `onclick="foo()"` to a `data-action="foo"` attribute handled by one
   delegated `addEventListener('click', ...)` per view. That's a
   substantial, mechanical follow-up (~70 call sites across the
   dashboard/settings templates) that I did not do in this pass — see
   "What I'd do next" below for why.

## The frontend: from 5 pages to 1 SPA

### The router (`public/js/router.js`)

Hand-written, no dependency. Routes are `{ path, template, auth,
init, destroy }` objects. `router.navigate(path)` pushes/replaces
history state and re-renders; clicking any `<a data-link href="/x">`
is intercepted so it never triggers a full page load. Each route's
`<template>` is cloned into `#app-root`; the previous view's
`destroy()` (if any) runs first so e.g. the dashboard can close its
WebSocket before the settings view mounts.

Auth guards: `/app` and `/settings` require a session; `/login` and
`/register` redirect to `/app` if you already have one — same as the
original app deciding what to link to from `index.html`, just enforced
centrally instead of per-page.

### Why the JS files are classic scripts, not ES modules

`voice.js`, in the original app, has this comment at the top:

> Classic (non-module) `<script>` tags in the same document share one
> global lexical scope, so top-level `let`/`const`/functions declared
> in [dashboard.html's script] — `ws`, `dms`, `currentRoom`,
> `currentUser`, `token`, `sentMsgIds`, `api()`, `toast()`, ... — are
> all directly readable/writable here without any imports.

That's not incidental — `voice.js` actively **monkey-patches** two of
dashboard's functions after the fact (captures the original, reassigns
the bare identifier to a wrapper that calls through to it):

```js
const appendMessageBeforeVoice = appendMessage;
appendMessage = async function (msg) { /* decrypt voice messages, then */ return appendMessageBeforeVoice.call(this, msg); };
...
const origConnectWS = connectWS;
connectWS = function () { origConnectWS(); installWsHook(); };
```

Converting everything to ES modules with explicit imports would have
meant either breaking that pattern (rewriting voice message handling
and call-signaling hookup, which are real, working, non-trivial
features) or reimplementing it with some other indirection layer. I
chose to **preserve the existing contract** instead: `public/js/state.js`
declares `token`, `currentUser`, `ws`, `wsReady`, `currentRoom`, `dms`,
`sentMsgIds`, `appendMessage`, and `connectWS` as shared top-level
`let` bindings, loaded before either `dashboard.js` or `voice.js`.
Classic `<script>` tags loaded into the same document share one global
lexical environment for top-level `let`/`const` — so this is the same
sharing mechanism the original app already used, just given an
explicit home instead of accidentally falling out of two scripts being
concatenated onto one page.

This was the single trickiest part of the port. The specific risk:
wrapping `dashboard.js`'s ~2,500 lines in `initDashboardView()` (so the
router can call it only once `#view-app` is actually in the DOM,
instead of it running the instant the script parses) turns everything
declared inside it into *local* variables — including `appendMessage`
and `connectWS`, which is exactly what `voice.js` needs to reassign.
Local variables aren't visible to a separate script. Fixed by having
`state.js` declare those two names, and `dashboard.js` **assign** to
them (`appendMessage = function (msg) {...}`) instead of *declaring*
them (`function appendMessage(msg) {...}`) — same body, but now it's
mutating the shared binding instead of shadowing it. Everything else
`dashboard.js` defines (its ~60 other functions) stays function-local,
same as before, and is re-exposed to `window` for `onclick="..."`
handlers via the same `window.foo = foo` block the original file
already had at the bottom (that block was actually redundant in the
original — flat top-level `function` declarations are already
`window` properties — but became load-bearing once I wrapped
everything in `initDashboardView()`, which is a nice coincidence: it
meant every `onclick` handler kept working without auditing all ~60
individually).

`voice.js` itself got the same treatment: its top-level IIFE became
`initVoiceFeatures()` / `destroyVoiceFeatures()`, called by
`dashboard.js` right after `connectWS()` sets up the WebSocket (the
exact point in the original where `ws.onmessage` first exists for
`voice.js` to wrap) and torn down when navigating away from `/app`
(hangs up any in-progress call, stops an in-progress recording,
disconnects its `MutationObserver`).

`settings.js` had no such cross-file dependency (no WebSocket, nothing
`dashboard.js` or `voice.js` reads from it), so it's the simplest port:
wrapped in `initSettingsView()`, three `window.location.href =
'*.html'` hard navigations replaced with `router.navigate(...)`.

### A real bug this surfaced: `logout()`

The original `logout()` cleared `localStorage` and then did
`window.location.href = 'login.html'` — a full page reload, which for
free also wiped every in-memory JS variable. In the SPA there's no
reload, so `token`/`currentUser` (now shared bindings in `state.js`)
would have stayed set in memory after "logging out," and the router's
auth guard (`isLoggedIn()`) would have incorrectly still treated the
user as logged in. Fixed by adding `clearSession()` to `state.js` and
calling it from both `dashboard.js`'s and `settings.js`'s `logout()`.
This is exactly the kind of latent bug that only becomes reachable once
page reloads stop being the (accidental) reset mechanism between
"pages" — worth calling out because there may be others like it that
only manifest under real interactive use, which is why this needs a
real test pass (see the top of this file).

### CSS

Each view's original `<style>` block is now its own file
(`css/dashboard.css`, `css/settings.css`, `css/auth-login.css`,
`css/auth-register.css`, `css/landing.css`), all loaded at once, each
scoped under that view's root id (`#view-app .foo`, `#view-settings
.foo`, ...) so they can coexist without leaking into each other. Two
real conflicts this caught:

1. `login.html` and `register.html` both had a bare `.wrapper` /
   `.info` selector with **different, incompatible** rules (grid vs.
   flex layout). Loaded together unscoped, one would have silently
   broken the other's layout.
2. `dashboard.html` and `settings.html` each had their own local
   `:root { --bg-primary: ...; --accent: ...; }` block — the app's
   *default* theme values, used when no `theme-light`/`theme-dark`
   class is on `<body>`. In the original multi-page app this worked
   because each page's `<style>` block really did apply at the true
   document root. Nested inside an SPA container, `#view-app`'s
   locally-declared `--accent` would **shadow** the value `theme.js`
   sets on `<html>` when the user picks a custom accent color, since a
   value declared directly on an element always wins over one it
   would otherwise inherit. I moved these into `theme.css` as a real
   named theme (`body.theme-esc`, matching the existing `theme-light`/
   `theme-dark` pattern) instead of leaving them duplicated per-view,
   which is both the fix and, I'd argue, the more correct structure —
   the original's reliance on "whichever page's `<style>` block happens
   to run first at :root scope" was fragile even before this refactor.

## What I'd do next (not done in this pass)

- **Migrate `onclick="..."` attributes to delegated event listeners**
  and drop `'unsafe-inline'` from the CSP. Real security hardening,
  but ~70 call sites across two large templates with no test
  environment to verify each one against — higher risk than value to
  attempt blind in this session.
- **A real run.** `npm install && npm start`, then manually exercise:
  register → E2EE key setup → login on the "same device" (recovers the
  key) → send a DM → send a voice message → start a voice call → change
  theme/accent in Settings → verify it's reflected in the dashboard
  without a reload → log out → confirm `/app` redirects to `/login`.
- Given the size of this change, I'd also want CI running `node --check`
  on every file (cheap, already caught nothing here, but only after I
  ran it manually).
