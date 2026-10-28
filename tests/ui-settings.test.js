// UI tests for the Server Settings panel. The real public/js/serverSettings*.js
// files run inside jsdom (a DOM simulation — there is no layout or CSS
// rendering) and talk to a real, freshly booted Nyxie server. They prove
// that the controls call the right endpoints, show the right states and
// guard unsaved changes; they do NOT prove visual layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { startServer, registerUser } = require('./helpers');

const PUB = path.join(__dirname, '..', 'public');
let s, owner, mod, member, sid, general;

async function until(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting: ' + fn.toString().slice(0, 120));
    await new Promise(r => setTimeout(r, 25));
  }
}

// Boots a jsdom page logged in as `user` with the settings scripts loaded.
async function mount(user, hooks = {}, serverId = sid) {
  const dom = new JSDOM('<!doctype html><html><body><div id="toast"></div></body></html>', { url: s.base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = (u, o) => fetch(new URL(u, s.base), o);
  // Real pages declare `token`/`api` as global lexical bindings in state.js;
  // inside jsdom's eval a `let` would not be shared between scripts, so they
  // are put on window (same visibility for the code under test).
  w.token = user.token; w.API = '';
  w.api = async function (method, path, body) {
    try {
      const res = await fetch(s.base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + w.token }, body: body ? JSON.stringify(body) : undefined });
      return res.json();
    } catch { return null; }
  };
  for (const f of ['utils.js', 'serverSettings.js', 'serverSettingsPanels.js']) w.eval(fs.readFileSync(path.join(PUB, 'js', f), 'utf8'));
  const servers = (await user.get('/servers')).body.servers;
  const server = servers.find(x => x.id === serverId);
  const doc = w.document;
  const ui = {
    w, doc, server,
    $: sel => doc.querySelector(sel),
    $$: sel => [...doc.querySelectorAll(sel)],
    click: el => { (typeof el === 'string' ? doc.querySelector(el) : el).dispatchEvent(new w.MouseEvent('click', { bubbles: true })); },
    type(sel, value) { const el = doc.querySelector(sel); el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    check(el, on) { el.checked = on; el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    text: () => doc.body.textContent,
    navItems: () => ui.$$('.ssv-nav-item').map(b => b.textContent.trim()),
    goto: async name => { ui.click(`.ssv-nav-item[data-section="${name}"]`); },
    dialogOk: async () => { await until(() => ui.$('.ssv-dialog [data-d=ok]')); ui.click('.ssv-dialog [data-d=ok]'); },
    dialogCancel: async () => { await until(() => ui.$('.ssv-dialog')); ui.click('.ssv-dialog [data-d=cancel]'); },
    hooksCalled: []
  };
  const h = { onServerChanged: async () => ui.hooksCalled.push('server'), onMembersChanged: () => ui.hooksCalled.push('members'), onChannelsChanged: () => ui.hooksCalled.push('channels'), onLeft: () => ui.hooksCalled.push('left'), ...hooks };
  ui.open = async section => { await w.ServerSettings.open(server, h, section); };
  return ui;
}

test.before(async () => {
  s = await startServer();
  owner = await registerUser(s.base, 'uiowner'); mod = await registerUser(s.base, 'uimod'); member = await registerUser(s.base, 'uimember');
  const r = await owner.post('/servers', { name: 'UI Server', description: 'desc' });
  sid = r.body.server.id; general = r.body.default_channel_id;
  const roles = (await owner.get(`/servers/${sid}/roles`)).body.roles;
  for (const u of [mod, member]) { const inv = (await owner.post(`/servers/${sid}/invites`, {})).body.invite.code; await u.post(`/invites/${inv}/join`); }
  await owner.patch(`/servers/${sid}/members/${mod.id}`, { add_role_ids: [roles.find(x => x.name === 'Moderator').id] });
});
test.after(async () => { if (s) await s.stop(); });

test('navigation: owner sees six sections; a moderator only the sections they can use; plain member cannot open', async () => {
  const o = await mount(owner);
  assert.equal(o.w.ServerSettings.canOpen(o.server), true);
  await o.open();
  assert.deepEqual(o.navItems(), ['Overview', 'Members', 'Roles', 'Channels', 'Moderation', 'Audit Log']);
  assert.equal(o.$('#ssv-title').textContent, 'Overview');
  await o.w.ServerSettings.close(true);
  assert.equal(o.$('#server-settings-view'), null, 'closing removes the panel');

  const m = await mount(mod);
  await m.open();
  assert.deepEqual(m.navItems(), ['Overview', 'Members', 'Moderation']);
  await until(() => m.$('#ov-name'));
  assert.ok(m.$('#ov-name').disabled, 'overview is read-only without Manage Server');
  await m.w.ServerSettings.close(true);

  const p = await mount(member);
  assert.equal(p.w.ServerSettings.canOpen(p.server), false);
});

test('overview: edit, dirty guard, save, persistence, and failed save keeps edits', async () => {
  const ui = await mount(owner);
  await ui.open();
  await until(() => ui.$('#ov-name'));
  assert.equal(ui.$('#ov-name').value, 'UI Server');
  assert.equal(ui.$('#ov-savebar').hidden, true);
  ui.type('#ov-name', 'UI Server 2');
  assert.equal(ui.$('#ov-savebar').hidden, false);
  // switching sections with unsaved changes asks first; "keep editing" stays put
  await ui.goto('members');
  await until(() => ui.$('.ssv-dialog'));
  assert.match(ui.$('.ssv-dialog').textContent, /Unsaved changes/);
  await ui.dialogCancel();
  assert.equal(ui.$('#ssv-title').textContent, 'Overview');
  assert.equal(ui.$('#ov-name').value, 'UI Server 2');
  // a rejected save shows the server's error and keeps the edit
  ui.type('#ov-name', 'x'.repeat(51));
  ui.click('[data-act=ov-save]');
  await until(() => /50 characters/.test(ui.$('#ov-error').textContent));
  assert.equal(ui.$('#ov-name').value.length, 51, 'edits preserved after failure');
  assert.equal((await owner.get(`/servers/${sid}`)).body.server.name, 'UI Server', 'nothing was saved');
  // a valid save persists and calls the sync hook
  ui.type('#ov-name', 'UI Server 2');
  ui.type('#ov-desc', 'new description');
  ui.click('[data-act=ov-save]');
  await until(() => ui.hooksCalled.includes('server'));
  assert.equal((await owner.get(`/servers/${sid}`)).body.server.name, 'UI Server 2');
  assert.equal((await owner.get(`/servers/${sid}`)).body.server.description, 'new description');
  await until(() => ui.$('#ov-savebar').hidden === true);
  assert.equal(ui.$('#ssv-server-name').textContent, 'UI Server 2');
  // closing with unsaved changes asks too
  ui.type('#ov-desc', 'unsaved');
  ui.click('[data-close]');
  await until(() => ui.$('.ssv-dialog'));
  await ui.dialogCancel();
  assert.ok(ui.$('#server-settings-view'), 'still open after Keep editing');
  ui.click('[data-close]');
  await until(() => ui.$('.ssv-dialog'));
  await ui.dialogOk();
  await until(() => !ui.$('#server-settings-view'));
});

test('overview: invites can be created and revoked; delete requires typing the name', async () => {
  const ui = await mount(owner);
  await ui.open();
  await until(() => ui.$('[data-act=invite-create]'));
  const before = (await owner.get(`/servers/${sid}/invites`)).body.invites.length;
  ui.click('[data-act=invite-create]');
  await until(async () => (await owner.get(`/servers/${sid}/invites`)).body.invites.length === before + 1);
  await until(() => ui.$$('[data-act=invite-revoke]').length >= 1);
  ui.click(ui.$$('[data-act=invite-revoke]')[0]);
  await ui.dialogOk();
  await until(async () => (await owner.get(`/servers/${sid}/invites`)).body.invites.some(i => i.revoked));
  // delete: confirm button stays disabled until the exact name is typed
  ui.click('[data-act=delete-server]');
  await until(() => ui.$('.ssv-dialog'));
  assert.equal(ui.$('.ssv-dialog [data-d=ok]').disabled, true);
  ui.type('#ssvf-confirm', 'wrong');
  assert.equal(ui.$('.ssv-dialog [data-d=ok]').disabled, true);
  await ui.dialogCancel();
  assert.equal((await owner.get(`/servers/${sid}`)).status, 200, 'server not deleted');
  await ui.w.ServerSettings.close(true);
});

test('roles: create, edit permissions with unsaved guard, save, persist, reorder, delete', async () => {
  const ui = await mount(owner);
  await ui.open('roles');
  await until(() => ui.$('[data-act=r-create]'));
  ui.click('[data-act=r-create]');
  await until(() => ui.$('#ssvf-name'));
  assert.equal(ui.$('.ssv-dialog [data-d=ok]').disabled, true, 'name required');
  ui.type('#ssvf-name', 'Support');
  await ui.dialogOk();
  await until(() => ui.$('#rl-name') && ui.$('#rl-name').value === 'Support');
  // toggle "Kick members" and set a colour; savebar appears
  const kick = ui.$('input[data-bit="64"]');
  ui.check(kick, true);
  ui.type('#rl-color-hex', '#ff8800');
  assert.equal(ui.$('#rl-savebar').hidden, false);
  // switching away from the dirty role asks first
  const adminItem = ui.$$('.ssv-role-item').find(e => /Admin/.test(e.textContent));
  ui.click(adminItem);
  await until(() => ui.$('.ssv-dialog'));
  await ui.dialogCancel();
  assert.equal(ui.$('#rl-name').value, 'Support');
  ui.click('[data-act=r-save]');
  await until(async () => (await owner.get(`/servers/${sid}/roles`)).body.roles.find(r => r.name === 'Support').permissions === 64);
  const saved = (await owner.get(`/servers/${sid}/roles`)).body.roles.find(r => r.name === 'Support');
  assert.equal(saved.color, '#ff8800');
  await until(() => ui.$('#rl-savebar').hidden === true);
  // invalid colour is rejected client-side without a request
  ui.type('#rl-color-hex', 'nope');
  ui.click('[data-act=r-save]');
  assert.match(ui.$('#rl-error').textContent, /#RRGGBB/);
  ui.click('[data-act=r-reset]');
  // reorder: move Support up one place
  const names = () => ui.$$('.ssv-role-item .ssv-name').map(e => e.textContent);
  assert.deepEqual(names(), ['Admin', 'Moderator', 'Support', 'Member']);
  ui.click(ui.$$('.ssv-role-item').find(e => /Support/.test(e.textContent)).querySelector('[data-act=r-up]'));
  await until(() => names().join() === 'Admin,Support,Moderator,Member');
  assert.deepEqual((await owner.get(`/servers/${sid}/roles`)).body.roles.map(r => r.name), ['Admin', 'Support', 'Moderator', 'Member']);
  // the default role has no delete / reorder controls
  ui.click(ui.$$('.ssv-role-item').find(e => /Member/.test(e.textContent)));
  await until(() => ui.$('#rl-name').value === 'Member');
  assert.equal(ui.$('[data-act=r-delete]'), null);
  // delete Support
  ui.click(ui.$$('.ssv-role-item').find(e => /Support/.test(e.textContent)));
  await until(() => ui.$('#rl-name').value === 'Support');
  ui.click('[data-act=r-delete]');
  await ui.dialogOk();
  await until(async () => !(await owner.get(`/servers/${sid}/roles`)).body.roles.some(r => r.name === 'Support'));
  await ui.w.ServerSettings.close(true);
});

test('members: list, search, empty state, role edit, kick/ban flow and hierarchy-hidden actions', async () => {
  const ui = await mount(owner);
  await ui.open('members');
  await until(() => ui.$$('#mb-list .ssv-trow').length === 3);
  ui.type('#mb-search', member.username);
  await until(() => ui.$$('#mb-list .ssv-trow').length === 1);
  assert.match(ui.$('#mb-list').textContent, new RegExp(member.username));
  ui.type('#mb-search', 'zzzzzz-nobody');
  await until(() => /No members match/.test(ui.$('#mb-list').textContent));
  ui.type('#mb-search', '');
  await until(() => ui.$$('#mb-list .ssv-trow').length === 3);
  // edit roles via dialog: give the member "Moderator"
  const row = ui.$$('#mb-list .ssv-trow').find(r => r.textContent.includes(member.username));
  ui.click(row.querySelector('[data-act=m-roles]'));
  await until(() => ui.$('.ssv-checklist'));
  const box = ui.$$('.ssv-checklist input').find(i => /Moderator/.test(i.parentElement.textContent));
  box.checked = true; box.dispatchEvent(new ui.w.Event('change', { bubbles: true }));
  await ui.dialogOk();
  await until(async () => (await owner.get(`/servers/${sid}/members?search=${member.username}`)).body.members[0].roles.some(r => r.name === 'Moderator'));
  await until(() => ui.hooksCalled.includes('members'));
  // the owner has no kick/ban buttons on their own row
  await until(() => ui.$$('#mb-list .ssv-trow').length === 3);
  const ownRow = ui.$$('#mb-list .ssv-trow').find(r => r.textContent.includes('Owner'));
  assert.equal(ownRow.querySelector('[data-act=m-kick]'), null);
  assert.equal(ownRow.querySelector('[data-act=m-ban]'), null);
  // ban with a reason through the dialog
  await until(() => ui.$$('#mb-list .ssv-trow').find(r => r.textContent.includes(member.username)));
  const row2 = ui.$$('#mb-list .ssv-trow').find(r => r.textContent.includes(member.username));
  ui.click(row2.querySelector('[data-act=m-ban]'));
  await until(() => ui.$('#ssvf-reason'));
  ui.type('#ssvf-reason', 'ui test');
  await ui.dialogOk();
  await until(async () => (await owner.get(`/servers/${sid}/bans`)).body.total === 1);
  assert.equal((await owner.get(`/servers/${sid}/bans`)).body.bans[0].reason, 'ui test');
  await until(() => ui.$$('#mb-list .ssv-trow').length === 2);
  // moderator view: cannot act on the owner, no role button without permission
  const m = await mount(mod);
  await m.open('members');
  await until(() => m.$$('#mb-list .ssv-trow').length === 2);
  const modOwnerRow = m.$$('#mb-list .ssv-trow').find(r => r.textContent.includes('Owner'));
  assert.equal(modOwnerRow.querySelector('[data-act=m-kick]'), null);
  assert.equal(m.$('[data-act=m-roles]'), null);
  await ui.w.ServerSettings.close(true); await m.w.ServerSettings.close(true);
});

test('moderation: ban-list search, unban, and timeouts list', async () => {
  const ui = await mount(owner);
  await ui.open('moderation');
  await until(() => ui.$$('#md-bans .ssv-trow').length === 1);
  ui.type('#md-search-bans', 'nomatchxyz');
  await until(() => /No bans match/.test(ui.$('#md-bans').textContent));
  ui.type('#md-search-bans', 'ui test');
  await until(() => ui.$$('#md-bans .ssv-trow').length === 1);
  assert.match(ui.$('#md-timeouts').textContent, /No active timeouts/);
  ui.click('[data-act=unban]');
  await ui.dialogOk();
  await until(async () => (await owner.get(`/servers/${sid}/bans`)).body.total === 0);
  await until(() => /No bans|No banned/.test(ui.$('#md-bans').textContent));
  // ban someone from the search box (owner → admin-less test user "member" rejoined first)
  const inv = (await owner.post(`/servers/${sid}/invites`, {})).body.invite.code;
  await member.post(`/invites/${inv}/join`);
  ui.type('#md-search-member', member.username);
  await until(() => ui.$('[data-act=md-ban]'));
  ui.click('[data-act=md-ban]');
  await until(() => ui.$('#ssvf-reason'));
  await ui.dialogOk();
  await until(async () => (await owner.get(`/servers/${sid}/bans`)).body.total === 1);
  await owner.del(`/servers/${sid}/bans/${member.id}`);
  await ui.w.ServerSettings.close(true);
});

test('channels: create category + channel, move, edit, permissions override, delete', async () => {
  const ui = await mount(owner);
  await ui.open('channels');
  await until(() => ui.$('[data-act=cat-create]'));
  ui.click('[data-act=cat-create]');
  await until(() => ui.$('#ssvf-name'));
  ui.type('#ssvf-name', 'Text Zone');
  await ui.dialogOk();
  await until(() => /Text Zone/.test(ui.$('#ssv-content').textContent));
  ui.click('[data-act=c-create]');
  await until(() => ui.$('#ssvf-name'));
  ui.type('#ssvf-name', 'Ideas Room');
  ui.type('#ssvf-topic', 'brainstorm');
  const cat = (await owner.get(`/servers/${sid}/channels`)).body.categories[0];
  ui.type('#ssvf-cat', cat.id);
  await ui.dialogOk();
  await until(async () => (await owner.get(`/servers/${sid}/channels`)).body.channels.some(c => c.name === 'ideas-room' && c.category_id === cat.id));
  assert.ok(ui.hooksCalled.includes('channels'));
  const rowOf = n => ui.$$('[data-cid]').find(r => r.textContent.includes(n));
  await until(() => rowOf('ideas-room'));
  assert.match(rowOf('ideas-room').textContent, /brainstorm/);
  // edit: rename + move to no category
  await until(() => rowOf('ideas-room') && rowOf('ideas-room').querySelector('[data-act=c-edit]'));
  ui.click(rowOf('ideas-room').querySelector('[data-act=c-edit]'));
  await until(() => ui.$('#ssvf-name'));
  ui.type('#ssvf-name', 'ideas');
  ui.type('#ssvf-cat', '');
  await ui.dialogOk();
  await until(async () => (await owner.get(`/servers/${sid}/channels`)).body.channels.some(c => c.name === 'ideas' && !c.category_id));
  // channel permissions: deny VIEW for the default role, verify enforcement via API
  await until(() => rowOf('ideas') && !rowOf('ideas-room'));
  ui.click(rowOf('ideas').querySelector('[data-act=c-perms]'));
  await until(() => ui.$('[data-act=o-add]'));
  const sel = ui.$('#o-add');
  const memberRole = [...sel.options].find(o => o.textContent === 'Member');
  ui.type('#o-add', memberRole.value);
  ui.click('[data-act=o-add]');
  await until(() => ui.$('[data-act=o-save]'));
  const viewSel = ui.$$('select[data-bit="1"]')[0];
  viewSel.value = 'deny'; viewSel.dispatchEvent(new ui.w.Event('change', { bubbles: true }));
  ui.click('[data-act=o-save]');
  const ideas = (await owner.get(`/servers/${sid}/channels`)).body.channels.find(c => c.name === 'ideas');
  await until(async () => (await mod.get(`/channels/${ideas.id}/messages`)).status === 403 || (await mod.get(`/servers/${sid}/channels`)).body.channels.every(c => c.id !== ideas.id));
  assert.ok(!(await mod.get(`/servers/${sid}/channels`)).body.channels.some(c => c.id === ideas.id), 'hidden from a member by the UI-created override');
  ui.click('[data-act=c-back]');
  await until(() => ui.$('[data-act=c-create]'));
  // delete channel + category
  await until(() => rowOf('ideas'));
  ui.click(rowOf('ideas').querySelector('[data-act=c-delete]'));
  await ui.dialogOk();
  await until(async () => !(await owner.get(`/servers/${sid}/channels`)).body.channels.some(c => c.name === 'ideas'));
  ui.click(ui.$('[data-act=cat-delete]'));
  await ui.dialogOk();
  await until(async () => (await owner.get(`/servers/${sid}/channels`)).body.categories.length === 0);
  await ui.w.ServerSettings.close(true);
});

test('audit log: shows readable entries, filters, empty and error states', async () => {
  const ui = await mount(owner);
  await ui.open('audit');
  await until(() => ui.$$('#au-list .ssv-audit-row').length > 3);
  assert.match(ui.$('#au-list').textContent, /banned|created the role|updated/i);
  ui.type('#au-action', 'role.create');
  await until(() => ui.$$('#au-list .ssv-audit-row').length >= 1 && ui.$$('#au-list .ssv-audit-row').every(r => /created the role/.test(r.textContent)));
  ui.type('#au-q', 'no-such-target-zzz');
  await until(() => /No audit log entries/.test(ui.$('#au-list').textContent));
  ui.click('[data-act=au-clear]');
  await until(() => ui.$$('#au-list .ssv-audit-row').length > 3);
  // a user without the permission never sees the section, and the API refuses direct access
  const m = await mount(mod);
  await m.open();
  assert.ok(!m.navItems().includes('Audit Log'));
  assert.equal((await mod.get(`/servers/${sid}/audit-log`)).status, 403);
  await m.w.ServerSettings.close(true);
  // server error → error state with retry
  ui.w.api = async () => ({ error: 'boom' });
  ui.click('[data-act=au-clear]');
  await until(() => /boom/.test(ui.$('#au-list').textContent) && ui.$('[data-act=retry]'));
  await ui.w.ServerSettings.close(true);
});

test('XSS: hostile names are escaped in every list', async () => {
  const evil = '<img src=x onerror=window.__pwned=1>';
  await owner.patch(`/servers/${sid}`, { name: evil });
  await owner.post(`/servers/${sid}/roles`, { name: evil });
  const ui = await mount(owner);
  await ui.open('roles');
  await until(() => ui.$$('.ssv-role-item').length >= 3);
  assert.equal(ui.$('.ssv-roleeditor img'), null);
  assert.equal(ui.$$('.ssv-role-item img').length, 0);
  assert.equal(ui.$('#ssv-server-name img'), null);
  assert.equal(ui.w.__pwned, undefined);
  await ui.w.ServerSettings.close(true);
});

test('ownership transfer UI: only owners see it, confirmation must match, result is applied and the old owner loses the panel', async () => {
  const o = await registerUser(s.base, 'swapowner'), m = await registerUser(s.base, 'swapmember');
  const r = await o.post('/servers', { name: 'Swap Server' });
  const sid2 = r.body.server.id;
  const inv = (await o.post(`/servers/${sid2}/invites`, {})).body.invite.code; await m.post(`/invites/${inv}/join`);

  const ui = await mount(o, {}, sid2);
  await ui.open('members');
  await until(() => ui.$$('#mb-list .ssv-trow').length === 2);
  const rowOf = u => ui.$$('#mb-list .ssv-trow').find(x => x.textContent.includes(u.username));
  assert.equal(rowOf(o).querySelector('[data-act=m-owner]'), null, 'no "Make owner" on your own row');
  assert.ok(rowOf(m).querySelector('[data-act=m-owner]'), 'owner sees "Make owner" on other members');
  // Overview mentions it too, pointing at Members
  await ui.goto('overview');
  await until(() => ui.$('[data-act=goto-members]'));
  ui.click('[data-act=goto-members]');
  await until(() => ui.$('#ssv-title').textContent === 'Members');
  await until(() => ui.$$('#mb-list .ssv-trow').length === 2);

  // dialog: confirm stays disabled until the exact name is typed, cancel changes nothing
  ui.click(rowOf(m).querySelector('[data-act=m-owner]'));
  await until(() => ui.$('#ssvf-confirm'));
  assert.equal(ui.$('.ssv-dialog [data-d=ok]').disabled, true);
  ui.type('#ssvf-confirm', 'swap server');
  assert.equal(ui.$('.ssv-dialog [data-d=ok]').disabled, true, 'exact match required');
  await ui.dialogCancel();
  assert.equal((await o.get(`/servers/${sid2}`)).body.server.owner_id, o.id);

  // confirm for real
  ui.click(rowOf(m).querySelector('[data-act=m-owner]'));
  await until(() => ui.$('#ssvf-confirm'));
  ui.type('#ssvf-confirm', 'Swap Server');
  await ui.dialogOk();
  await until(async () => (await o.get(`/servers/${sid2}`)).body.server.owner_id === m.id);
  await until(() => ui.hooksCalled.includes('server'), 3000);

  // the new owner sees the control on the former owner; a former owner who keeps Admin can still open the panel
  const ui2 = await mount(m, {}, sid2);
  await ui2.open('members');
  await until(() => ui2.$$('#mb-list .ssv-trow').length === 2);
  assert.ok(ui2.$$('#mb-list .ssv-trow').find(x => x.textContent.includes(o.username)).querySelector('[data-act=m-owner]'));
  assert.equal(ui2.$$('#mb-list .ssv-trow').find(x => x.textContent.includes(m.username)).querySelector('[data-act=m-owner]'), null);

  // once the new owner removes the former owner's Admin role, the former owner has nothing to manage:
  // when the app refreshes the server (what the dashboard does on the live event) the panel closes itself
  const adminRole = (await m.get(`/servers/${sid2}/roles`)).body.roles.find(x => x.name === 'Admin').id;
  await m.patch(`/servers/${sid2}/members/${o.id}`, { remove_role_ids: [adminRole] });
  const fresh = (await o.get('/servers')).body.servers.find(x => x.id === sid2);
  assert.equal(fresh.is_owner, false);
  ui.w.ServerSettings.syncServer(fresh);
  await until(() => !ui.$('#server-settings-view'));
  assert.equal(ui.w.ServerSettings.canOpen(fresh), false);
  await ui2.w.ServerSettings.close(true);
});
