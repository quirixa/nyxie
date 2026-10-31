// developer.js — the Developer workspace (Feedback & Issues).
//
// Same pattern as admin.js/marketplace.js: a classic script sharing the
// global scope with dashboard.js/state.js/utils.js (token, currentUser,
// logout(), toast(), escapeHtml()). It only talks to /api/developer and the
// attachment download endpoint. Showing/hiding this panel is cosmetic — every
// one of those endpoints re-checks the caller's role (and, for security
// reports, the explicit SECURITY_REPORTS permission) on the server.
//
// Everything user-written (titles, descriptions, notes, names, links) goes
// through escapeHtml() before it touches innerHTML, and no user text is ever
// placed inside an inline event handler: rows carry data-* attributes and one
// delegated listener handles clicks.

const _dev = {
  built: false,
  panel: null,                      // the #developer-panel element devBuild() populated
  handlers: null,                   // listeners devBuild() attached, so destroy can remove them
  session: 0,                       // bumped on every init/destroy; stale async work checks it
  tab: 'overview',                  // overview | all | bug | feature | general | security
  filters: { q: '', status: '', priority: '', assignee: '', sort: 'newest' },
  page: 1,
  list: null,                       // last list response
  overview: null,
  days: 30,
  staff: [],
  detail: null,                     // open report (full detail) or null
  loadToken: 0,
  searchTimer: null,
};

const DEV_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'all', label: 'All Reports' },
  { id: 'bug', label: 'Bug Reports' },
  { id: 'feature', label: 'Feature Requests' },
  { id: 'general', label: 'General Feedback' },
  { id: 'security', label: 'Security Reports' },
];
const DEV_STATUS = {
  OPEN: 'Open', UNDER_REVIEW: 'Under review', PLANNED: 'Planned', IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved', CLOSED: 'Closed', DECLINED: 'Declined',
};
const DEV_PRIORITY = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', URGENT: 'Urgent' };
const DEV_CATEGORY = { BUG: 'Bug', FEATURE: 'Feature request', GENERAL: 'General feedback', SECURITY: 'Security' };

async function devRequest(method, path, body) {
  const res = await fetch('/api/developer' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong');
    err.code = data.code; err.status = res.status;
    throw err;
  }
  return data;
}

const devEsc = v => escapeHtml(v);
function devWhen(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
function devAgo(ts) {
  const s = Math.max(Math.floor((Date.now() - ts) / 1000), 0);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString();
}
const devStatusPill = s => `<span class="mp-row-status dev-st dev-st-${devEsc(String(s).toLowerCase())}">${devEsc(DEV_STATUS[s] || s)}</span>`;
const devPriorityPill = p => `<span class="dev-pr dev-pr-${devEsc(String(p).toLowerCase())}"><i></i>${devEsc(DEV_PRIORITY[p] || p)}</span>`;

// ── Panel skeleton ──────────────────────────────────────────────────
function devBuild() {
  const panel = document.getElementById('developer-panel');
  panel.innerHTML = `
    <div class="mp-view" id="dev-view">
      <div class="mp-header">
        <span class="mp-title">Developer</span>
        <button class="icon-btn" data-act="close" title="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="mp-tabs" id="dev-tabs"></div>
      <div class="mp-toolbar dev-toolbar" id="dev-toolbar" style="display:none;">
        <input type="search" class="dev-search" id="dev-search" placeholder="Search by ID or title" maxlength="100" autocomplete="off">
        <select class="mp-select" id="dev-f-status" data-filter="status">
          <option value="">Any status</option>
          ${Object.entries(DEV_STATUS).map(([k, v]) => `<option value="${k}">${devEsc(v)}</option>`).join('')}
        </select>
        <select class="mp-select" id="dev-f-priority" data-filter="priority">
          <option value="">Any priority</option>
          ${Object.entries(DEV_PRIORITY).map(([k, v]) => `<option value="${k}">${devEsc(v)}</option>`).join('')}
        </select>
        <select class="mp-select" id="dev-f-assignee" data-filter="assignee">
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
        </select>
        <select class="mp-select" id="dev-f-sort" data-filter="sort">
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="priority">Priority</option>
          <option value="updated">Recently updated</option>
        </select>
      </div>
      <div class="mp-body" id="dev-body"><div class="mp-empty">Loading…</div></div>
      <div class="mp-pagination" id="dev-pagination" style="display:none;"></div>
    </div>`;
  // Named handlers so destroyDeveloperPanel() can detach exactly what was
  // attached here — nothing is ever added twice to the same element.
  const handlers = {
    click: devOnClick,
    keydown: e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.dev-row')) { e.preventDefault(); devOnClick(e); }
    },
    change: devOnChange,
    input: e => {
      if (e.target.id !== 'dev-search') return;
      clearTimeout(_dev.searchTimer);
      _dev.searchTimer = setTimeout(() => { _dev.filters.q = e.target.value.trim(); _dev.page = 1; devLoadList(); }, 250);
    },
  };
  for (const [type, fn] of Object.entries(handlers)) panel.addEventListener(type, fn);
  _dev.panel = panel;
  _dev.handlers = handlers;
  _dev.built = true;
}

