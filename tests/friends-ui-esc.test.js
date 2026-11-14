// 0.12.1: Friends UI rules (no new main-sidebar items, Add Friend layout/green)
// and ESC as the global default theme. Runs the real theme.js and the real markup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const THEME_JS = fs.readFileSync(path.join(ROOT, 'public/js/theme.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public/css/dashboard.css'), 'utf8');
const app = () => new JSDOM(HTML).window.document.querySelector('#tpl-app').content;

test('main sidebar has no Add Friend / Message Requests / Pending items; they live inside Friends', () => {
  const root = app();
  const labels = [...root.querySelectorAll('#sidebar-nav .nav-item')].map(e => e.textContent.trim().replace(/\s+/g, ' '));
  for (const bad of ['Add Friend', 'Message Requests', 'Pending']) assert.ok(!labels.some(l => l.includes(bad)), bad + ' must not be a sidebar item: ' + labels);
  assert.ok(labels.some(l => l.startsWith('Friends')));
  const tabs = [...root.querySelectorAll('#friends-panel .friends-tab-bar .ftab')].map(e => e.textContent.trim());
  for (const t of ['Online', 'All', 'Add Friend']) assert.ok(tabs.some(x => x.startsWith(t)), t);
  assert.ok(!tabs.some(x => x.startsWith('Message Requests')), 'Message Requests is not a tab; it lives in the header inbox');
  assert.ok(root.querySelector('#friends-header #inbox-btn') && root.querySelector('#friends-header #inbox-badge'));
  assert.equal(root.querySelector('#ftab-blocked').style.display, 'none', 'Blocked is hidden until someone is blocked');
});

test('Add Friend: one bordered form holds username, divider and 120-char message; green button/tab', () => {
  const root = app();
  const form = root.querySelector('#add-friend-form');
  assert.ok(form.querySelector('#add-friend-input') && form.querySelector('#add-friend-send'));
  assert.ok(form.querySelector('.af-divider') && form.querySelector('#add-friend-note') && form.querySelector('#add-friend-note-count'));
  assert.equal(form.querySelector('#add-friend-note').getAttribute('maxlength'), '120');
  assert.ok(root.querySelector('#add-friend-view .af-illustration'));
  assert.match(root.querySelector('#add-friend-view').textContent, /Explore Discoverable Servers/);
  assert.match(root.querySelector('#add-friend-view').textContent, /Don't have a username on hand\?/);
  assert.match(CSS, /\.add-friend-btn[^{]*\{[^}]*#248046/);
  assert.match(CSS, /\.ftab\.ftab-add[^{]*\{[^}]*#248046/);
});

function runTheme(stored) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  if (stored !== undefined) dom.window.localStorage.setItem('theme', stored);
  dom.window.eval(THEME_JS);
  dom.window.eval('applyTheme()');
  return [...dom.window.document.body.classList].filter(c => c.startsWith('theme-'));
}

test('ESC is the default; explicit and valid choices are respected; junk falls back to ESC', () => {
  assert.deepEqual(runTheme(undefined), ['theme-esc']);
  assert.deepEqual(runTheme('garbage'), ['theme-esc']);
  for (const t of ['light', 'dark', 'esc', 'retro']) assert.deepEqual(runTheme(t), ['theme-' + t]);
  assert.ok(HTML.includes('<body class="theme-esc">'));
  assert.match(HTML, /theme-preview-card active" data-theme="esc"/);
  assert.doesNotMatch(HTML, /theme-preview-card active" data-theme="dark"/);
});
