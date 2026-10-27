// serverSettingsPanels.js — Roles, Channels, Moderation and Audit Log
// sections of Server Settings. Loaded after serverSettings.js, which owns the
// shell, dialogs and helpers (window.ServerSettings.util).
(function () {
  'use strict';
  const SS = window.ServerSettings;
  if (!SS) return;
  const { P } = SS;
  const U = SS.util;
  const { esc, $, setText, sid, has, isOwner, myRank, call, notify, debounce, busy, avatarHtml, roleChip, loadingHtml, emptyHtml, errorHtml, pagerHtml, dialog, confirmDialog, fmtDate, fmtDateTime } = U;
  const ico = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const sw = (id, checked, disabled, attrs) => `<label class="ssv-switch-wrap"><input type="checkbox" ${id ? `id="${id}"` : ''} ${attrs || ''} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span class="ssv-switch" aria-hidden="true"></span></label>`;
  const canManageRole = r => isOwner() || r.position < myRank();

  // ═══ Roles ════════════════════════════════════════════════════
  const rl = { roles: [], catalog: [], grantable: 0, sel: null, draft: null, orig: null };

  const rlDirty = () => !!(rl.draft && rl.orig && JSON.stringify(rl.draft) !== JSON.stringify(rl.orig));
  const toDraft = r => ({ name: r.name, color: r.color || '', display_separately: !!r.display_separately, permissions: r.permissions | 0 });

  async function rlLoad(keepSel) {
    const [r, p] = await Promise.all([call('GET', `/servers/${sid()}/roles`), call('GET', `/servers/${sid()}/permissions`)]);
    if (!r.ok) throw new Error(r.error);
    if (!p.ok) throw new Error(p.error);
    rl.roles = r.data.roles; rl.catalog = p.data.catalog; rl.grantable = p.data.my_grantable | 0;
    const cur = keepSel && rl.roles.find(x => x.id === rl.sel);
    const pick = cur || rl.roles.find(x => !x.is_default) || rl.roles[0];
    rl.sel = pick ? pick.id : null;
    rl.orig = pick ? toDraft(pick) : null; rl.draft = rl.orig ? Object.assign({}, rl.orig) : null;
  }

  function rlPaint() {
    const c = U.content(); if (!c) return;
    const nonDefault = rl.roles.filter(r => !r.is_default), def = rl.roles.filter(r => r.is_default);
    const row = (r, i, arr) => {
      const movable = !r.is_default && canManageRole(r);
      const up = i > 0 && movable && canManageRole(arr[i - 1]);
      const down = i < arr.length - 1 && movable && canManageRole(arr[i + 1]);
      return `<div class="ssv-role-item ${r.id === rl.sel ? 'active' : ''}" data-act="r-select" data-id="${esc(r.id)}" role="button" tabindex="0">
        <span class="ssv-dot" style="${r.color ? `background:${esc(r.color)}` : ''}"></span>
        <span class="ssv-grow"><span class="ssv-name">${esc(r.name)}</span><span class="ssv-help">${r.is_default ? 'Default · ' : ''}${r.member_count} member${r.member_count === 1 ? '' : 's'}</span></span>
        ${!r.is_default ? `<span class="ssv-mini"><button class="ssv-icon-btn" data-act="r-up" data-id="${esc(r.id)}" aria-label="Move ${esc(r.name)} up" ${up ? '' : 'disabled'}>▲</button><button class="ssv-icon-btn" data-act="r-down" data-id="${esc(r.id)}" aria-label="Move ${esc(r.name)} down" ${down ? '' : 'disabled'}>▼</button></span>` : ''}</div>`;
    };
    c.innerHTML = `<p class="ssv-lead">Roles are listed from highest to lowest. A role can only be changed by someone ranked above it.</p>
      <div class="ssv-split"><div class="ssv-rolelist">
        <button class="ssv-btn ssv-btn-primary ssv-block" data-act="r-create">Create role</button>
        ${nonDefault.map(row).join('')}${def.map((r, i, a) => row(r, i, a)).join('')}</div>
        <div class="ssv-roleeditor" id="rl-editor"></div></div>`;
    rlEditor();
  }

  function rlEditor() {
    const box = $('#rl-editor'); if (!box) return;
    const role = rl.roles.find(r => r.id === rl.sel);
    if (!role) { box.innerHTML = emptyHtml('No role selected'); return; }
    const d = rl.draft, can = canManageRole(role);
    const locked = bit => !can || (!U.isOwner() && (rl.grantable & bit) === 0);
    box.innerHTML = `${can ? '' : '<div class="ssv-note">You can’t edit this role because it is at or above your highest role.</div>'}
      <div class="ssv-card">
        <div class="ssv-field"><label for="rl-name">Role name</label><input id="rl-name" maxlength="32" value="${esc(d.name)}" ${can ? '' : 'disabled'}></div>
        <div class="ssv-field"><label for="rl-color">Colour</label>
          <div class="ssv-row"><input type="color" id="rl-color" value="${esc(d.color || '#99aab5')}" ${can ? '' : 'disabled'} aria-label="Role colour">
          <input id="rl-color-hex" value="${esc(d.color)}" maxlength="7" placeholder="No colour" ${can ? '' : 'disabled'} aria-label="Role colour hex">
          <button class="ssv-btn" data-act="r-color-clear" ${can && d.color ? '' : 'disabled'}>Clear</button></div></div>
        <label class="ssv-toggle"><input type="checkbox" id="rl-sep" ${d.display_separately ? 'checked' : ''} ${can ? '' : 'disabled'}><span class="ssv-switch" aria-hidden="true"></span>
          <span><strong>Show members separately</strong><em>List members with this role as their own group in the member list.</em></span></label>
        <div class="ssv-error-line" id="rl-error" role="alert"></div>
      </div>
      ${rl.catalog.map(cat => `<div class="ssv-card"><h3>${esc(cat.label)}</h3>${cat.items.map(it => `
        <label class="ssv-toggle ssv-perm"><input type="checkbox" data-bit="${it.bit}" ${(d.permissions & it.bit) ? 'checked' : ''} ${locked(it.bit) ? 'disabled' : ''}>
          <span class="ssv-switch" aria-hidden="true"></span><span><strong>${esc(it.label)}</strong><em>${esc(it.description)}</em></span></label>`).join('')}</div>`).join('')}
      <div class="ssv-row ssv-between">${!role.is_default && can ? '<button class="ssv-btn ssv-btn-danger" data-act="r-delete">Delete role</button>' : '<span></span>'}
        <span class="ssv-muted">${role.member_count} member${role.member_count === 1 ? '' : 's'} have this role</span></div>
      <div class="ssv-savebar" id="rl-savebar" ${rlDirty() ? '' : 'hidden'}><span>Careful — you have unsaved changes.</span>
        <div class="ssv-row"><button class="ssv-btn" data-act="r-reset">Reset</button><button class="ssv-btn ssv-btn-primary" data-act="r-save">Save changes</button></div></div>`;
  }
  const rlBar = () => { const b = $('#rl-savebar'); if (b) b.hidden = !rlDirty(); };

  SS.register('roles', {
    label: 'Roles', icon: ico('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    render(c) { c.innerHTML = loadingHtml('Loading roles…'); rl.sel = null; rlLoad().then(() => { if ($('#ssv-content')) rlPaint(); }).catch(e => { c.innerHTML = errorHtml(e.message); }); },
    dirty: rlDirty,
    onLiveEvent() { rlLoad(true).then(() => $('#rl-editor') && rlPaint()).catch(() => {}); },
    onInput(t) {
      if (!rl.draft) return;
      if (t.id === 'rl-name') rl.draft.name = t.value;
      else if (t.id === 'rl-color-hex') { rl.draft.color = t.value.trim(); if (/^#[0-9a-f]{6}$/i.test(rl.draft.color)) { const c = $('#rl-color'); if (c) c.value = rl.draft.color; } }
      else return;
      rlBar();
    },
    onChange(t) {
      if (!rl.draft) return;
      if (t.id === 'rl-color') { rl.draft.color = t.value; const h = $('#rl-color-hex'); if (h) h.value = t.value; }
      else if (t.id === 'rl-sep') rl.draft.display_separately = t.checked;
      else if (t.dataset && t.dataset.bit) { const b = parseInt(t.dataset.bit, 10); rl.draft.permissions = t.checked ? (rl.draft.permissions | b) : (rl.draft.permissions & ~b); }
      else return;
      rlBar();
    },
    async onClick(act, t) {
      const id = t.dataset.id;
      if (act === 'r-select') {
        if (id === rl.sel) return;
        if (rlDirty() && !(await confirmDialog({ title: 'Unsaved changes', message: 'Discard your changes to this role?', confirmText: 'Discard changes', cancelText: 'Keep editing', danger: true }))) return;
        const r = rl.roles.find(x => x.id === id); rl.sel = id; rl.orig = toDraft(r); rl.draft = Object.assign({}, rl.orig); rlPaint();
      } else if (act === 'r-create') {
        if (rlDirty() && !(await confirmDialog({ title: 'Unsaved changes', message: 'Discard your changes to this role?', confirmText: 'Discard changes', cancelText: 'Keep editing', danger: true }))) return;
        const v = await dialog({ title: 'Create role', message: 'New roles start at the bottom of the list with no permissions.', fields: [{ name: 'name', label: 'Role name', type: 'text', required: true, maxlength: 32 }], confirmText: 'Create role' });
        if (!v) return;
        const r = await call('POST', `/servers/${sid()}/roles`, { name: v.name });
        if (!r.ok) return notify(r.error, true);
        rl.sel = r.data.role.id; await rlLoad(true); rlPaint(); notify('Role created');
      } else if (act === 'r-up' || act === 'r-down') {
        const ids = rl.roles.filter(r => !r.is_default).map(r => r.id);
        const i = ids.indexOf(id), j = act === 'r-up' ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        const r = await call('PUT', `/servers/${sid()}/roles/order`, { role_ids: ids });
        if (!r.ok) return notify(r.error, true);
        const keep = rlDirty() ? rl.draft : null;
        await rlLoad(true); if (keep) rl.draft = keep; rlPaint();
      } else if (act === 'r-color-clear') { rl.draft.color = ''; rlEditor(); }
      else if (act === 'r-reset') { rl.draft = Object.assign({}, rl.orig); rlEditor(); }
      else if (act === 'r-save') {
        const d = rl.draft;
        if (!d.name.trim()) { setText('#rl-error', 'Role name cannot be empty.'); return; }
        if (d.color && !/^#[0-9a-f]{6}$/i.test(d.color)) { setText('#rl-error', 'Colour must look like #RRGGBB.'); return; }
        const body = {};
        for (const k of Object.keys(d)) if (d[k] !== rl.orig[k]) body[k] = k === 'color' ? (d[k] || null) : d[k];
        const r = await busy(t, () => call('PATCH', `/servers/${sid()}/roles/${rl.sel}`, body));
        if (!r) return;
        if (!r.ok) { setText('#rl-error', r.error); return notify(r.error, true); }   // draft is kept
        await rlLoad(true); rlPaint(); notify('Role saved'); U.hooks().onMembersChanged && U.hooks().onMembersChanged();
      } else if (act === 'r-delete') {
        const role = rl.roles.find(r => r.id === rl.sel);
        if (!(await confirmDialog({ title: `Delete “${role.name}”?`, message: `${role.member_count} member(s) will lose this role and keep the default role. Channel permission overrides for it are removed.`, confirmText: 'Delete role', danger: true }))) return;
        const r = await call('DELETE', `/servers/${sid()}/roles/${role.id}`);
        if (!r.ok) return notify(r.error, true);
        rl.sel = null; await rlLoad(); rlPaint(); notify('Role deleted'); U.hooks().onMembersChanged && U.hooks().onMembersChanged();
      }
    }
  });

  // ═══ Channels ═════════════════════════════════════════════════
  const ch = { channels: [], categories: [], roles: [], catalog: [], grantable: 0, view: 'list', cid: null, overrides: [] };

  async function chLoad() {
    const [c, r, p] = await Promise.all([call('GET', `/servers/${sid()}/channels?scope=manage`), call('GET', `/servers/${sid()}/roles`), call('GET', `/servers/${sid()}/permissions`)]);
    for (const x of [c, r, p]) if (!x.ok) throw new Error(x.error);
    ch.channels = c.data.channels; ch.categories = c.data.categories; ch.roles = r.data.roles; ch.catalog = p.data.catalog; ch.grantable = p.data.my_grantable | 0;
  }
  const layout = () => ({ categories: ch.categories.map(c => c.id), channels: ch.channels.map(c => ({ id: c.id, category_id: c.category_id || null })) });
  async function saveLayout(l) {
    const r = await call('PUT', `/servers/${sid()}/channel-layout`, l);
    if (!r.ok) { notify(r.error, true); return false; }
    await chLoad(); chPaint(); U.hooks().onChannelsChanged && U.hooks().onChannelsChanged(); return true;
  }

  function chRow(c, i, group) {
    return `<div class="ssv-trow" data-cid="${esc(c.id)}"><span class="ssv-hash">#</span>
      <div class="ssv-grow"><div class="ssv-name">${esc(c.name)}</div>
        <div class="ssv-help">${c.description ? esc(c.description) + ' · ' : ''}Created ${esc(fmtDate(c.created_at))} · ${c.member_count} member${c.member_count === 1 ? '' : 's'}</div></div>
      <div class="ssv-actions"><button class="ssv-icon-btn" data-act="c-up" aria-label="Move up" ${i > 0 ? '' : 'disabled'}>▲</button><button class="ssv-icon-btn" data-act="c-down" aria-label="Move down" ${i < group.length - 1 ? '' : 'disabled'}>▼</button>
        <button class="ssv-btn" data-act="c-edit">Edit</button><button class="ssv-btn" data-act="c-perms">Permissions</button><button class="ssv-btn ssv-btn-danger-o" data-act="c-delete">Delete</button></div></div>`;
  }

  function chPaint() {
    const c = U.content(); if (!c) return;
    if (ch.view === 'perms') return chPermsPaint(c);
    const groups = [{ id: null, name: 'No category', list: ch.channels.filter(x => !x.category_id) }]
      .concat(ch.categories.map(k => ({ id: k.id, name: k.name, list: ch.channels.filter(x => x.category_id === k.id) })));
    c.innerHTML = `<p class="ssv-lead">Organise your text channels into categories, rename them, and control who can see and write in each one.</p>
      <div class="ssv-row ssv-wrap"><button class="ssv-btn ssv-btn-primary" data-act="c-create">Create channel</button><button class="ssv-btn" data-act="cat-create">Create category</button></div>
      ${groups.map((g, gi) => `<section class="ssv-card" data-gid="${esc(g.id || '')}">
        <div class="ssv-row ssv-between"><h3>${esc(g.name)} <span class="ssv-muted">· ${g.list.length}</span></h3>
          ${g.id ? `<div class="ssv-actions"><button class="ssv-icon-btn" data-act="cat-up" aria-label="Move category up" ${gi > 1 ? '' : 'disabled'}>▲</button><button class="ssv-icon-btn" data-act="cat-down" aria-label="Move category down" ${gi < groups.length - 1 ? '' : 'disabled'}>▼</button><button class="ssv-btn" data-act="cat-rename">Rename</button><button class="ssv-btn ssv-btn-danger-o" data-act="cat-delete">Delete</button></div>` : ''}</div>
        ${g.list.length ? `<div class="ssv-table">${g.list.map((x, i) => chRow(x, i, g.list)).join('')}</div>` : '<div class="ssv-muted ssv-pad">No channels here.</div>'}</section>`).join('')}`;
  }

  async function chPermsOpen(cid) {
    ch.cid = cid; ch.view = 'perms';
    const c = U.content(); if (!c) return; c.innerHTML = loadingHtml();
    const r = await call('GET', `/servers/${sid()}/channels/${cid}/overrides`);
    if (!r.ok) { ch.view = 'list'; chPaint(); return notify(r.error, true); }
    ch.overrides = r.data.overrides; chPaint();
  }

  const OV_PERMS = () => ch.catalog.flatMap(c => c.items).filter(i => i.channel_overridable);
  function chPermsPaint(c) {
    const chan = ch.channels.find(x => x.id === ch.cid);
    if (!chan) { ch.view = 'list'; return chPaint(); }
    const used = new Set(ch.overrides.map(o => o.role_id));
    const addable = ch.roles.filter(r => !used.has(r.id) && canManageRole(r));
    const perms = OV_PERMS();
    const card = o => `<div class="ssv-card" data-rid="${esc(o.role_id)}"><div class="ssv-row ssv-between"><h3>${roleChip({ name: o.role_name, color: o.role_color })}</h3><button class="ssv-btn ssv-btn-danger-o" data-act="o-remove">Remove override</button></div>
      <div class="ssv-ovgrid">${perms.map(p => { const v = (o.allow & p.bit) ? 'allow' : (o.deny & p.bit) ? 'deny' : 'inherit'; const dis = !isOwner() && (ch.grantable & p.bit) === 0;
        return `<label>${esc(p.label)}<select data-bit="${p.bit}" ${dis ? 'disabled' : ''}><option value="inherit" ${v === 'inherit' ? 'selected' : ''}>Inherit</option><option value="allow" ${v === 'allow' ? 'selected' : ''}>Allow</option><option value="deny" ${v === 'deny' ? 'selected' : ''}>Deny</option></select></label>`; }).join('')}</div>
      <div class="ssv-row"><button class="ssv-btn ssv-btn-primary" data-act="o-save">Save</button></div></div>`;
    c.innerHTML = `<button class="ssv-btn" data-act="c-back">← Back to channels</button>
      <p class="ssv-lead"><strong>#${esc(chan.name)}</strong> — permission overrides. Owners and Administrators always have full access. For everyone else: server-level permissions apply first, then the default role’s override, then the combined overrides of their other roles (an Allow beats a Deny).</p>
      <div class="ssv-row ssv-wrap"><select id="o-add" aria-label="Role to add">${addable.length ? addable.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('') : '<option value="">No roles available</option>'}</select>
      <button class="ssv-btn ssv-btn-primary" data-act="o-add" ${addable.length ? '' : 'disabled'}>Add role override</button></div>
      ${ch.overrides.length ? ch.overrides.map(card).join('') : emptyHtml('No overrides', 'This channel uses the server-level permissions for every role.')}`;
  }

  SS.register('channels', {
    label: 'Channels', icon: ico('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>'),
    render(c) { ch.view = 'list'; c.innerHTML = loadingHtml('Loading channels…'); chLoad().then(() => $('#ssv-content') && chPaint()).catch(e => { c.innerHTML = errorHtml(e.message); }); },
    dirty: () => false,
    onLiveEvent() { if (ch.view === 'list') chLoad().then(() => ch.view === 'list' && $('#ssv-content') && chPaint()).catch(() => {}); },
    async onClick(act, t) {
      const cid = (t.closest('[data-cid]') || {}).dataset ? t.closest('[data-cid]').dataset.cid : null;
      const chan = cid && ch.channels.find(x => x.id === cid);
      const gid = (t.closest('[data-gid]') || { dataset: {} }).dataset.gid || null;
      const cat = gid && ch.categories.find(k => k.id === gid);
      const catOpts = [{ value: '', label: 'No category' }].concat(ch.categories.map(k => ({ value: k.id, label: k.name })));
      if (act === 'c-create') {
        const v = await dialog({ title: 'Create channel', message: 'Text channel. Names are lowercase with dashes.', fields: [
          { name: 'name', label: 'Channel name', type: 'text', required: true, maxlength: 32 }, { name: 'topic', label: 'Topic (optional)', type: 'text', maxlength: 200 },
          { name: 'cat', label: 'Category', type: 'select', options: catOpts }], confirmText: 'Create channel' });
        if (!v) return;
        const r = await call('POST', `/servers/${sid()}/channels`, { name: v.name, description: v.topic, category_id: v.cat || undefined });
        if (!r.ok) return notify(r.error, true);
        notify('Channel created'); await chLoad(); chPaint(); U.hooks().onChannelsChanged && U.hooks().onChannelsChanged();
      } else if (act === 'cat-create') {
        const v = await dialog({ title: 'Create category', fields: [{ name: 'name', label: 'Category name', type: 'text', required: true, maxlength: 32 }], confirmText: 'Create category' });
        if (!v) return;
        const r = await call('POST', `/servers/${sid()}/categories`, { name: v.name });
        if (!r.ok) return notify(r.error, true);
        notify('Category created'); await chLoad(); chPaint(); U.hooks().onChannelsChanged && U.hooks().onChannelsChanged();
      } else if (act === 'cat-rename' && cat) {
        const v = await dialog({ title: 'Rename category', fields: [{ name: 'name', label: 'Category name', type: 'text', value: cat.name, required: true, maxlength: 32 }], confirmText: 'Rename' });
        if (!v) return;
        const r = await call('PATCH', `/servers/${sid()}/categories/${cat.id}`, { name: v.name });
        if (!r.ok) return notify(r.error, true);
        notify('Category renamed'); await chLoad(); chPaint(); U.hooks().onChannelsChanged && U.hooks().onChannelsChanged();
      } else if (act === 'cat-delete' && cat) {
        if (!(await confirmDialog({ title: `Delete “${cat.name}”?`, message: 'Its channels are not deleted — they move to “No category”.', confirmText: 'Delete category', danger: true }))) return;
        const r = await call('DELETE', `/servers/${sid()}/categories/${cat.id}`);
        if (!r.ok) return notify(r.error, true);
        notify('Category deleted'); await chLoad(); chPaint(); U.hooks().onChannelsChanged && U.hooks().onChannelsChanged();
      } else if ((act === 'cat-up' || act === 'cat-down') && cat) {
        const l = layout(), i = l.categories.indexOf(cat.id), j = act === 'cat-up' ? i - 1 : i + 1;
        if (j < 0 || j >= l.categories.length) return;
        [l.categories[i], l.categories[j]] = [l.categories[j], l.categories[i]]; saveLayout(l);
      } else if ((act === 'c-up' || act === 'c-down') && chan) {
        const l = layout(), same = l.channels.filter(x => (x.category_id || null) === (chan.category_id || null));
        const k = same.findIndex(x => x.id === chan.id), o = same[act === 'c-up' ? k - 1 : k + 1];
        if (!o) return;
        const a = l.channels.findIndex(x => x.id === chan.id), b = l.channels.findIndex(x => x.id === o.id);
        [l.channels[a], l.channels[b]] = [l.channels[b], l.channels[a]]; saveLayout(l);
      } else if (act === 'c-edit' && chan) {
        const v = await dialog({ title: `Edit #${chan.name}`, fields: [
          { name: 'name', label: 'Channel name', type: 'text', value: chan.name, required: true, maxlength: 32 }, { name: 'topic', label: 'Topic', type: 'text', value: chan.description || '', maxlength: 200 },
          { name: 'cat', label: 'Category', type: 'select', value: chan.category_id || '', options: catOpts }], confirmText: 'Save' });
        if (!v) return;
        const body = {}; if (v.name !== chan.name) body.name = v.name; if (v.topic !== (chan.description || '')) body.description = v.topic;
        if (Object.keys(body).length) { const r = await call('PATCH', `/channels/${chan.id}`, body); if (!r.ok) return notify(r.error, true); }
        if ((v.cat || null) !== (chan.category_id || null)) {
          await chLoad(); const l = layout(); const item = l.channels.find(x => x.id === chan.id);
          l.channels = l.channels.filter(x => x !== item); item.category_id = v.cat || null; l.channels.push(item);
          if (!(await saveLayout(l))) return;
        } else { await chLoad(); chPaint(); U.hooks().onChannelsChanged && U.hooks().onChannelsChanged(); }
        notify('Channel saved');
      } else if (act === 'c-delete' && chan) {
        if (!(await confirmDialog({ title: `Delete #${chan.name}?`, message: 'The channel and all messages in it are permanently deleted. This cannot be undone.', confirmText: 'Delete channel', danger: true }))) return;
        const r = await call('DELETE', `/channels/${chan.id}`);
        if (!r.ok) return notify(r.error, true);
        notify('Channel deleted'); await chLoad(); chPaint(); U.hooks().onChannelsChanged && U.hooks().onChannelsChanged();
      } else if (act === 'c-perms' && chan) chPermsOpen(chan.id);
      else if (act === 'c-back') { ch.view = 'list'; await chLoad(); chPaint(); }
      else if (act === 'o-add') {
        const rid = $('#o-add').value; if (!rid) return;
        const r = await call('PUT', `/servers/${sid()}/channels/${ch.cid}/overrides/${rid}`, { allow: 0, deny: 0 });
        // an empty override is not stored — show an editable card locally
        const role = ch.roles.find(x => x.id === rid);
        if (!r.ok) return notify(r.error, true);
        ch.overrides.push({ role_id: rid, role_name: role.name, role_color: role.color, allow: 0, deny: 0 }); chPaint();
      } else if (act === 'o-save') {
        const card = t.closest('[data-rid]'); let allow = 0, deny = 0;
        card.querySelectorAll('select[data-bit]').forEach(s => { const b = parseInt(s.dataset.bit, 10); if (s.value === 'allow') allow |= b; else if (s.value === 'deny') deny |= b; });
        const r = await busy(t, () => call('PUT', `/servers/${sid()}/channels/${ch.cid}/overrides/${card.dataset.rid}`, { allow, deny }));
        if (!r) return; if (!r.ok) return notify(r.error, true);
        notify('Channel permissions saved'); await chPermsOpen(ch.cid);
      } else if (act === 'o-remove') {
        const card = t.closest('[data-rid]');
        const r = await call('DELETE', `/servers/${sid()}/channels/${ch.cid}/overrides/${card.dataset.rid}`);
        if (!r.ok && r.data && !/not found/i.test(r.error)) return notify(r.error, true);
        notify('Override removed'); await chPermsOpen(ch.cid);
      }
    }
  });

  // ═══ Moderation ═══════════════════════════════════════════════
  const md = { bans: null, banPage: 1, banSearch: '', timeouts: null, find: [] };

  async function mdBans() {
    const box = $('#md-bans'); if (!box) return;
    box.innerHTML = loadingHtml('Loading bans…');
    const r = await call('GET', `/servers/${sid()}/bans?page=${md.banPage}&page_size=15&search=${encodeURIComponent(md.banSearch)}`);
    if (!$('#md-bans')) return;
    if (!r.ok) { $('#md-bans').innerHTML = errorHtml(r.error); return; }
    md.bans = r.data;
    $('#md-bans').innerHTML = r.data.bans.length ? `<div class="ssv-table">${r.data.bans.map(b => `<div class="ssv-trow" data-uid="${esc(b.user_id)}" data-name="${esc(b.display_name || b.username)}">
      ${avatarHtml(b)}<div class="ssv-grow"><div class="ssv-name">${esc(b.display_name || b.username)}</div>
      <div class="ssv-help">@${esc(b.username)} · Banned ${esc(fmtDateTime(b.created_at))}${b.banned_by_display_name ? ' by ' + esc(b.banned_by_display_name) : ''}</div>
      <div class="ssv-help">${b.reason ? 'Reason: ' + esc(b.reason) : 'No reason given'}</div></div>
      <button class="ssv-btn" data-act="unban">Unban</button></div>`).join('')}</div>${pagerHtml(r.data)}` : emptyHtml(md.banSearch ? 'No bans match your search' : 'No banned members');
  }

  async function mdTimeouts() {
    const box = $('#md-timeouts'); if (!box) return;
    box.innerHTML = loadingHtml();
    const r = await call('GET', `/servers/${sid()}/members?page=1&page_size=50&timed_out=1`);
    if (!$('#md-timeouts')) return;
    if (!r.ok) { $('#md-timeouts').innerHTML = errorHtml(r.error); return; }
    $('#md-timeouts').innerHTML = r.data.members.length ? `<div class="ssv-table">${r.data.members.map(m => `<div class="ssv-trow" data-uid="${esc(m.id)}" data-name="${esc(m.display_name || m.username)}">
      ${avatarHtml(m)}<div class="ssv-grow"><div class="ssv-name">${esc(m.display_name || m.username)}</div><div class="ssv-help">Timed out until ${esc(fmtDateTime(m.timeout_until))}</div></div>
      ${m.actions && m.actions.can_timeout ? '<button class="ssv-btn" data-act="untimeout">Remove timeout</button>' : ''}</div>`).join('')}</div>` : emptyHtml('No active timeouts');
  }

  const mdFind = debounce(async q => {
    const box = $('#md-find'); if (!box) return;
    if (!q) { box.innerHTML = ''; return; }
    const r = await call('GET', `/servers/${sid()}/members?page=1&page_size=5&search=${encodeURIComponent(q)}`);
    if (!$('#md-find')) return;
    const list = r.ok ? r.data.members.filter(m => m.actions && m.actions.can_ban) : [];
    $('#md-find').innerHTML = r.ok ? (list.length ? `<div class="ssv-table">${list.map(m => `<div class="ssv-trow" data-uid="${esc(m.id)}" data-name="${esc(m.display_name || m.username)}">${avatarHtml(m)}
      <div class="ssv-grow"><div class="ssv-name">${esc(m.display_name || m.username)}</div><div class="ssv-help">@${esc(m.username)}</div></div><button class="ssv-btn ssv-btn-danger-o" data-act="md-ban">Ban</button></div>`).join('')}</div>` : emptyHtml('No bannable members found', 'You can’t ban the owner, yourself, or members who rank at or above you.')) : errorHtml(r.error);
  }, 250);

  SS.register('moderation', {
    label: 'Moderation', icon: ico('<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'),
    render(c) {
      md.banPage = 1; md.banSearch = '';
      c.innerHTML = `<p class="ssv-lead">Ban and unban members and manage timeouts. Every action is recorded in the audit log.</p>
        ${has(P.BAN) ? `<section class="ssv-card"><h3>Ban a member</h3><input id="md-search-member" type="search" placeholder="Search members to ban" aria-label="Search members to ban" autocomplete="off"><div id="md-find"></div></section>` : ''}
        ${has(P.TIMEOUT) ? '<section class="ssv-card"><h3>Active timeouts</h3><div id="md-timeouts"></div></section>' : ''}
        ${has(P.BAN) ? `<section class="ssv-card"><h3>Banned members</h3><input id="md-search-bans" type="search" placeholder="Search bans by name or reason" aria-label="Search bans" autocomplete="off"><div id="md-bans"></div></section>` : ''}`;
      if (has(P.BAN)) mdBans(); if (has(P.TIMEOUT)) mdTimeouts();
    },
    dirty: () => false,
    onLiveEvent() { if (has(P.BAN)) mdBans(); if (has(P.TIMEOUT)) mdTimeouts(); },
    onInput(t) {
      if (t.id === 'md-search-member') mdFind(t.value.trim());
      else if (t.id === 'md-search-bans') { clearTimeout(md._t); md._t = setTimeout(() => { md.banSearch = t.value.trim(); md.banPage = 1; mdBans(); }, 250); }
    },
    async onClick(act, t) {
      if (act === 'page-prev') { md.banPage = Math.max(1, md.banPage - 1); return mdBans(); }
      if (act === 'page-next') { md.banPage += 1; return mdBans(); }
      const row = t.closest('[data-uid]'); if (!row) return;
      const uid = row.dataset.uid, name = row.dataset.name;
      if (act === 'md-ban') {
        const v = await dialog({ title: `Ban ${name}?`, message: 'They are removed and can’t rejoin until unbanned.', fields: [{ name: 'reason', label: 'Reason (optional)', type: 'textarea', maxlength: 300 }], confirmText: 'Ban member', danger: true });
        if (!v) return;
        const r = await call('POST', `/servers/${sid()}/bans/${uid}`, { reason: v.reason || undefined });
        if (!r.ok) return notify(r.error, true);
        notify(`${name} was banned`); { const f = $('#md-search-member'); if (f) f.value = ''; const b = $('#md-find'); if (b) b.innerHTML = ''; } mdBans(); mdTimeouts(); U.hooks().onServerChanged && U.hooks().onServerChanged();
      } else if (act === 'unban') {
        if (!(await confirmDialog({ title: `Unban ${name}?`, message: 'They will be able to rejoin with an invite.', confirmText: 'Unban' }))) return;
        const r = await call('DELETE', `/servers/${sid()}/bans/${uid}`);
        if (!r.ok) return notify(r.error, true);
        notify(`${name} was unbanned`); mdBans();
      } else if (act === 'untimeout') {
        const r = await call('DELETE', `/servers/${sid()}/members/${uid}/timeout`);
        if (!r.ok) return notify(r.error, true);
        notify('Timeout removed'); mdTimeouts();
      }
    }
  });

  // ═══ Audit log ════════════════════════════════════════════════
  const au = { page: 1, action: '', actor: '', q: '', from: '', to: '', actions: null, members: null };

  function auDetails(e) {
    const d = e.details; if (!d) return '';
    const fmt = v => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    const lines = [];
    if (d.changes) Object.entries(d.changes).forEach(([k, v]) => lines.push(`${k.replace(/_/g, ' ')}: ${fmt(v.before)} → ${fmt(v.after)}`));
    if (d.added && d.added.length) lines.push('Added: ' + d.added.map(x => (x && x.name) || x).join(', '));
    if (d.removed && d.removed.length) lines.push('Removed: ' + d.removed.map(x => (x && x.name) || x).join(', '));
    if (d.before && d.after && !d.changes) lines.push(`${fmt(d.before)} → ${fmt(d.after)}`);
    if (d.duration_seconds) lines.push(`Duration: ${d.duration_seconds} seconds`);
    if (d.role) lines.push('Role: ' + d.role);
    if (d.from_category !== undefined || d.to_category !== undefined) lines.push(`Category: ${fmt(d.from_category)} → ${fmt(d.to_category)}`);
    return lines.length ? `<ul class="ssv-details">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
  }

  async function auLoad() {
    const box = $('#au-list'); if (!box) return;
    box.innerHTML = loadingHtml('Loading audit log…');
    const qs = new URLSearchParams({ page: au.page, page_size: 20 });
    if (au.action) qs.set('action', au.action); if (au.actor) qs.set('actor_id', au.actor); if (au.q) qs.set('q', au.q);
    if (au.from) qs.set('from', new Date(au.from + 'T00:00:00').getTime());
    if (au.to) qs.set('to', new Date(au.to + 'T23:59:59.999').getTime());
    const r = await call('GET', `/servers/${sid()}/audit-log?${qs}`);
    if (!$('#au-list')) return;
    if (!r.ok) { $('#au-list').innerHTML = errorHtml(r.error); return; }
    if (!au.actions) { au.actions = r.data.actions; auFilters(); }
    $('#au-list').innerHTML = r.data.entries.length ? `<div class="ssv-table">${r.data.entries.map(e => `<div class="ssv-trow ssv-audit-row">
      ${avatarHtml(e.actor)}<div class="ssv-grow"><div class="ssv-name">${esc(e.description)}</div>
      ${e.reason ? `<div class="ssv-help">Reason: ${esc(e.reason)}</div>` : ''}${auDetails(e)}</div>
      <time class="ssv-help" datetime="${new Date(e.created_at).toISOString()}" title="${esc(fmtDateTime(e.created_at))}">${esc(fmtDateTime(e.created_at))}</time></div>`).join('')}</div>${pagerHtml(r.data)}` : emptyHtml('No audit log entries', au.action || au.actor || au.q || au.from || au.to ? 'Try clearing the filters.' : 'Administrative actions will appear here.');
  }

  function auFilters() {
    const sel = $('#au-action'); if (!sel || !au.actions) return;
    const groups = [...new Set(au.actions.map(a => a.id.split('.')[0]))];
    sel.innerHTML = '<option value="">All actions</option>' + groups.map(g => `<optgroup label="${esc(g[0].toUpperCase() + g.slice(1))}"><option value="${g}">All ${esc(g)} actions</option>${au.actions.filter(a => a.id.startsWith(g + '.')).map(a => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('')}</optgroup>`).join('');
    sel.value = au.action;
  }

  SS.register('audit', {
    label: 'Audit Log', icon: ico('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
    async render(c) {
      Object.assign(au, { page: 1, action: '', actor: '', q: '', from: '', to: '', actions: null });
      c.innerHTML = `<p class="ssv-lead">A permanent record of administrative actions on this server, newest first.</p>
        <div class="ssv-toolbar ssv-wrap"><select id="au-action" aria-label="Filter by action"><option value="">All actions</option></select>
        <select id="au-actor" aria-label="Filter by moderator"><option value="">Everyone</option></select>
        <input id="au-q" type="search" placeholder="Search target or reason" aria-label="Search audit log">
        <label class="ssv-inline">From <input type="date" id="au-from"></label><label class="ssv-inline">To <input type="date" id="au-to"></label>
        <button class="ssv-btn" data-act="au-clear">Clear</button></div><div id="au-list"></div>`;
      auLoad();
      const m = await call('GET', `/servers/${sid()}/members?page=1&page_size=100`);
      const sel = $('#au-actor'); if (m.ok && sel) sel.innerHTML += m.data.members.map(x => `<option value="${esc(x.id)}">${esc(x.display_name || x.username)}</option>`).join('');
    },
    dirty: () => false,
    onLiveEvent() { auLoad(); },
    onInput(t) { if (t.id === 'au-q') { clearTimeout(au._t); au._t = setTimeout(() => { au.q = t.value.trim(); au.page = 1; auLoad(); }, 250); } },
    onChange(t) {
      const map = { 'au-action': 'action', 'au-actor': 'actor', 'au-from': 'from', 'au-to': 'to' };
      if (map[t.id]) { au[map[t.id]] = t.value; au.page = 1; auLoad(); }
    },
    onClick(act) {
      if (act === 'page-prev') { au.page = Math.max(1, au.page - 1); auLoad(); }
      else if (act === 'page-next') { au.page += 1; auLoad(); }
      else if (act === 'au-clear') {
        Object.assign(au, { page: 1, action: '', actor: '', q: '', from: '', to: '' });
        ['au-action', 'au-actor', 'au-q', 'au-from', 'au-to'].forEach(i => { const el = $('#' + i); if (el) el.value = ''; });
        auLoad();
      }
    }
  });
})();