// True while `el` still belongs to the Developer panel that is currently on
// screen. Async work started before the user left the section (or before the
// dashboard was re-mounted by the router) must not touch the DOM afterwards.
function devAlive(el) {
  return !!(el && el.isConnected && _dev.panel && _dev.panel.isConnected && _dev.panel.contains(el));
}

async function initDeveloperPanel() {
  const panel = document.getElementById('developer-panel');
  if (!panel) return;
  // The router re-clones the dashboard template on every full navigation
  // (including browser back/forward), which gives us a brand-new, empty
  // #developer-panel. A bare "built" flag would then skip the build and
  // leave the panel blank, so build whenever the panel we populated is not
  // the one in the document, or has lost its markup.
  if (!_dev.built || _dev.panel !== panel || !panel.querySelector('#dev-view')) {
    devDetach();
    devBuild();
  }
  const session = ++_dev.session;
  _dev.detail = null;
  try {
    const [ov, st] = await Promise.all([devRequest('GET', '/overview?days=' + _dev.days), devRequest('GET', '/staff')]);
    if (session !== _dev.session || !devAlive(document.getElementById('dev-body'))) return;   // user already left
    _dev.overview = ov.overview;
    _dev.staff = st.staff;
  } catch (err) {
    if (session === _dev.session && devAlive(document.getElementById('dev-body'))) devRenderError(err);
    return;
  }
  devRenderTabs();
  devShowTab(_dev.tab);
}

// Remove the listeners devBuild() attached to the panel it built.
function devDetach() {
  if (_dev.panel && _dev.handlers) {
    for (const [type, fn] of Object.entries(_dev.handlers)) _dev.panel.removeEventListener(type, fn);
  }
  _dev.panel = null;
  _dev.handlers = null;
  _dev.built = false;
}

// Called by dashboard.js when the Developer panel stops being the visible
// view (showMainView) and when the dashboard itself is torn down. Cancels
// pending timers and in-flight loads and detaches listeners, so nothing from
// the workspace keeps running or can paint after the user has left it. The
// markup stays in the (hidden) panel; re-opening rebuilds it from scratch.
function destroyDeveloperPanel() {
  clearTimeout(_dev.searchTimer);
  _dev.searchTimer = null;
  _dev.session++;
  _dev.loadToken++;
  _dev.detail = null;
  const panel = _dev.panel;
  devDetach();
  if (panel) panel.innerHTML = '';
}

// ── Tabs ────────────────────────────────────────────────────────────
function devHasSecurity() { return !!(_dev.overview && 'SECURITY' in _dev.overview.by_category); }

function devTabCount(id) {
  if (id === 'overview') return null;
  if (_dev.list && _dev.list.counts && id in _dev.list.counts) return _dev.list.counts[id];
  const bc = _dev.overview && _dev.overview.by_category;
  if (!bc) return null;
  if (id === 'all') return _dev.overview.total;
  return bc[id.toUpperCase()];
}

