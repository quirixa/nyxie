// router.js — a small History-API router for the Nyxie SPA.
//
// Responsibilities:
//   - map a path to a <template> to clone into #app-root
//   - run that view's init() once its markup is actually in the DOM
//   - run the previous view's destroy() (if any) before swapping away,
//     so e.g. dashboard.js can close its WebSocket instead of leaking it
//   - guard routes that require (or forbid) being logged in
//   - intercept clicks on same-origin links marked data-link so
//     navigation never triggers a full page reload
//
// No history/framework dependency — this is the whole router.

const router = (() => {
  const routes = [
    { path: '/', template: 'tpl-landing', auth: 'any' },
    { path: '/login', template: 'tpl-login', auth: 'guest', init: () => initLoginView() },
    { path: '/register', template: 'tpl-register', auth: 'guest', init: () => initRegisterView() },
    { path: '/app', template: 'tpl-app', auth: 'required', init: () => initDashboardView(), destroy: () => { if (typeof destroyDashboardView === 'function') destroyDashboardView(); } },
    { path: '/settings', template: 'tpl-settings', auth: 'required', init: () => initSettingsView(), destroy: () => { if (typeof destroySettingsView === 'function') destroySettingsView(); } }
  ];

  let current = null; // the matched route object currently mounted
  const root = () => document.getElementById('app-root');

  function matchRoute(path) {
    return routes.find(r => r.path === path) || null;
  }

  function applyAuthGuard(route) {
    if (!route) return '/';
    if (route.auth === 'required' && !isLoggedIn()) return '/login';
    if (route.auth === 'guest' && isLoggedIn()) return '/app';
    return null; // no redirect needed
  }

  function renderNotFound() {
    root().innerHTML = `
      <div class="route-error">
        <h1>Page not found</h1>
        <p>That page doesn't exist.</p>
        <a href="/" data-link>Back home</a>
      </div>`;
  }

  async function render(path) {
    const route = matchRoute(path);
    if (!route) { renderNotFound(); return; }

    const redirect = applyAuthGuard(route);
    if (redirect) { navigate(redirect, { replace: true }); return; }

    // Tear down whatever view is currently mounted before swapping.
    if (current && current.destroy) {
      try { current.destroy(); } catch (e) { console.error('View teardown error:', e); }
    }

    const tpl = document.getElementById(route.template);
    if (!tpl) { renderNotFound(); return; }

    root().innerHTML = '';
    root().appendChild(tpl.content.cloneNode(true));
    // Re-apply theme classes: body-level classes persist across
    // navigations already, but a freshly cloned view may contain
    // elements (accent swatches, theme cards) that need the current
    // values reflected immediately.
    if (typeof applyTheme === 'function') applyTheme();
    if (typeof applyAccent === 'function') applyAccent();

    current = route;

    if (route.init) {
      try { route.init(); } catch (e) { console.error('View init error:', e); }
    }
  }

  function navigate(path, { replace = false } = {}) {
    if (typeof path !== 'string') return;
    const url = new URL(path, window.location.origin);
    const target = url.pathname;
    if (replace) {
      window.history.replaceState({}, '', target);
    } else if (window.location.pathname !== target) {
      window.history.pushState({}, '', target);
    }
    render(target);
  }

  function start() {
    // Intercept clicks on same-origin [data-link] anchors.
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-link]');
      if (!link) return;
      const href = link.getAttribute('href');
      if (!href || href.startsWith('http') || link.target === '_blank') return;
      e.preventDefault();
      navigate(href);
    });

    window.addEventListener('popstate', () => render(window.location.pathname));

    render(window.location.pathname || '/');
  }

  return { navigate, start };
})();
