// app.js — SPA entry point. Everything else (state.js, api.js, theme.js,
// router.js, auth.js, dashboard.js, voice.js, settings.js) has already
// defined its functions by the time this runs; this just starts the
// router, which renders whichever route the URL / browser history says
// we're on.

document.addEventListener('DOMContentLoaded', () => {
  router.start();
});