function devRenderTabs() {
  const el = document.getElementById('dev-tabs');
  if (!el) return;
  if (_dev.tab === 'security' && !devHasSecurity()) _dev.tab = 'overview';
  el.innerHTML = DEV_TABS.filter(t => t.id !== 'security' || devHasSecurity()).map(t => {
    const c = devTabCount(t.id);
    return `<button class="mp-tab dev-tab ${_dev.tab === t.id ? 'active' : ''}" data-act="tab" data-tab="${t.id}">${devEsc(t.label)}${c == null ? '' : ` <span class="dev-count">${c}</span>`}</button>`;
  }).join('');
}

function devShowTab(id) {
  _dev.tab = id;
  _dev.detail = null;
  _dev.page = 1;
  devRenderTabs();
  const isQueue = id !== 'overview';
  document.getElementById('dev-toolbar').style.display = isQueue ? 'flex' : 'none';
  if (isQueue) devSyncToolbar();
  if (isQueue) devLoadList(); else devLoadOverview();
}

function devSyncToolbar() {
  document.getElementById('dev-search').value = _dev.filters.q;
  for (const k of ['status', 'priority', 'assignee', 'sort']) document.getElementById('dev-f-' + k).value = _dev.filters[k];
}

// ── Overview ────────────────────────────────────────────────────────
async function devLoadOverview() {
  const body = document.getElementById('dev-body');
  if (!body) return;
  const session = _dev.session;
  document.getElementById('dev-pagination').style.display = 'none';
  try {
    const ov = await devRequest('GET', '/overview?days=' + _dev.days);
    if (session !== _dev.session || !devAlive(body)) return;   // user left Developer meanwhile
    _dev.overview = ov.overview;
    devRenderTabs();
    body.innerHTML = devOverviewHtml(ov.overview);
  } catch (err) { if (session === _dev.session && devAlive(body)) devRenderError(err); }
}

function devReportMini(r) {
  return `<div class="dev-row dev-row-mini" tabindex="0" role="button" data-act="open" data-n="${Number(r.number)}">
    <div class="dev-row-main">
      <div class="dev-row-top"><span class="dev-id">${devEsc(r.display_id)}</span><span class="dev-title">${devEsc(r.title)}</span></div>
      <div class="dev-row-meta">${devEsc(DEV_CATEGORY[r.category] || r.category)} · ${devAgo(r.created_at)}</div>
    </div>
    <div class="dev-row-pills">${devStatusPill(r.status)}${devPriorityPill(r.priority)}</div>
  </div>`;
}

function devOverviewHtml(o) {
  if (!o.total) {
    return `<div class="mp-empty">No reports yet.<br><span class="dev-muted">Reports people send from Settings → Feedback will appear here.</span></div>`;
  }
  const card = (label, value, hint) => `<div class="dev-card"><div class="dev-card-value">${Number(value)}</div><div class="dev-card-label">${devEsc(label)}</div>${hint ? `<div class="dev-card-hint">${hint}</div>` : ''}</div>`;
  const cats = Object.entries(o.by_category);
  const max = Math.max(1, ...cats.map(([, n]) => n));
  return `
    <div class="dev-cards">
      ${card('Total reports', o.total)}
      ${card('Open', o.open, 'Not yet resolved or closed')}
      ${card('Awaiting review', o.awaiting_review, 'Status Open')}
      ${card('In progress', o.in_progress)}
      ${card('Resolved', o.resolved_in_period, `<select class="dev-days" id="dev-days" data-act-change="days">${[7, 30, 90, 365].map(d => `<option value="${d}" ${o.days === d ? 'selected' : ''}>last ${d} days</option>`).join('')}</select>`)}
      ${card('Needs attention', o.needs_attention, 'High/urgent, or unassigned for 3+ days')}
    </div>
    <div class="admin-section-label">By category</div>
    <div class="dev-bars">
      ${cats.map(([c, n]) => `<div class="dev-bar-row"><span class="dev-bar-label">${devEsc(DEV_CATEGORY[c] || c)}</span><span class="dev-bar"><i style="width:${Math.round((n / max) * 100)}%"></i></span><span class="dev-bar-n">${n}</span></div>`).join('')}
    </div>
    <div class="admin-section-label">Needs attention</div>
    ${o.attention.length ? o.attention.map(devReportMini).join('') : '<div class="mp-empty dev-empty-sm">Nothing needs attention.</div>'}
    <div class="admin-section-label">Recent reports</div>
    ${o.recent.map(devReportMini).join('')}`;
}

