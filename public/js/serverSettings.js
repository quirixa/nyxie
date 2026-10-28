// serverSettings.js — Discord-style Server Settings (0.2.0).
//
// A full-screen panel mounted over the dashboard. It never changes the URL,
// the selected server, the open channel or the DM state, so closing it
// returns to exactly the view it was opened from. Sections live in this file
// (Overview, Members) and serverSettingsPanels.js (Roles, Channels,
// Moderation, Audit Log) and register themselves on window.ServerSettings.
//
// Security note: everything here is presentation. Hiding or disabling a
// control is a convenience only — every action is re-authorised by the
// server (see server/routes/servers.js and serverSettings.js).
(function () {
  'use strict';

  const P = Object.freeze({
    VIEW: 1, SEND: 2, CHANNELS: 4, SERVER: 8, MEMBERS: 16, INVITES: 32, KICK: 64, BAN: 128,
    MESSAGES: 256, ROLES: 512, ADMIN: 1024, AUDIT: 2048, TIMEOUT: 4096, HISTORY: 8192, ATTACH: 16384
  });

  const state = { server: null, hooks: {}, section: null, root: null, active: null, open: false, lastFocus: null };
  const SS = (window.ServerSettings = { P, sections: {}, order: ['overview', 'members', 'roles', 'channels', 'moderation', 'audit'] });

  // ─── helpers ──────────────────────────────────────────────────
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // Null-safe: a request can finish after the panel was closed.
  const $ = (sel, el) => { const r = el || state.root; return r ? r.querySelector(sel) : null; };
  const setText = (sel, text) => { const e = $(sel); if (e) e.textContent = text; };
  const sid = () => state.server && state.server.id;
  const isOwner = () => !!(state.server && state.server.is_owner);
  const mask = () => (state.server && state.server.my_permissions) | 0;
  // Owner and ADMINISTRATOR have every permission (same rule as the server).
  const has = bit => isOwner() || (mask() & P.ADMIN) !== 0 || (mask() & bit) !== 0;
  const myRank = () => (state.server && state.server.my_role && Number.isFinite(state.server.my_role.position) ? state.server.my_role.position : -1);
  const fmtDate = ts => (ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  const fmtDateTime = ts => (ts ? new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

  // Uses the app's authenticated request helper (state.js `api`). It returns
  // parsed JSON (including { error } bodies) or null on a network failure.
  async function call(method, path, body) {
    if (typeof api !== 'function') return { ok: false, error: 'Not connected' };
    const data = await api(method, path, body);
    if (!data) return { ok: false, error: 'Network error — please try again' };
    if (data.error) return { ok: false, error: data.error, data };
    return { ok: true, data };
  }
  const notify = (msg, isError) => { try { toast(msg, isError); } catch (_) {} };

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // Runs `fn` while the button is disabled so double clicks cannot submit twice.
  async function busy(btn, fn) {
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;
    try { return await fn(); } finally { if (btn && btn.isConnected) btn.disabled = false; }
  }

  function avatarHtml(u, cls) {
    const name = u.display_name || u.username || '?';
    if (u.avatar) return `<span class="ssv-avatar ${cls || ''}"><img src="${esc(u.avatar)}" alt="" loading="lazy"></span>`;
    return `<span class="ssv-avatar ${cls || ''}" aria-hidden="true">${esc(name.trim().slice(0, 1).toUpperCase())}</span>`;
  }
  function roleChip(r) {
    const c = r.color && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : null;
    return `<span class="ssv-chip"><span class="ssv-dot" style="${c ? `background:${c}` : ''}"></span>${esc(r.name)}</span>`;
  }
  const loadingHtml = (t) => `<div class="ssv-state"><span class="ssv-spinner" aria-hidden="true"></span>${esc(t || 'Loading…')}</div>`;
  const emptyHtml = (t, sub) => `<div class="ssv-state ssv-empty"><strong>${esc(t)}</strong>${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;
  const errorHtml = (t) => `<div class="ssv-state ssv-error" role="alert"><strong>${esc(t || 'Something went wrong')}</strong><button class="ssv-btn" data-act="retry">Try again</button></div>`;
  function pagerHtml(p) {
    if (!p || p.total <= p.page_size) return '';
    const pages = Math.max(1, Math.ceil(p.total / p.page_size));
    return `<div class="ssv-pager"><button class="ssv-btn" data-act="page-prev" ${p.page <= 1 ? 'disabled' : ''}>Previous</button>
      <span>Page ${p.page} of ${pages} · ${p.total} total</span>
      <button class="ssv-btn" data-act="page-next" ${!p.has_more ? 'disabled' : ''}>Next</button></div>`;
  }

  // ─── in-app dialog (replaces window.confirm / prompt) ─────────
  // fields: { name, label, type: text|textarea|select|checkboxes|confirm|number, value, options,
  //           required, maxlength, placeholder, help, match }
  // Resolves to a values object, or null if cancelled.
  function dialog(opts) {
    return new Promise(resolve => {
      const back = document.createElement('div');
      back.className = 'ssv-backdrop';
      const fields = opts.fields || [];
      const fieldHtml = f => {
        const id = 'ssvf-' + f.name;
        let input = '';
        if (f.type === 'textarea') input = `<textarea id="${id}" maxlength="${f.maxlength || 300}" placeholder="${esc(f.placeholder || '')}" rows="3">${esc(f.value || '')}</textarea>`;
        else if (f.type === 'select') input = `<select id="${id}">${f.options.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
        else if (f.type === 'checkboxes') input = `<div class="ssv-checklist" id="${id}">${f.options.map(o => `<label class="ssv-check ${o.disabled ? 'is-disabled' : ''}"><input type="checkbox" value="${esc(o.value)}" ${o.checked ? 'checked' : ''} ${o.disabled ? 'disabled' : ''}><span>${o.html || esc(o.label)}</span>${o.note ? `<em>${esc(o.note)}</em>` : ''}</label>`).join('') || '<div class="ssv-muted">Nothing to choose from.</div>'}</div>`;
        else input = `<input id="${id}" type="${f.type === 'number' ? 'number' : 'text'}" maxlength="${f.maxlength || 100}" value="${esc(f.value == null ? '' : f.value)}" placeholder="${esc(f.placeholder || '')}" autocomplete="off">`;
        return `<div class="ssv-field"><label for="${id}">${esc(f.label)}</label>${input}${f.help ? `<div class="ssv-help">${esc(f.help)}</div>` : ''}</div>`;
      };
      back.innerHTML = `<div class="ssv-dialog" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
        <h3>${esc(opts.title)}</h3>
        ${opts.message ? `<p>${esc(opts.message)}</p>` : ''}
        ${fields.map(fieldHtml).join('')}
        <div class="ssv-dialog-actions">
          <button class="ssv-btn" data-d="cancel">${esc(opts.cancelText || 'Cancel')}</button>
          <button class="ssv-btn ${opts.danger ? 'ssv-btn-danger' : 'ssv-btn-primary'}" data-d="ok">${esc(opts.confirmText || 'Confirm')}</button>
        </div></div>`;
      (state.root || document.body).appendChild(back);
      const ok = back.querySelector('[data-d=ok]');
      const read = () => {
        const out = {};
        for (const f of fields) {
          const el = back.querySelector('#ssvf-' + f.name);
          if (f.type === 'checkboxes') out[f.name] = [...el.querySelectorAll('input:checked')].map(i => i.value);
          else out[f.name] = (el.value || '').trim();
        }
        return out;
      };
      const valid = () => {
        const v = read();
        return fields.every(f => {
          if (f.type === 'confirm') return v[f.name] === f.match;
          if (f.required) return !!v[f.name];
          return true;
        });
      };
      const sync = () => { ok.disabled = !valid(); };
      const done = val => { document.removeEventListener('keydown', onKey, true); back.remove(); resolve(val); };
      const onKey = e => {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(null); }
        else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && !ok.disabled) { e.preventDefault(); done(read()); }
      };
      document.addEventListener('keydown', onKey, true);
      back.addEventListener('input', sync);
      back.addEventListener('change', sync);
      back.addEventListener('click', e => {
        if (e.target === back || e.target.closest('[data-d=cancel]')) done(null);
        else if (e.target.closest('[data-d=ok]') && !ok.disabled) done(read());
      });
      sync();
      const first = back.querySelector('input:not([type=checkbox]),textarea,select') || ok;
      first.focus();
    });
  }
  const confirmDialog = o => dialog(o).then(v => v !== null);

  // ─── navigation / unsaved changes ─────────────────────────────
  function allowedSections() {
    const out = ['overview'];
    if (has(P.MEMBERS) || has(P.ROLES) || has(P.KICK) || has(P.BAN) || has(P.TIMEOUT)) out.push('members');
    if (has(P.ROLES)) out.push('roles');
    if (has(P.CHANNELS)) out.push('channels');
    if (has(P.BAN) || has(P.TIMEOUT)) out.push('moderation');
    if (has(P.AUDIT)) out.push('audit');
    return out;
  }
  SS.canOpen = function (server) {
    if (!server) return false;
    const prev = state.server; state.server = server;
    const ok = isOwner() || allowedSections().length > 1;
    state.server = prev;
    return ok;
  };

  async function guard() {
    if (state.active && state.active.dirty && state.active.dirty()) {
      return confirmDialog({ title: 'Unsaved changes', message: 'You have changes that haven’t been saved. Discard them?', confirmText: 'Discard changes', cancelText: 'Keep editing', danger: true });
    }
    return true;
  }

  async function show(name, { force } = {}) {
    if (!allowedSections().includes(name)) name = 'overview';
    if (!force && name === state.section) return;
    if (!force && !(await guard())) return;
    state.section = name;
    state.active = SS.sections[name];
    state.root.querySelectorAll('.ssv-nav-item').forEach(b => {
      const on = b.dataset.section === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    });
    const c = $('#ssv-content');
    if (!c) return;
    c.scrollTop = 0;
    $('#ssv-title').textContent = state.active.label;
    state.active.render(c);
  }

  function renderNav() {
    const nav = $('#ssv-nav');
    nav.innerHTML = SS.order.filter(n => allowedSections().includes(n)).map(n =>
      `<button type="button" class="ssv-nav-item" data-section="${n}">${SS.sections[n].icon || ''}<span>${esc(SS.sections[n].label)}</span></button>`).join('');
    $('#ssv-server-name').textContent = state.server.name;
  }

  async function open(server, hooks, section) {
    if (state.open) return;
    state.server = server; state.hooks = hooks || {}; state.open = true;
    state.lastFocus = document.activeElement;
    const root = document.createElement('div');
    root.id = 'server-settings-view';
    root.className = 'ssv-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Server settings');
    root.innerHTML = `
      <aside class="ssv-sidebar"><div class="ssv-sidebar-inner">
        <div class="ssv-server-name" id="ssv-server-name"></div>
        <nav id="ssv-nav" aria-label="Server settings sections"></nav>
      </div></aside>
      <main class="ssv-main">
        <header class="ssv-header"><h2 id="ssv-title"></h2>
          <button type="button" class="ssv-close" data-close aria-label="Close server settings" title="Close (Esc)"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </header>
        <div id="ssv-content" class="ssv-content"></div>
      </main>`;
    document.body.appendChild(root);
    state.root = root;
    document.body.classList.add('ssv-open');
    renderNav();

    root.addEventListener('click', async e => {
      if (e.target.closest('[data-close]')) return close();
      const nav = e.target.closest('.ssv-nav-item');
      if (nav) return show(nav.dataset.section);
      const t = e.target.closest('[data-act]');
      if (t && state.active && state.active.onClick) {
        if (t.dataset.act === 'retry') return state.active.render($('#ssv-content'));
        state.active.onClick(t.dataset.act, t, e);
      }
    });
    root.addEventListener('input', e => state.active && state.active.onInput && state.active.onInput(e.target, e));
    root.addEventListener('change', e => state.active && state.active.onChange && state.active.onChange(e.target, e));
    root.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !root.querySelector('.ssv-backdrop')) close();
    });
    window.addEventListener('popstate', onPop);
    await show(section || 'overview', { force: true });
    root.tabIndex = -1; root.focus();
  }

  async function close(force) {
    if (!state.open) return;
    if (!force && !(await guard())) return;
    window.removeEventListener('popstate', onPop);
    state.root.remove();
    document.body.classList.remove('ssv-open');
    state.open = false; state.active = null; state.section = null; state.root = null;
    if (state.lastFocus && state.lastFocus.focus) { try { state.lastFocus.focus(); } catch (_) {} }
  }
  function onPop() { close(true); }

  // Called by dashboard.js when its cached copy of this server changed
  // (permissions, name, membership) or a live event arrived.
  SS.syncServer = function (server) {
    if (!state.open || !server || server.id !== sid()) return;
    state.server = server;
    // Lost every management right (e.g. just handed over ownership): nothing
    // left to show here but a read-only overview, so close the panel.
    if (!SS.canOpen(server)) { close(true); return; }
    renderNav();
    if (!allowedSections().includes(state.section)) show('overview', { force: true });
    else if (state.root) { state.root.querySelectorAll('.ssv-nav-item').forEach(b => b.classList.toggle('active', b.dataset.section === state.section)); }
  };
  SS.isOpen = () => state.open;
  SS.serverId = () => sid();
  SS.destroy = () => close(true);
  // Live event from the websocket: refresh the visible section unless the
  // user is in the middle of editing it.
  SS.handleEvent = function (msg) {
    if (!state.open || !state.active) return;
    if (msg.server_id && msg.server_id !== sid()) return;
    if (state.active.dirty && state.active.dirty()) return;
    if (state.active.onLiveEvent) state.active.onLiveEvent(msg);
  };
  SS.open = open; SS.close = close; SS.show = show;
  SS.register = (name, def) => { SS.sections[name] = def; };
  SS.util = {
    esc, $, setText, sid, has, isOwner, myRank, mask, fmtDate, fmtDateTime, call, notify, debounce, busy, avatarHtml, roleChip,
    loadingHtml, emptyHtml, errorHtml, pagerHtml, dialog, confirmDialog,
    hooks: () => state.hooks, server: () => state.server, content: () => $('#ssv-content'), active: () => state.active,
    icon: {
      shield: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
    }
  };

  // ═══ Overview ═════════════════════════════════════════════════
  const ico = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ov = { orig: null, draft: null, categories: null, invites: null, invitesError: null };

  async function ovLoad() {
    const r = await call('GET', `/servers/${sid()}`);
    if (r.ok) { state.server = Object.assign({}, state.server, r.data.server); }
    if (!ov.categories) { const c = await call('GET', '/servers/categories'); ov.categories = c.ok ? c.data.categories || [] : []; }
    const s = state.server;
    ov.orig = { name: s.name, description: s.description || '', icon: s.icon || null, category: s.category || '', is_discoverable: !!s.is_discoverable };
    ov.draft = Object.assign({}, ov.orig);
    ov.iconBusy = false;
  }

  function ovChanged() {
    if (!ov.orig) return [];
    return Object.keys(ov.orig).filter(k => ov.orig[k] !== ov.draft[k]);
  }

  function ovRender(c) {
    c.innerHTML = loadingHtml();
    ovLoad().then(() => { if (state.section === 'overview') ovPaint(c); }).catch(() => { c.innerHTML = errorHtml('Could not load the server.'); });
  }

  function ovPaint(c) {
    if (!c) return;
    const s = state.server, d = ov.draft, can = has(P.SERVER);
    const initials = (d.name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    c.innerHTML = `
      <p class="ssv-lead">${can ? 'Update how your server looks and where it can be found.' : 'You can view this server’s details. You need the Manage Server permission to change them.'}</p>
      <section class="ssv-card">
        <div class="ssv-icon-row">
          <div class="ssv-server-icon" id="ov-icon">${d.icon ? `<img src="${esc(d.icon)}" alt="Server icon">` : esc(initials)}</div>
          <div class="ssv-icon-actions">
            <div class="ssv-strong">Server icon</div>
            <div class="ssv-help">PNG, JPG, GIF or WebP, up to 5 MB.</div>
            <div class="ssv-row">
              <button class="ssv-btn" data-act="icon-pick" ${can ? '' : 'disabled'}>Upload image</button>
              <button class="ssv-btn" data-act="icon-remove" ${can && d.icon ? '' : 'disabled'}>Remove</button>
              <input type="file" id="ov-icon-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
            </div>
          </div>
        </div>
        <div class="ssv-field"><label for="ov-name">Server name</label>
          <input id="ov-name" maxlength="50" value="${esc(d.name)}" ${can ? '' : 'disabled'}><div class="ssv-help" id="ov-name-count"></div></div>
        <div class="ssv-field"><label for="ov-desc">Description</label>
          <textarea id="ov-desc" maxlength="300" rows="3" ${can ? '' : 'disabled'}>${esc(d.description)}</textarea><div class="ssv-help" id="ov-desc-count"></div></div>
        <div class="ssv-field"><label for="ov-cat">Discovery category</label>
          <select id="ov-cat" ${can ? '' : 'disabled'}><option value="">No category</option>${ov.categories.map(k => `<option value="${esc(k.key)}" ${k.key === d.category ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}</select></div>
        <label class="ssv-toggle"><input type="checkbox" id="ov-disc" ${d.is_discoverable ? 'checked' : ''} ${can ? '' : 'disabled'}>
          <span class="ssv-switch" aria-hidden="true"></span><span><strong>Show in Discover</strong><em>Anyone can find and join this server from the Discover page.</em></span></label>
        <div class="ssv-error-line" id="ov-error" role="alert"></div>
      </section>
      <section class="ssv-card">
        <h3>About this server</h3>
        <dl class="ssv-meta">
          <div><dt>Members</dt><dd>${s.member_count != null ? esc(s.member_count) : '—'}</dd></div>
          <div><dt>Created</dt><dd>${esc(fmtDate(s.created_at))}</dd></div>
          <div><dt>Your role</dt><dd>${s.is_owner ? 'Owner' : esc((s.my_role && s.my_role.name) || 'Member')}</dd></div>
        </dl>
      </section>
      <div id="ov-invites"></div>
      <section class="ssv-card ssv-danger">
        <h3>Danger zone</h3>
        ${s.is_owner
          ? `<div class="ssv-danger-row"><div><strong>Transfer ownership</strong><div class="ssv-help">Hand the server to another member. You keep the roles you have (including Admin, if you hold it) but lose the owner-only powers. Choose “Make owner” on their row in Members.</div></div><button class="ssv-btn ssv-btn-danger-o" data-act="goto-members">Go to Members</button></div>
          <div class="ssv-danger-row" style="margin-top:14px"><div><strong>Delete this server</strong><div class="ssv-help">Permanently deletes every channel and message. This cannot be undone.</div></div><button class="ssv-btn ssv-btn-danger" data-act="delete-server">Delete server</button></div>`
          : `<div class="ssv-danger-row"><div><strong>Leave this server</strong><div class="ssv-help">You will need a new invite to come back.</div></div><button class="ssv-btn ssv-btn-danger" data-act="leave-server">Leave server</button></div>`}
      </section>
      <div class="ssv-savebar" id="ov-savebar" hidden><span>Careful — you have unsaved changes.</span>
        <div class="ssv-row"><button class="ssv-btn" data-act="ov-reset">Reset</button><button class="ssv-btn ssv-btn-primary" data-act="ov-save">Save changes</button></div></div>`;
    ovCounts(); ovBar(); ovInvites();
    const file = $('#ov-icon-file'); if (file) file.addEventListener('change', ovIconChosen);
  }

  function ovCounts() {
    const n = $('#ov-name'), d = $('#ov-desc');
    if (n) $('#ov-name-count').textContent = `${n.value.length}/50`;
    if (d) $('#ov-desc-count').textContent = `${d.value.length}/300`;
  }
  function ovBar() { const b = $('#ov-savebar'); if (b) b.hidden = ovChanged().length === 0; }

  async function ovIconChosen(e) {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return notify('Icon must be a PNG, JPG, GIF or WebP image', true);
    if (f.size > 5 * 1024 * 1024) return notify('Icon must be 5 MB or smaller', true);
    const fd = new FormData(); fd.append('file', f);
    try {
      const res = await fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
      const data = await res.json();
      if (!res.ok || !data.url) return notify(data.error || 'Upload failed', true);
      ov.draft.icon = data.url; ovPaint($('#ssv-content'));
    } catch (_) { notify('Upload failed — check your connection', true); }
  }

  async function ovSave(btn) {
    const changed = ovChanged();
    if (!changed.length) return;
    const body = {};
    changed.forEach(k => { body[k] = k === 'category' ? (ov.draft[k] || null) : ov.draft[k]; });
    if (body.name !== undefined && !String(body.name).trim()) { setText('#ov-error', 'Server name cannot be empty.'); return; }
    const r = await busy(btn, () => call('PATCH', `/servers/${sid()}`, body));
    if (!r) return;
    if (!r.ok) { setText('#ov-error', r.error); notify(r.error, true); return; }   // edits are kept
    state.server = Object.assign({}, state.server, r.data.server);
    await (state.hooks.onServerChanged && state.hooks.onServerChanged());
    renderNav(); await ovLoad(); ovPaint($('#ssv-content'));
    notify('Server updated');
  }

  async function ovInvites() {
    const box = $('#ov-invites'); if (!box) return;
    const canList = has(P.SERVER), canCreate = has(P.INVITES);
    if (!canList && !canCreate) { box.innerHTML = ''; return; }
    let rows = '';
    if (canList) {
      const r = await call('GET', `/servers/${sid()}/invites`);
      if (!$('#ov-invites')) return;
      if (!r.ok) rows = `<div class="ssv-state ssv-error">${esc(r.error)}</div>`;
      else {
        const list = r.data.invites || [];
        rows = list.length ? `<div class="ssv-table">${list.map(i => `<div class="ssv-trow">
          <div class="ssv-grow"><code>${esc(i.code)}</code><div class="ssv-help">${i.max_uses ? `${i.uses}/${i.max_uses} uses` : `${i.uses} uses`} · ${i.expires_at ? 'expires ' + esc(fmtDate(i.expires_at)) : 'never expires'}${i.revoked ? ' · revoked' : ''}${i.creator_display_name ? ' · by ' + esc(i.creator_display_name) : ''}</div></div>
          <button class="ssv-btn" data-act="invite-copy" data-code="${esc(i.code)}">Copy link</button>
          ${!i.revoked ? `<button class="ssv-btn" data-act="invite-revoke" data-code="${esc(i.code)}">Revoke</button>` : ''}</div>`).join('')}</div>` : emptyHtml('No invites yet');
      }
    }
    box.innerHTML = `<section class="ssv-card"><h3>Invite links</h3>
      ${canCreate ? `<div class="ssv-row ssv-wrap"><select id="inv-exp"><option value="0">Never expires</option><option value="3600">1 hour</option><option value="86400">1 day</option><option value="604800">7 days</option></select>
      <select id="inv-max"><option value="0">No use limit</option><option value="1">1 use</option><option value="5">5 uses</option><option value="25">25 uses</option><option value="100">100 uses</option></select>
      <button class="ssv-btn ssv-btn-primary" data-act="invite-create">Create invite</button></div>` : ''}${rows}</section>`;
  }

  SS.register('overview', {
    label: 'Overview', icon: ico('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
    render: ovRender,
    dirty: () => ovChanged().length > 0,
    onInput(t) {
      if (!ov.draft) return;
      if (t.id === 'ov-name') ov.draft.name = t.value;
      else if (t.id === 'ov-desc') ov.draft.description = t.value;
      else return;
      ovCounts(); ovBar();
    },
    onChange(t) {
      if (!ov.draft) return;
      if (t.id === 'ov-cat') ov.draft.category = t.value;
      else if (t.id === 'ov-disc') ov.draft.is_discoverable = t.checked;
      else return;
      ovBar();
    },
    async onClick(act, t) {
      if (act === 'icon-pick') $('#ov-icon-file').click();
      else if (act === 'icon-remove') { ov.draft.icon = null; ovPaint($('#ssv-content')); }
      else if (act === 'goto-members') show('members');
      else if (act === 'ov-reset') { ov.draft = Object.assign({}, ov.orig); ovPaint($('#ssv-content')); }
      else if (act === 'ov-save') ovSave(t);
      else if (act === 'invite-create') {
        await busy(t, async () => {
          const exp = parseInt($('#inv-exp').value, 10), max = parseInt($('#inv-max').value, 10);
          const r = await call('POST', `/servers/${sid()}/invites`, { expires_in_seconds: exp || undefined, max_uses: max || undefined });
          if (!r.ok) return notify(r.error, true);
          notify('Invite created'); ovInvites();
        });
      } else if (act === 'invite-copy') {
        const url = `${location.origin}/invite/${t.dataset.code}`;
        try { await navigator.clipboard.writeText(url); notify('Invite link copied'); } catch (_) { notify(url); }
      } else if (act === 'invite-revoke') {
        if (!(await confirmDialog({ title: 'Revoke invite?', message: 'People will no longer be able to join with this link.', confirmText: 'Revoke', danger: true }))) return;
        const r = await call('DELETE', `/invites/${t.dataset.code}`);
        if (!r.ok) return notify(r.error, true);
        notify('Invite revoked'); ovInvites();
      } else if (act === 'delete-server') {
        const v = await dialog({ title: 'Delete server', message: `This permanently deletes “${state.server.name}”, all of its channels and every message in them. Type the server name to confirm.`,
          fields: [{ name: 'confirm', label: 'Server name', type: 'confirm', match: state.server.name, placeholder: state.server.name }], confirmText: 'Delete server', danger: true });
        if (!v) return;
        const r = await call('DELETE', `/servers/${sid()}`, { confirm_name: v.confirm });
        if (!r.ok) return notify(r.error, true);
        notify('Server deleted');
        await close(true);
        state.hooks.onLeft && state.hooks.onLeft('deleted');
      } else if (act === 'leave-server') {
        if (!(await confirmDialog({ title: 'Leave server?', message: `You will leave “${state.server.name}”.`, confirmText: 'Leave server', danger: true }))) return;
        const r = await call('POST', `/servers/${sid()}/leave`);
        if (!r.ok) return notify(r.error, true);
        notify('You left the server');
        await close(true);
        state.hooks.onLeft && state.hooks.onLeft('left');
      }
    },
    onLiveEvent(msg) { if (msg.type === 'server_updated' || msg.type === 'server_member_left' || msg.type === 'server_member_joined') { if (!ovChanged().length) ovRender($('#ssv-content')); } }
  });

  // ═══ Members ══════════════════════════════════════════════════
  const mb = { page: 1, search: '', role: '', data: null, roles: [], loading: false, err: null };

  async function mbLoad() {
    const c = $('#mb-list'); if (!c) return;
    c.innerHTML = loadingHtml('Loading members…');
    const qs = `page=${mb.page}&page_size=20&search=${encodeURIComponent(mb.search)}${mb.role ? '&role_id=' + encodeURIComponent(mb.role) : ''}`;
    const r = await call('GET', `/servers/${sid()}/members?${qs}`);
    if (!$('#mb-list')) return;
    if (!r.ok) { $('#mb-list').innerHTML = errorHtml(r.error); return; }
    mb.data = r.data;
    const list = r.data.members;
    $('#mb-list').innerHTML = list.length ? `<div class="ssv-table">${list.map(mbRow).join('')}</div>${pagerHtml(r.data)}` : emptyHtml(mb.search || mb.role ? 'No members match your search' : 'No members');
  }

  function mbRow(m) {
    const a = m.actions || {};
    const now = Date.now();
    const timed = m.timeout_until && m.timeout_until > now;
    return `<div class="ssv-trow" data-uid="${esc(m.id)}">
      ${avatarHtml(m)}
      <div class="ssv-grow">
        <div class="ssv-name">${esc(m.display_name || m.username)}${m.is_owner ? ' <span class="ssv-tag">Owner</span>' : ''}${timed ? ` <span class="ssv-tag ssv-tag-warn" title="Until ${esc(fmtDateTime(m.timeout_until))}">Timed out</span>` : ''}</div>
        <div class="ssv-help">@${esc(m.username)} · Joined ${esc(fmtDate(m.joined_at))}</div>
        <div class="ssv-chips">${(m.roles || []).filter(r => !r.is_default).map(roleChip).join('') || '<span class="ssv-muted">No extra roles</span>'}</div>
      </div>
      <div class="ssv-actions">
        <button class="ssv-btn" data-act="m-profile">Profile</button>
        ${a.can_edit_roles ? '<button class="ssv-btn" data-act="m-roles">Roles</button>' : ''}
        ${a.can_timeout ? (timed ? '<button class="ssv-btn" data-act="m-untimeout">Remove timeout</button>' : '<button class="ssv-btn" data-act="m-timeout">Timeout</button>') : ''}
        ${a.can_kick ? '<button class="ssv-btn ssv-btn-danger-o" data-act="m-kick">Kick</button>' : ''}
        ${a.can_ban ? '<button class="ssv-btn ssv-btn-danger-o" data-act="m-ban">Ban</button>' : ''}
        ${a.can_transfer ? '<button class="ssv-btn ssv-btn-danger-o" data-act="m-owner">Make owner</button>' : ''}
      </div></div>`;
  }

  const TIMEOUTS = [['60 seconds', 60], ['5 minutes', 300], ['10 minutes', 600], ['1 hour', 3600], ['1 day', 86400], ['1 week', 604800]];

  SS.register('members', {
    label: 'Members', icon: ico('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    async render(c) {
      mb.page = 1; mb.search = ''; mb.role = '';
      c.innerHTML = `<p class="ssv-lead">Search members, manage their roles, and take moderation action.</p>
        <div class="ssv-toolbar"><input id="mb-search" type="search" placeholder="Search by name or username" aria-label="Search members" autocomplete="off">
        <select id="mb-role" aria-label="Filter by role"><option value="">All roles</option></select></div><div id="mb-list"></div>`;
      const rr = await call('GET', `/servers/${sid()}/roles`);
      mb.roles = rr.ok ? rr.data.roles : [];
      const sel = $('#mb-role'); if (sel) sel.innerHTML += mb.roles.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
      mbLoad();
    },
    dirty: () => false,
    onInput: debounce(t => { if (t.id === 'mb-search') { mb.search = t.value.trim(); mb.page = 1; mbLoad(); } }, 250),
    onChange(t) { if (t.id === 'mb-role') { mb.role = t.value; mb.page = 1; mbLoad(); } },
    onLiveEvent() { mbLoad(); },
    async onClick(act, t, ev) {
      if (act === 'page-prev') { mb.page = Math.max(1, mb.page - 1); return mbLoad(); }
      if (act === 'page-next') { mb.page += 1; return mbLoad(); }
      const row = t.closest('[data-uid]'); if (!row) return;
      const m = mb.data.members.find(x => x.id === row.dataset.uid); if (!m) return;
      const name = m.display_name || m.username;
      if (act === 'm-profile') { if (typeof window.showUserProfile === 'function') window.showUserProfile(ev, m.id); return; }
      if (act === 'm-roles') {
        const mine = new Set(m.roles.map(r => r.id));
        const grantable = isOwner() || (mask() & P.ADMIN) ? ~0 : mask();
        const opts = mb.roles.filter(r => !r.is_default).map(r => {
          const manageable = isOwner() || r.position < myRank();
          const permsOk = (r.permissions & ~grantable) === 0;
          const adding = !mine.has(r.id);
          const dis = !manageable || (adding && !permsOk);
          return { value: r.id, html: roleChip(r), label: r.name, checked: mine.has(r.id), disabled: dis, note: !manageable ? 'Above your rank' : (adding && !permsOk ? 'Has permissions you lack' : '') };
        });
        const v = await dialog({ title: `Roles for ${name}`, message: 'Every member keeps the default role.', fields: [{ name: 'roles', label: 'Roles', type: 'checkboxes', options: opts }], confirmText: 'Save roles' });
        if (!v) return;
        const nextSet = new Set(v.roles);
        const add = opts.filter(o => !o.disabled && nextSet.has(o.value) && !mine.has(o.value)).map(o => o.value);
        const rem = opts.filter(o => !o.disabled && !nextSet.has(o.value) && mine.has(o.value)).map(o => o.value);
        if (!add.length && !rem.length) return;
        const r = await call('PATCH', `/servers/${sid()}/members/${m.id}`, { add_role_ids: add, remove_role_ids: rem });
        if (!r.ok) return notify(r.error, true);
        notify('Roles updated'); mbLoad(); state.hooks.onMembersChanged && state.hooks.onMembersChanged();
      } else if (act === 'm-timeout') {
        const v = await dialog({ title: `Time out ${name}`, message: 'They won’t be able to send messages until the timeout ends.',
          fields: [{ name: 'dur', label: 'Duration', type: 'select', value: '3600', options: TIMEOUTS.map(([l, s]) => ({ value: s, label: l })) }, { name: 'reason', label: 'Reason (optional)', type: 'textarea', maxlength: 300 }], confirmText: 'Time out', danger: true });
        if (!v) return;
        const r = await call('POST', `/servers/${sid()}/members/${m.id}/timeout`, { duration_seconds: parseInt(v.dur, 10), reason: v.reason || undefined });
        if (!r.ok) return notify(r.error, true);
        notify(`${name} was timed out`); mbLoad();
      } else if (act === 'm-untimeout') {
        const r = await call('DELETE', `/servers/${sid()}/members/${m.id}/timeout`);
        if (!r.ok) return notify(r.error, true);
        notify('Timeout removed'); mbLoad();
      } else if (act === 'm-kick') {
        const v = await dialog({ title: `Kick ${name}?`, message: 'They can rejoin with a new invite. Their messages are kept.', fields: [{ name: 'reason', label: 'Reason (optional)', type: 'textarea', maxlength: 300 }], confirmText: 'Kick member', danger: true });
        if (!v) return;
        const r = await call('DELETE', `/servers/${sid()}/members/${m.id}`, { reason: v.reason || undefined });
        if (!r.ok) return notify(r.error, true);
        notify(`${name} was kicked`); mbLoad(); state.hooks.onServerChanged && state.hooks.onServerChanged();
      } else if (act === 'm-owner') {
        const v = await dialog({
          title: `Transfer ownership to ${name}?`,
          message: `${name} will become the owner of “${state.server.name}” and you will lose the owner-only powers (deleting the server, transferring it, being protected from moderation). You keep the roles you already hold. Only the new owner can give it back. Type the server name to confirm.`,
          fields: [{ name: 'confirm', label: 'Server name', type: 'confirm', match: state.server.name, placeholder: state.server.name }],
          confirmText: 'Transfer ownership', danger: true
        });
        if (!v) return;
        const r = await call('POST', `/servers/${sid()}/transfer-ownership`, { user_id: m.id, confirm_name: v.confirm });
        if (!r.ok) return notify(r.error, true);
        notify(`${name} is now the owner`);
        // Our own authority just changed: refresh the cached server so the
        // panel re-evaluates (it closes if nothing is left to manage).
        if (state.hooks.onServerChanged) await state.hooks.onServerChanged();
        if (state.open) mbLoad();
      } else if (act === 'm-ban') {
        const v = await dialog({ title: `Ban ${name}?`, message: 'They are removed and can’t rejoin until unbanned. Their account and messages are not deleted.', fields: [{ name: 'reason', label: 'Reason (optional)', type: 'textarea', maxlength: 300 }], confirmText: 'Ban member', danger: true });
        if (!v) return;
        const r = await call('POST', `/servers/${sid()}/bans/${m.id}`, { reason: v.reason || undefined });
        if (!r.ok) return notify(r.error, true);
        notify(`${name} was banned`); mbLoad(); state.hooks.onServerChanged && state.hooks.onServerChanged();
      }
    }
  });
})();
