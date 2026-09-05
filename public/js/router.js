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
//   - support ':param' segments (e.g. '/app/rooms/:roomId') so a route's
//     init() can read the matched value — this is what gives each open
//     conversation its own real, refreshable/shareable URL, Discord-style.
//
// No history/framework dependency — this is the whole router.

const router = (() => {
  // Turn a path like '/app/rooms/:roomId' into a regex plus the list of
  // param names in the order they appear, so matchRoute() can pull
  // { roomId: '...' } back out of a real URL.
  function compilePath(path) {
    const paramNames = [];
    const source = path
      .split('/')
      .map(segment => {
        if (segment.startsWith(':')) {
          paramNames.push(segment.slice(1));
          return '([^/]+)';
        }
        // Escape any regex-special chars in static segments.
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { regex: new RegExp('^' + source + '$'), paramNames };
  }

  const routeDefs = [
    { path: '/', template: 'tpl-landing', auth: 'any' },
    { path: '/login', template: 'tpl-login', auth: 'guest', init: () => initLoginView() },
    { path: '/register', template: 'tpl-register', auth: 'guest', init: () => initRegisterView() },
    { path: '/app', template: 'tpl-app', auth: 'required', init: () => initDashboardView(), destroy: () => { if (typeof destroyDashboardView === 'function') destroyDashboardView(); } },
    // Same template/view as /app — the wallet panel is a section inside
    // the dashboard, not a separate page. This route exists so that
    // opening or refreshing on /wallets directly lands on that section
    // instead of 404ing (there was no real route for it before, so a
    // refresh while the wallet panel was open had nowhere to go — see
    // window._initialSection in dashboard.js, which this reads).
    { path: '/wallets', template: 'tpl-app', auth: 'required', init: () => { window._initialSection = 'wallet'; initDashboardView(); }, destroy: () => { if (typeof destroyDashboardView === 'function') destroyDashboardView(); } },
    // One real URL per open conversation (mirrors the /wallets pattern
    // above): opening a DM pushes '/app/rooms/<id>' so refreshing,
    // sharing the link, or using browser back/forward lands back on
    // that exact conversation instead of always resetting to home. See
    // window._initialRoomId in dashboard.js, which this sets before the
    // dashboard mounts.
    { path: '/app/rooms/:roomId', template: 'tpl-app', auth: 'required', init: (params) => { window._initialRoomId = params.roomId; initDashboardView(); }, destroy: () => { if (typeof destroyDashboardView === 'function') destroyDashboardView(); } },
    { path: '/settings', template: 'tpl-settings', auth: 'required', init: () => initSettingsView(), destroy: () => { if (typeof destroySettingsView === 'function') destroySettingsView(); } }
  ];

  const routes = routeDefs.map(def => Object.assign({}, def, compilePath(def.path)));

  let current = null; // the matched route object currently mounted
  const root = () => document.getElementById('app-root');

  function matchRoute(path) {
    for (const route of routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      return { route, params };
    }
    return null;
  }

  function applyAuthGuard(route) {
    if (!route) return '/';
    if (route.auth === 'required' && !isLoggedIn()) return '/login';
    if (route.auth === 'guest' && isLoggedIn()) return '/app';
    return null; // no redirect needed
  }

  function renderNotFound() {
    const tpl = document.getElementById('tpl-404');
    root().innerHTML = '';
    if (tpl) {
      root().appendChild(tpl.content.cloneNode(true));
      if (typeof applyTheme === 'function') applyTheme();
      if (typeof applyAccent === 'function') applyAccent();
    } else {
      // Fallback in case the template is ever missing from the page.
      root().innerHTML = `
        <div class="route-error">
          <div class="route-error-glyph">404</div>
          <h1>This room doesn't exist</h1>
          <p>The page you're looking for was moved, deleted, or never existed.</p>
          <a href="/" data-link class="no-accent">Back to Nyxie</a>
        </div>`;
    }
    current = null;
  }

  async function render(path) {
    const matched = matchRoute(path);
    if (!matched) { renderNotFound(); return; }
    const { route, params } = matched;

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
      try { route.init(params); } catch (e) { console.error('View init error:', e); }
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