// ── Queue list ──────────────────────────────────────────────────────
function devListQuery() {
  const p = new URLSearchParams();
  p.set('queue', _dev.tab);
  for (const k of ['q', 'status', 'priority', 'assignee']) if (_dev.filters[k]) p.set(k, _dev.filters[k]);
  p.set('sort', _dev.filters.sort);
  p.set('page', String(_dev.page));
  p.set('page_size', '25');
  return p.toString();
}

async function devLoadList() {
  const body = document.getElementById('dev-body');
  if (!body) return;
  const token_ = ++_dev.loadToken;
  body.innerHTML = '<div class="mp-empty">Loading…</div>';
  try {
    const data = await devRequest('GET', '/reports?' + devListQuery());
    if (token_ !== _dev.loadToken || !devAlive(body)) return;   // superseded, or the user left Developer
    _dev.list = data;
    devRenderTabs();
    body.innerHTML = data.reports.length
      ? data.reports.map(devRowHtml).join('')
      : `<div class="mp-empty">${_dev.filters.q || _dev.filters.status || _dev.filters.priority || _dev.filters.assignee ? 'No reports match these filters.' : 'No reports in this queue yet.'}</div>`;
    devRenderPagination(data);
  } catch (err) {
    if (token_ === _dev.loadToken && devAlive(body)) devRenderError(err);
  }
}

function devRowHtml(r) {
  const assignee = r.assignee ? devEsc(r.assignee.display_name) : '<span class="dev-muted">Unassigned</span>';
  return `<div class="dev-row" tabindex="0" role="button" data-act="open" data-n="${Number(r.number)}">
    <div class="dev-row-main">
      <div class="dev-row-top"><span class="dev-id">${devEsc(r.display_id)}</span><span class="dev-title">${devEsc(r.title)}</span></div>
      <div class="dev-row-meta">
        <span>${devEsc(DEV_CATEGORY[r.category] || r.category)}</span>
        <span>Submitted ${devEsc(devWhen(r.created_at))}</span>
        <span>Updated ${devAgo(r.updated_at)}</span>
        <span>Reporter <code>${devEsc(r.reporter_ref)}</code></span>
        <span>${assignee}</span>
        <span>${Number(r.note_count)} note${r.note_count === 1 ? '' : 's'} · ${Number(r.activity_count)} event${r.activity_count === 1 ? '' : 's'}</span>
      </div>
    </div>
    <div class="dev-row-pills">${devStatusPill(r.status)}${devPriorityPill(r.priority)}</div>
  </div>`;
}

function devRenderPagination(d) {
  const el = document.getElementById('dev-pagination');
  if (d.total_pages <= 1) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.innerHTML = `<button class="btn-cancel" data-act="page" data-dir="-1" ${d.page <= 1 ? 'disabled' : ''}>Prev</button>
    <span>Page ${d.page} of ${d.total_pages} · ${d.total} report${d.total === 1 ? '' : 's'}</span>
    <button class="btn-cancel" data-act="page" data-dir="1" ${d.page >= d.total_pages ? 'disabled' : ''}>Next</button>`;
}

function devRenderError(err) {
  const body = document.getElementById('dev-body');
  if (!body) return;
  document.getElementById('dev-pagination').style.display = 'none';
  body.innerHTML = `<div class="mp-empty">Couldn’t load this: ${devEsc(err.message || 'unknown error')}<br><button class="btn-cancel dev-retry" data-act="retry">Try again</button></div>`;
}

// ── Report details ──────────────────────────────────────────────────
async function devOpenReport(n) {
  const body = document.getElementById('dev-body');
  if (!body) return;
  const session = _dev.session;
  document.getElementById('dev-toolbar').style.display = 'none';
  document.getElementById('dev-pagination').style.display = 'none';
  body.innerHTML = '<div class="mp-empty">Loading…</div>';
  try {
    const d = await devRequest('GET', '/reports/' + n);
    if (session !== _dev.session || !devAlive(body)) return;   // user left Developer meanwhile
    _dev.detail = d.report;
    body.innerHTML = devDetailHtml(d.report);
    body.scrollTop = 0;
  } catch (err) {
    if (session !== _dev.session || !devAlive(body)) return;
    _dev.detail = null;
    devRenderError(err);
  }
}

function devStaffName(id) {
  if (!id) return 'nobody';
  const s = _dev.staff.find(x => x.id === id);
  return s ? s.display_name : 'someone';
}

function devEventText(e) {
  switch (e.type) {
    case 'CREATED': return 'Report submitted';
    case 'STATUS': return `Status changed: ${DEV_STATUS[e.from] || e.from} → ${DEV_STATUS[e.to] || e.to}${e.body ? ` (${e.body})` : ''}`;
    case 'PRIORITY': return `Priority changed: ${DEV_PRIORITY[e.from] || e.from} → ${DEV_PRIORITY[e.to] || e.to}`;
    case 'ASSIGNEE': return e.to ? `Assigned to ${devStaffName(e.to)}${e.from ? ` (was ${devStaffName(e.from)})` : ''}` : `Unassigned (was ${devStaffName(e.from)})`;
    case 'NOTE': return 'Internal note';
    case 'DUPLICATE': return e.to ? `Marked as duplicate of ${e.to}` : `Duplicate link to ${e.from} removed`;
    case 'RELATED': return e.to ? `Linked to related report ${e.to}` : `Related link to ${e.from} removed`;
    case 'LINK': return e.to ? 'Development link set' : 'Development link removed';
    case 'ATTACHMENT': return 'Attachment added by the reporter';
    default: return e.type;
  }
}

function devDetailHtml(r) {
  const opts = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${devEsc(v)}</option>`).join('');
  const statusOpts = [r.status, ...r.allowed_transitions].map(k => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${devEsc(DEV_STATUS[k])}</option>`).join('');
  const assigneeOpts = `<option value="">Unassigned</option>` + _dev.staff.map(s => `<option value="${devEsc(s.id)}" ${r.assignee && r.assignee.id === s.id ? 'selected' : ''}>${devEsc(s.display_name)}${s.role === 'ADMIN' ? ' (admin)' : ''}</option>`).join('');
  const linkHtml = r.linked
    ? `<a href="${devEsc(r.linked.url)}" target="_blank" rel="noopener noreferrer">${devEsc(r.linked.url)}</a> <span class="dev-muted">(${r.linked.kind === 'PULL_REQUEST' ? 'pull request' : r.linked.kind === 'ISSUE' ? 'issue' : 'link'})</span>`
    : '<span class="dev-muted">None</span>';
  const events = r.events.slice().reverse().map(e => `
    <div class="dev-event ${e.type === 'NOTE' ? 'dev-event-note' : ''}">
      <div class="dev-event-head"><b>${devEsc(devEventText(e))}</b><span class="dev-muted">${devEsc(e.actor ? e.actor.display_name : 'Reporter')} · ${devEsc(devWhen(e.created_at))}</span></div>
      ${e.type === 'NOTE' ? `<div class="dev-note-body">${devEsc(e.body)}</div>` : ''}
    </div>`).join('');
  const rel = r.relations.length
    ? r.relations.map(x => `<div class="dev-rel">
        <a href="#" data-act="open" data-n="${Number(x.number)}">${devEsc(x.display_id)}</a> ${devEsc(x.title)}
        <span class="dev-muted">${x.kind === 'DUPLICATE' ? (x.direction === 'out' ? 'this is a duplicate of it' : 'duplicate of this') : 'related'} · ${devEsc(DEV_STATUS[x.status] || x.status)}</span>
        <button class="dev-x" data-act="unlink" data-n="${Number(x.number)}" title="Remove link" aria-label="Remove link">×</button>
      </div>`).join('')
    : '<span class="dev-muted">None</span>';
  const atts = r.attachments.length
    ? r.attachments.map(a => `<button class="btn-cancel dev-att" data-act="download" data-id="${devEsc(a.id)}" data-name="${devEsc(a.original_name)}">${devEsc(a.original_name)} <span class="dev-muted">${Math.max(1, Math.round(a.size / 1024))} KB</span></button>`).join('')
    : '<span class="dev-muted">None</span>';
  const reporter = r.reporter
    ? `${devEsc(r.reporter.display_name)} <span class="dev-muted">(@${devEsc(r.reporter.username)})</span>`
    : `<code>${devEsc(r.reporter_ref)}</code> <span class="dev-muted">(identity hidden)</span>`;

  return `
    <div class="dev-detail" data-n="${Number(r.number)}" data-version="${Number(r.version)}">
      <button class="btn-cancel dev-back" data-act="back">← Back</button>
      <div class="dev-detail-head">
        <div><span class="dev-id">${devEsc(r.display_id)}</span> <span class="dev-detail-title">${devEsc(r.title)}</span></div>
        <div class="dev-row-pills">${devStatusPill(r.status)}${devPriorityPill(r.priority)}<span class="dev-cat">${devEsc(DEV_CATEGORY[r.category] || r.category)}</span></div>
      </div>

      <div class="dev-controls">
        <label>Status<select class="mp-select" data-field="status">${statusOpts}</select></label>
        <label>Priority<select class="mp-select" data-field="priority">${opts(DEV_PRIORITY, r.priority)}</select></label>
        <label>Assignee<select class="mp-select" data-field="assignee_id">${assigneeOpts}</select></label>
      </div>

      <div class="dev-meta">
        <div><span>Reporter</span>${reporter}</div>
        <div><span>Submitted</span>${devEsc(devWhen(r.created_at))}</div>
        <div><span>Last updated</span>${devEsc(devWhen(r.updated_at))}</div>
        <div><span>App version</span>${r.app_version ? devEsc(r.app_version) : '<span class="dev-muted">Not provided</span>'}</div>
        <div><span>Platform</span>${r.platform ? devEsc(r.platform) : '<span class="dev-muted">Not provided</span>'}</div>
        <div><span>Resolved</span>${r.resolved_at ? devEsc(devWhen(r.resolved_at)) : '<span class="dev-muted">—</span>'}</div>
      </div>

      <div class="admin-section-label">Description</div>
      <div class="admin-note-box">${devEsc(r.description)}</div>

      <div class="admin-section-label">Diagnostics <span class="dev-muted">(only if the reporter chose to send them)</span></div>
      ${r.diagnostics ? `<div class="admin-note-box">${devEsc(r.diagnostics)}</div>` : '<div class="dev-muted dev-pad">None provided.</div>'}

      <div class="admin-section-label">Attachments</div>
      <div class="dev-atts">${atts}</div>

      <div class="admin-section-label">Development link</div>
      <div class="dev-pad">${linkHtml}</div>
      <div class="dev-inline">
        <input type="url" class="dev-input" id="dev-link-input" placeholder="https://github.com/owner/repo/issues/123" maxlength="300" value="${r.linked ? devEsc(r.linked.url) : ''}">
        <button class="btn-primary" data-act="save-link">Save link</button>
        ${r.linked ? '<button class="btn-cancel" data-act="clear-link">Remove</button>' : ''}
      </div>

      <div class="admin-section-label">Related &amp; duplicate reports</div>
      <div class="dev-pad">${rel}</div>
      <div class="dev-inline">
        <input type="text" class="dev-input dev-input-sm" id="dev-rel-input" placeholder="NYX-12" maxlength="14">
        <button class="btn-cancel" data-act="add-dup">Mark as duplicate of</button>
        <button class="btn-cancel" data-act="add-rel">Link as related</button>
      </div>

      <div class="admin-section-label">Internal notes <span class="dev-muted">(staff only — never shown to the reporter)</span></div>
      <textarea class="dev-input dev-textarea" id="dev-note-input" maxlength="4000" placeholder="Write an internal note…"></textarea>
      <div class="dev-inline"><button class="btn-primary" data-act="add-note">Add note</button></div>

      <div class="admin-section-label">Activity</div>
      <div class="dev-events">${events}</div>
    </div>`;
}

// ── Actions ─────────────────────────────────────────────────────────
function devCurrent() {
  const el = document.querySelector('#dev-body .dev-detail');
  return el ? { n: Number(el.dataset.n), version: Number(el.dataset.version) } : null;
}

async function devMutate(fn, okMsg) {
  const cur = devCurrent();
  if (!cur) return;
  try {
    await fn(cur);
    if (okMsg) toast(okMsg);
  } catch (err) {
    toast(err.message || 'Something went wrong', true);
  }
  await devOpenReport(cur.n);                         // always re-read the persisted state
}

async function devOnChange(e) {
  const t = e.target;
  if (t.dataset && t.dataset.actChange === 'days') { _dev.days = Number(t.value) || 30; return devLoadOverview(); }
  if (t.dataset && t.dataset.filter) {
    _dev.filters[t.dataset.filter] = t.value; _dev.page = 1;
    return devLoadList();
  }
  if (t.dataset && t.dataset.field) {
    const field = t.dataset.field;
    const value = field === 'assignee_id' && t.value === '' ? null : t.value;
    return devMutate(cur => devRequest('PATCH', '/reports/' + cur.n, { [field]: value, expected_version: cur.version }), 'Saved');
  }
}

async function devOnClick(e) {
  const el = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!el || !document.getElementById('developer-panel').contains(el)) return;
  const act = el.dataset.act;
  if (act === 'close') return navigateTo('home');
  if (act === 'tab') return devShowTab(el.dataset.tab);
  if (act === 'open') { e.preventDefault(); return devOpenReport(Number(el.dataset.n)); }
  if (act === 'retry') return _dev.detail ? devOpenReport(_dev.detail.number) : devShowTab(_dev.tab);
  if (act === 'page') { _dev.page = Math.max(1, _dev.page + Number(el.dataset.dir)); return devLoadList(); }
  if (act === 'back') {
    _dev.detail = null;
    if (_dev.tab === 'overview') return devLoadOverview();
    document.getElementById('dev-toolbar').style.display = 'flex';
    return devLoadList();
  }
  if (act === 'download') return devDownload(el.dataset.id, el.dataset.name);

  if (act === 'add-note') {
    const input = document.getElementById('dev-note-input');
    const text = input.value.trim();
    if (!text) return toast('Write something first', true);
    return devMutate(cur => devRequest('POST', `/reports/${cur.n}/notes`, { body: text }), 'Note added');
  }
  if (act === 'save-link' || act === 'clear-link') {
    const url = act === 'clear-link' ? null : document.getElementById('dev-link-input').value.trim();
    if (act === 'save-link' && !url) return toast('Enter a link first', true);
    return devMutate(cur => devRequest('PUT', `/reports/${cur.n}/link`, { url }), act === 'save-link' ? 'Link saved' : 'Link removed');
  }
  if (act === 'add-dup' || act === 'add-rel') {
    const v = document.getElementById('dev-rel-input').value.trim();
    if (!v) return toast('Enter a report ID, e.g. NYX-12', true);
    return devMutate(cur => act === 'add-dup'
      ? devRequest('POST', `/reports/${cur.n}/duplicates`, { of: v })
      : devRequest('POST', `/reports/${cur.n}/related`, { with: v }), 'Linked');
  }
  if (act === 'unlink') {
    const other = Number(el.dataset.n);
    return devMutate(cur => devRequest('DELETE', `/reports/${cur.n}/relations/${other}`), 'Link removed');
  }
}

// Attachments are only reachable with the caller's token, so they are fetched
// and saved from a blob rather than linked.
async function devDownload(id, name) {
  try {
    const res = await fetch('/api/reports/attachments/' + encodeURIComponent(id) + '/download', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('Could not download this file');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name || 'attachment';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) { toast(err.message, true); }
}
