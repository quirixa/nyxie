// Integration tests for the 0.2.0 Server Settings backend. Each run boots
// the real server on a temp data dir. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, registerUser, openWs, sleep } = require('./helpers');

const P = {
  VIEW: 1, SEND: 2, CHANNELS: 4, SERVER: 8, MEMBERS: 16, INVITES: 32, KICK: 64, BAN: 128,
  MSGS: 256, ROLES: 512, ADMIN: 1024, AUDIT: 2048, TIMEOUT: 4096, HISTORY: 8192, ATTACH: 16384
};

let s, owner, sid, roles, general;
const users = {};

async function join(u) {
  const inv = await owner.post(`/servers/${sid}/invites`, {});
  const r = await u.post(`/invites/${inv.body.invite.code}/join`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
const roleId = name => roles.find(r => r.name === name).id;
async function refreshRoles() { roles = (await owner.get(`/servers/${sid}/roles`)).body.roles; }
async function audit(q = '') { return (await owner.get(`/servers/${sid}/audit-log?page_size=50${q}`)).body; }

test.before(async () => {
  s = await startServer();
  owner = await registerUser(s.base, 'owner');
  for (const n of ['admin', 'mod', 'mod2', 'member', 'victim', 'outsider']) users[n] = await registerUser(s.base, n);
  const r = await owner.post('/servers', { name: 'Test Server', description: 'hello' });
  sid = r.body.server.id; general = r.body.default_channel_id;
  await refreshRoles();
  for (const n of ['admin', 'mod', 'mod2', 'member', 'victim']) await join(users[n]);
  assert.equal((await owner.patch(`/servers/${sid}/members/${users.admin.id}`, { add_role_ids: [roleId('Admin')] })).status, 200);
  assert.equal((await owner.patch(`/servers/${sid}/members/${users.mod.id}`, { add_role_ids: [roleId('Moderator')] })).status, 200);
  assert.equal((await owner.patch(`/servers/${sid}/members/${users.mod2.id}`, { add_role_ids: [roleId('Moderator')] })).status, 200);
});
test.after(async () => { if (s) await s.stop(); });

// ─── Overview ────────────────────────────────────────────────────
test('overview: edits persist, are validated, and are authorised', async () => {
  let r = await owner.patch(`/servers/${sid}`, { name: 'Renamed', description: 'new desc' });
  assert.equal(r.status, 200);
  assert.equal((await owner.get(`/servers/${sid}`)).body.server.name, 'Renamed');
  assert.equal((await owner.get(`/servers/${sid}`)).body.server.description, 'new desc');
  assert.equal((await owner.patch(`/servers/${sid}`, { name: '   ' })).status, 400);
  assert.equal((await owner.patch(`/servers/${sid}`, { name: 'x'.repeat(51) })).status, 400);
  assert.equal((await owner.patch(`/servers/${sid}`, { description: 'x'.repeat(301) })).status, 400);
  assert.equal((await owner.patch(`/servers/${sid}`, { name: 123 })).status, 400);
  assert.equal((await owner.patch(`/servers/${sid}`, { category: 'nope' })).status, 400);
  assert.equal((await owner.patch(`/servers/${sid}`, { icon: '/uploads/does-not-exist.png' })).status, 400);
  assert.equal((await owner.patch(`/servers/${sid}`, { icon: 'http://evil/x.png' })).status, 400);
  assert.equal((await owner.patch(`/servers/${sid}`, { owner_id: users.member.id })).status, 400, 'unknown fields do nothing');
  assert.equal((await owner.get(`/servers/${sid}`)).body.server.owner_id, owner.id);
  // plain member and moderator (no MANAGE_SERVER) are refused
  assert.equal((await users.member.patch(`/servers/${sid}`, { name: 'hack' })).status, 403);
  assert.equal((await users.mod.patch(`/servers/${sid}`, { name: 'hack' })).status, 403);
  // outsider can't even see it
  assert.equal((await users.outsider.patch(`/servers/${sid}`, { name: 'hack' })).status, 404);
  // no-op writes no audit
  const before = (await audit('&action=server')).total;
  await owner.patch(`/servers/${sid}`, { name: 'Renamed' });
  assert.equal((await audit('&action=server')).total, before);
});

test('overview: icon upload is validated by real content', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const up = async (buf, name) => {
    const fd = new FormData(); fd.append('file', new Blob([buf]), name);
    const res = await fetch(s.base + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token }, body: fd });
    return (await res.json()).url;
  };
  const good = await up(png, 'icon.png');
  assert.equal((await owner.patch(`/servers/${sid}`, { icon: good })).status, 200);
  assert.equal((await owner.get(`/servers/${sid}`)).body.server.icon, good);
  const fake = await up(Buffer.from('<script>alert(1)</script>'), 'fake.png');
  assert.equal((await owner.patch(`/servers/${sid}`, { icon: fake })).status, 400);
  const svg = await up(Buffer.from('<svg/>'), 'x.svg');
  assert.equal((await owner.patch(`/servers/${sid}`, { icon: svg })).status, 400);
  assert.equal((await owner.patch(`/servers/${sid}`, { icon: null })).status, 200);
  assert.equal((await owner.get(`/servers/${sid}`)).body.server.icon, null);
  assert.ok((await audit('&action=server.icon_update')).total >= 2);
});

test('overview: member count is accurate', async () => {
  const srv = (await owner.get(`/servers/${sid}`)).body.server;
  assert.equal(srv.member_count, 6);
});

// ─── Roles ───────────────────────────────────────────────────────
test('roles: create/edit/colour/validation; new roles are at the bottom', async () => {
  let r = await owner.post(`/servers/${sid}/roles`, { name: 'Helper', color: '#33aa66', permissions: P.VIEW | P.SEND });
  assert.equal(r.status, 201);
  assert.equal(r.body.role.position, 1);
  const helper = r.body.role.id;
  await refreshRoles();
  assert.deepEqual(roles.map(x => x.name), ['Admin', 'Moderator', 'Helper', 'Member']);
  assert.equal((await owner.post(`/servers/${sid}/roles`, { name: '' })).status, 400);
  assert.equal((await owner.post(`/servers/${sid}/roles`, { name: 'Bad', color: 'red' })).status, 400);
  assert.equal((await owner.post(`/servers/${sid}/roles`, { name: 'Bad', permissions: 1 << 25 })).status, 400, 'unknown bits');
  assert.equal((await owner.post(`/servers/${sid}/roles`, { name: 'Bad', permissions: -1 })).status, 400);
  r = await owner.patch(`/servers/${sid}/roles/${helper}`, { name: 'Helpers', color: '#112233' });
  assert.equal(r.status, 200);
  assert.equal(r.body.role.color, '#112233');
  await refreshRoles();
  assert.equal(roles.find(x => x.id === helper).name, 'Helpers');
});

test('roles: administrators (non-owner) can create roles with permissions', async () => {
  const r = await users.admin.post(`/servers/${sid}/roles`, { name: 'ByAdmin', permissions: P.VIEW | P.SEND | P.KICK });
  assert.equal(r.status, 201);
  assert.equal(r.body.role.permissions, P.VIEW | P.SEND | P.KICK, 'permissions must not be silently stripped');
  await owner.del(`/servers/${sid}/roles/${r.body.role.id}`);
});

test('roles: escalation attempts are rejected', async () => {
  await refreshRoles();
  const mod = users.mod;
  // mod has no MANAGE_ROLES at all
  assert.equal((await mod.post(`/servers/${sid}/roles`, { name: 'x' })).status, 403);
  // give Moderator MANAGE_ROLES (owner action), then try to escalate
  const modRole = roleId('Moderator');
  const modPerms = roles.find(r => r.id === modRole).permissions;
  assert.equal((await owner.patch(`/servers/${sid}/roles/${modRole}`, { permissions: modPerms | P.ROLES })).status, 200);
  // cannot create a role containing a permission they lack (BAN)
  assert.equal((await mod.post(`/servers/${sid}/roles`, { name: 'Esc', permissions: P.BAN })).status, 403);
  // cannot edit Admin or their own role
  assert.equal((await mod.patch(`/servers/${sid}/roles/${roleId('Admin')}`, { name: 'x' })).status, 403);
  assert.equal((await mod.patch(`/servers/${sid}/roles/${modRole}`, { permissions: P.ADMIN })).status, 403);
  // cannot assign Admin to anyone, nor to themselves
  assert.equal((await mod.patch(`/servers/${sid}/members/${users.member.id}`, { add_role_ids: [roleId('Admin')] })).status, 403);
  assert.equal((await mod.patch(`/servers/${sid}/members/${mod.id}`, { add_role_ids: [roleId('Admin')] })).status, 403);
  // cannot touch an equal-rank moderator
  assert.equal((await mod.patch(`/servers/${sid}/members/${users.mod2.id}`, { add_role_ids: [roleId('Helpers')] })).status, 403);
  // can assign a lower role they fully hold permissions for
  const low = await mod.post(`/servers/${sid}/roles`, { name: 'Low', permissions: P.VIEW });
  assert.equal(low.status, 201);
  assert.equal((await mod.patch(`/servers/${sid}/members/${users.member.id}`, { add_role_ids: [low.body.role.id] })).status, 200);
  // a role holding a bit the mod lacks (Helpers has none beyond; make one with ban)
  const banRole = (await owner.post(`/servers/${sid}/roles`, { name: 'BanRole', permissions: P.BAN })).body.role;
  assert.equal((await mod.patch(`/servers/${sid}/members/${users.member.id}`, { add_role_ids: [banRole.id] })).status, 403, 'cannot hand out permissions you lack');
  // reordering: cannot move anything above own rank
  await refreshRoles();
  const ids = roles.filter(r => !r.is_default).map(r => r.id);
  const bad = [ids[1], ids[0], ...ids.slice(2)]; // swap Admin and Moderator
  assert.equal((await mod.put(`/servers/${sid}/roles/order`, { role_ids: bad })).status, 403);
  // legitimate reorder below own rank works
  const lowerIds = ids.slice(2);
  if (lowerIds.length > 1) {
    const swapped = [...ids.slice(0, 2), lowerIds[1], lowerIds[0], ...lowerIds.slice(2)];
    assert.equal((await mod.put(`/servers/${sid}/roles/order`, { role_ids: swapped })).status, 200);
  }
  assert.equal((await mod.put(`/servers/${sid}/roles/order`, { role_ids: ids.slice(1) })).status, 400, 'must list every role');
  // restore and clean up
  await owner.patch(`/servers/${sid}/roles/${modRole}`, { permissions: modPerms });
  await owner.del(`/servers/${sid}/roles/${banRole.id}`);
  await owner.del(`/servers/${sid}/roles/${low.body.role.id}`);
});

test('roles: deleting a role reassigns members to the default role; default cannot be deleted', async () => {
  const r = (await owner.post(`/servers/${sid}/roles`, { name: 'Temp', permissions: P.VIEW | P.SEND })).body.role;
  await owner.patch(`/servers/${sid}/members/${users.victim.id}`, { add_role_ids: [r.id] });
  let members = (await owner.get(`/servers/${sid}/members?page=1&search=victim`)).body.members;
  assert.ok(members[0].roles.some(x => x.id === r.id));
  assert.equal((await owner.del(`/servers/${sid}/roles/${r.id}`)).status, 200);
  members = (await owner.get(`/servers/${sid}/members?page=1&search=victim`)).body.members;
  assert.deepEqual(members[0].roles.map(x => x.name), ['Member']);
  await refreshRoles();
  assert.equal((await owner.del(`/servers/${sid}/roles/${roleId('Member')}`)).status, 400);
  assert.equal((await owner.del(`/servers/${sid}/roles/${r.id}`)).status, 404, 'repeat is safe');
});

// ─── Members ─────────────────────────────────────────────────────
test('members: search and pagination', async () => {
  let r = await owner.get(`/servers/${sid}/members?page=1&page_size=2`);
  assert.equal(r.body.members.length, 2);
  assert.equal(r.body.total, 6);
  assert.equal(r.body.has_more, true);
  r = await owner.get(`/servers/${sid}/members?search=${users.victim.username}`);
  assert.deepEqual(r.body.members.map(m => m.id), [users.victim.id]);
  r = await owner.get(`/servers/${sid}/members?search=${encodeURIComponent('%')}`);
  assert.equal(r.body.total, 0, 'LIKE wildcards are escaped');
  r = await owner.get(`/servers/${sid}/members`);
  assert.equal(r.body.members.length, 6, 'unpaged call still returns everyone');
  assert.equal((await users.outsider.get(`/servers/${sid}/members`)).status, 404);
});

test('members: kick enforces permission, hierarchy and owner protection', async () => {
  assert.equal((await users.member.del(`/servers/${sid}/members/${users.victim.id}`)).status, 403);
  assert.equal((await users.mod.del(`/servers/${sid}/members/${users.admin.id}`)).status, 403);
  assert.equal((await users.mod.del(`/servers/${sid}/members/${users.mod2.id}`)).status, 403);
  assert.equal((await users.admin.del(`/servers/${sid}/members/${owner.id}`)).status, 403);
  assert.equal((await users.admin.del(`/servers/${sid}/members/${users.admin.id}`)).status, 400);
  assert.equal((await users.mod.del(`/servers/${sid}/members/${users.outsider.id}`)).status, 404);
});

// ─── Channels / categories / overrides ───────────────────────────
test('channels: create/edit/delete validate, authorise and audit', async () => {
  assert.equal((await users.member.post(`/servers/${sid}/channels`, { name: 'x' })).status, 403);
  assert.equal((await owner.post(`/servers/${sid}/channels`, { name: '' })).status, 400);
  assert.equal((await owner.post(`/servers/${sid}/channels`, { name: 'ok', description: 'x'.repeat(201) })).status, 400);
  const c = await owner.post(`/servers/${sid}/channels`, { name: 'Dev Talk!!', description: 'topic' });
  assert.equal(c.status, 201);
  assert.equal(c.body.channel.name, 'dev-talk-');
  const id = c.body.channel.id;
  assert.equal((await owner.patch(`/channels/${id}`, { description: 'new topic' })).status, 200);
  assert.equal((await owner.patch(`/channels/${id}`, { name: '$$$' })).status, 200, 'sanitised to dashes');
  assert.equal((await owner.patch(`/channels/${id}`, { category_id: 'nope' })).status, 400);
  assert.equal((await users.member.patch(`/channels/${id}`, { name: 'zzz' })).status, 403);
  assert.equal((await users.member.del(`/channels/${id}`)).status, 403);
  assert.equal((await owner.del(`/channels/${id}`)).status, 200);
  assert.equal((await owner.del(`/channels/${id}`)).status, 404);
  const chans = (await owner.get(`/servers/${sid}/channels`)).body.channels;
  assert.ok(!chans.some(x => x.id === id));
  assert.equal((await owner.post(`/channels/${id}/messages`, { content: 'hi' })).status, 404, 'deleted channel accepts nothing');
});

test('categories + layout: create, move channels, reorder, delete keeps channels', async () => {
  const cat = (await owner.post(`/servers/${sid}/categories`, { name: 'Text' })).body.category;
  const cat2 = (await owner.post(`/servers/${sid}/categories`, { name: 'Other' })).body.category;
  assert.equal((await owner.post(`/servers/${sid}/categories`, { name: ' ' })).status, 400);
  assert.equal((await users.member.post(`/servers/${sid}/categories`, { name: 'x' })).status, 403);
  const c2 = (await owner.post(`/servers/${sid}/channels`, { name: 'second', category_id: cat.id })).body.channel;
  let list = (await owner.get(`/servers/${sid}/channels`)).body;
  assert.equal(list.categories.length, 2);
  // layout must be complete
  assert.equal((await owner.put(`/servers/${sid}/channel-layout`, { categories: [cat.id], channels: [] })).status, 400);
  const layout = { categories: [cat2.id, cat.id], channels: [{ id: c2.id, category_id: cat2.id }, { id: general, category_id: null }] };
  assert.equal((await owner.put(`/servers/${sid}/channel-layout`, layout)).status, 200);
  list = (await owner.get(`/servers/${sid}/channels`)).body;
  assert.equal(list.channels.find(c => c.id === c2.id).category_id, cat2.id);
  assert.deepEqual(list.categories.map(c => c.id), [cat2.id, cat.id]);
  assert.equal((await owner.put(`/servers/${sid}/channel-layout`, layout)).body.changed, false, 'idempotent');
  assert.equal((await owner.patch(`/servers/${sid}/categories/${cat.id}`, { name: 'Renamed' })).status, 200);
  assert.equal((await owner.del(`/servers/${sid}/categories/${cat2.id}`)).status, 200);
  list = (await owner.get(`/servers/${sid}/channels`)).body;
  assert.equal(list.channels.find(c => c.id === c2.id).category_id, null, 'channel survives category deletion');
  assert.equal((await owner.del(`/servers/${sid}/categories/${cat2.id}`)).status, 404);
  await owner.del(`/servers/${sid}/categories/${cat.id}`);
  await owner.del(`/channels/${c2.id}`);
});

test('private channels: overrides hide history, posting, listing and live WS from members', async () => {
  const priv = (await owner.post(`/servers/${sid}/channels`, { name: 'staff' })).body.channel;
  await owner.post(`/channels/${priv.id}/messages`, { content: 'secret before' });
  const memberRole = roleId('Member');
  // member sees it first, and joins over WS
  assert.ok((await users.member.get(`/servers/${sid}/channels`)).body.channels.some(c => c.id === priv.id));
  const wsM = await openWs(s.base, users.member.token);
  wsM.send({ type: 'join_room', room_id: priv.id });
  await wsM.waitFor(m => m.type === 'joined_room' && m.room_id === priv.id);
  // deny VIEW for Member role
  assert.equal((await users.member.put(`/servers/${sid}/channels/${priv.id}/overrides/${memberRole}`, { allow: 0, deny: P.VIEW })).status, 403);
  assert.equal((await owner.put(`/servers/${sid}/channels/${priv.id}/overrides/${memberRole}`, { allow: P.VIEW, deny: P.VIEW })).status, 400);
  assert.equal((await owner.put(`/servers/${sid}/channels/${priv.id}/overrides/${memberRole}`, { allow: 0, deny: P.MSGS })).status, 400, 'non-overridable bit');
  assert.equal((await owner.put(`/servers/${sid}/channels/${priv.id}/overrides/${memberRole}`, { allow: 0, deny: P.VIEW })).status, 200);
  assert.equal((await users.member.get(`/channels/${priv.id}/messages`)).status, 403);
  assert.equal((await users.member.post(`/channels/${priv.id}/messages`, { content: 'x' })).status, 403);
  assert.equal((await users.member.get(`/rooms/${priv.id}/messages`)).status, 403, 'via rooms API too');
  assert.ok(!(await users.member.get(`/servers/${sid}/channels`)).body.channels.some(c => c.id === priv.id), 'hidden from listing');
  assert.ok(!(await users.member.get(`/rooms?server_id=${sid}`)).body.rooms.some(c => c.id === priv.id), 'hidden from rooms listing');
  // live socket was revalidated: owner's new message must not reach the member
  await owner.post(`/channels/${priv.id}/messages`, { content: 'secret after' });
  await sleep(300);
  assert.ok(!wsM.msgs.some(m => m.type === 'new_message' && m.message.room_id === priv.id), 'no live leak');
  assert.ok(wsM.msgs.some(m => m.type === 'room_access_revoked' && m.room_id === priv.id));
  // fresh join is refused too
  wsM.send({ type: 'join_room', room_id: priv.id });
  await wsM.waitFor(m => m.type === 'error' && m.message === 'Missing permission');
  // a role allow for a specific role restores access (allow beats deny)
  const vip = (await owner.post(`/servers/${sid}/roles`, { name: 'VIP', permissions: P.VIEW })).body.role;
  await owner.put(`/servers/${sid}/channels/${priv.id}/overrides/${vip.id}`, { allow: P.VIEW | P.SEND | P.HISTORY, deny: 0 });
  await owner.patch(`/servers/${sid}/members/${users.member.id}`, { add_role_ids: [vip.id] });
  assert.equal((await users.member.get(`/channels/${priv.id}/messages`)).status, 200);
  assert.equal((await users.member.post(`/channels/${priv.id}/messages`, { content: 'vip says hi' })).status, 201);
  await owner.patch(`/servers/${sid}/members/${users.member.id}`, { remove_role_ids: [vip.id] });
  assert.equal((await users.member.get(`/channels/${priv.id}/messages`)).status, 403);
  // owner and admins bypass overrides
  assert.equal((await users.admin.get(`/channels/${priv.id}/messages`)).status, 200);
  assert.equal((await owner.get(`/servers/${sid}/channels/${priv.id}/overrides`)).body.overrides.length, 2);
  assert.equal((await owner.del(`/servers/${sid}/channels/${priv.id}/overrides/${vip.id}`)).status, 200);
  assert.equal((await owner.del(`/servers/${sid}/channels/${priv.id}/overrides/${vip.id}`)).status, 404);
  wsM.close();
  await owner.del(`/servers/${sid}/roles/${vip.id}`);
  await owner.del(`/channels/${priv.id}`);
});

test('permissions: SEND_MESSAGES / READ_MESSAGE_HISTORY / ATTACH_FILES are enforced', async () => {
  const role = (await owner.post(`/servers/${sid}/roles`, { name: 'Limited', permissions: P.VIEW })).body.role;
  const memberRole = roleId('Member');
  const memberPerms = (await owner.get(`/servers/${sid}/roles`)).body.roles.find(r => r.id === memberRole).permissions;
  // strip the baseline so only 'Limited' counts for this user
  await owner.patch(`/servers/${sid}/roles/${memberRole}`, { permissions: 0 });
  await owner.patch(`/servers/${sid}/members/${users.victim.id}`, { add_role_ids: [role.id] });
  const v = users.victim;
  assert.equal((await v.post(`/channels/${general}/messages`, { content: 'x' })).status, 403, 'no SEND');
  assert.equal((await v.get(`/channels/${general}/messages`)).status, 403, 'no HISTORY');
  await owner.patch(`/servers/${sid}/roles/${role.id}`, { permissions: P.VIEW | P.SEND });
  assert.equal((await v.post(`/channels/${general}/messages`, { content: 'x' })).status, 201);
  assert.equal((await v.post(`/channels/${general}/messages`, { content: 'x', attachments: [{ name: 'a.png', url: '/uploads/a.png', type: 'image/png' }] })).status, 403, 'no ATTACH');
  await owner.patch(`/servers/${sid}/roles/${role.id}`, { permissions: P.VIEW | P.SEND | P.HISTORY });
  assert.equal((await v.get(`/channels/${general}/messages`)).status, 200);
  await owner.patch(`/servers/${sid}/roles/${memberRole}`, { permissions: memberPerms });
  await owner.patch(`/servers/${sid}/members/${users.victim.id}`, { remove_role_ids: [role.id] });
  await owner.del(`/servers/${sid}/roles/${role.id}`);
});

// ─── Moderation ──────────────────────────────────────────────────
test('moderation: timeouts block sending (REST + WS typing) and expire/lift', async () => {
  const v = users.victim;
  assert.equal((await users.member.post(`/servers/${sid}/members/${v.id}/timeout`, { duration_seconds: 60 })).status, 403);
  assert.equal((await users.mod.post(`/servers/${sid}/members/${v.id}/timeout`, { duration_seconds: 5 })).status, 400);
  assert.equal((await users.mod.post(`/servers/${sid}/members/${users.admin.id}/timeout`, { duration_seconds: 60 })).status, 403);
  assert.equal((await users.mod.post(`/servers/${sid}/members/${owner.id}/timeout`, { duration_seconds: 60 })).status, 403);
  assert.equal((await users.mod.post(`/servers/${sid}/members/${users.mod.id}/timeout`, { duration_seconds: 60 })).status, 400);
  const wsV = await openWs(s.base, v.token);
  wsV.send({ type: 'join_room', room_id: general });
  await wsV.waitFor(m => m.type === 'joined_room');
  const wsO = await openWs(s.base, owner.token);
  wsO.send({ type: 'join_room', room_id: general });
  await wsO.waitFor(m => m.type === 'joined_room');
  assert.equal((await v.post(`/channels/${general}/messages`, { content: 'before' })).status, 201);
  assert.equal((await users.mod.post(`/servers/${sid}/members/${v.id}/timeout`, { duration_seconds: 600, reason: 'spam' })).status, 200);
  assert.equal((await v.post(`/channels/${general}/messages`, { content: 'after' })).status, 403);
  wsV.send({ type: 'typing', room_id: general });
  await sleep(300);
  assert.ok(!wsO.msgs.some(m => m.type === 'typing' && m.user_id === v.id), 'timed-out user cannot signal typing');
  assert.equal((await v.del(`/servers/${sid}/members/${v.id}/timeout`)).status, 403);
  assert.equal((await users.mod.del(`/servers/${sid}/members/${v.id}/timeout`)).status, 200);
  assert.equal((await users.mod.del(`/servers/${sid}/members/${v.id}/timeout`)).status, 404, 'repeat is safe');
  assert.equal((await v.post(`/channels/${general}/messages`, { content: 'back' })).status, 201);
  wsV.send({ type: 'typing', room_id: general });
  await wsO.waitFor(m => m.type === 'typing' && m.user_id === v.id);
  wsV.close(); wsO.close();
});

test('moderation: ban persists, blocks rejoin, is idempotent; unban lets them rejoin; roles do not survive', async () => {
  const v = users.victim;
  await owner.patch(`/servers/${sid}/roles/${roleId('Moderator')}`, { permissions: 29027 | P.BAN });
  assert.equal((await users.member.post(`/servers/${sid}/bans/${v.id}`, {})).status, 403);
  assert.equal((await users.mod.post(`/servers/${sid}/bans/${users.admin.id}`, {})).status, 403);
  assert.equal((await users.mod.post(`/servers/${sid}/bans/${owner.id}`, {})).status, 403);
  assert.equal((await users.mod.post(`/servers/${sid}/bans/${v.id}`, { reason: 'x'.repeat(301) })).status, 400);
  assert.equal((await users.mod.post(`/servers/${sid}/bans/nonexistent`, {})).status, 404);
  // give victim a role first, to prove it is wiped
  const r = (await owner.post(`/servers/${sid}/roles`, { name: 'Stale', permissions: P.VIEW })).body.role;
  await owner.patch(`/servers/${sid}/members/${v.id}`, { add_role_ids: [r.id] });
  const wsV = await openWs(s.base, v.token);
  wsV.send({ type: 'join_room', room_id: general });
  await wsV.waitFor(m => m.type === 'joined_room');
  assert.equal((await users.mod.post(`/servers/${sid}/bans/${v.id}`, { reason: 'spamming' })).status, 200);
  assert.equal((await users.mod.post(`/servers/${sid}/bans/${v.id}`, { reason: 'again' })).body.already_banned, true);
  const bans = (await owner.get(`/servers/${sid}/bans`)).body;
  assert.equal(bans.total, 1);
  assert.equal(bans.bans[0].reason, 'spamming');
  assert.equal(bans.bans[0].banned_by, users.mod.id, 'second ban did not overwrite banner');
  assert.equal((await owner.get(`/servers/${sid}/bans?search=spam`)).body.total, 1);
  assert.equal((await owner.get(`/servers/${sid}/bans?search=zzzz`)).body.total, 0);
  assert.equal((await users.member.get(`/servers/${sid}/bans`)).status, 403);
  assert.equal((await owner.get(`/servers/${sid}/members?search=${v.username}`)).body.total, 0);
  assert.equal((await owner.get(`/servers/${sid}`)).body.server.member_count, 5);
  assert.equal((await v.get(`/channels/${general}/messages`)).status, 403);
  await owner.post(`/channels/${general}/messages`, { content: 'live after ban' });
  await sleep(300);
  assert.ok(!wsV.msgs.some(m => m.type === 'new_message' && m.message.content === 'live after ban'), 'banned socket no longer receives');
  const inv = (await owner.post(`/servers/${sid}/invites`, {})).body.invite.code;
  assert.equal((await v.post(`/invites/${inv}/join`)).status, 403, 'banned cannot rejoin');
  assert.equal((await users.member.del(`/servers/${sid}/bans/${v.id}`)).status, 403);
  assert.equal((await users.mod.del(`/servers/${sid}/bans/${v.id}`)).status, 200);
  assert.equal((await users.mod.del(`/servers/${sid}/bans/${v.id}`)).status, 404);
  assert.equal((await v.post(`/invites/${inv}/join`)).status, 200, 'unbanned can rejoin');
  const me = (await owner.get(`/servers/${sid}/members?search=${v.username}`)).body.members[0];
  assert.deepEqual(me.roles.map(x => x.name), ['Member'], 'stale roles are not restored on rejoin');
  // victim still has their global account
  assert.equal((await v.get('/servers')).status, 200);
  wsV.close();
  await owner.del(`/servers/${sid}/roles/${r.id}`);
});

test('moderation: kicked admin does not get admin back on rejoin', async () => {
  const a = await registerUser(s.base, 'tmpadmin');
  await join(a);
  await owner.patch(`/servers/${sid}/members/${a.id}`, { add_role_ids: [roleId('Admin')] });
  assert.equal((await owner.del(`/servers/${sid}/members/${a.id}`, { reason: 'test' })).status, 200);
  await join(a);
  const me = (await owner.get(`/servers/${sid}/members?search=${a.username}`)).body.members[0];
  assert.deepEqual(me.roles.map(x => x.name), ['Member']);
  assert.equal((await a.patch(`/servers/${sid}`, { name: 'pwn' })).status, 403);
});

// ─── Audit log ───────────────────────────────────────────────────
test('audit log: records successes with the authenticated actor, filters, paginates, restricts access', async () => {
  const all = await audit();
  const actions = new Set();
  for (let page = 1; ; page++) {
    const pg = (await owner.get(`/servers/${sid}/audit-log?page=${page}&page_size=50`)).body;
    pg.entries.forEach(e => actions.add(e.action));
    if (!pg.has_more) break;
  }
  for (const a of ['server.update', 'server.icon_update', 'role.create', 'role.update', 'role.permissions_update', 'role.delete', 'role.reorder',
    'member.roles_update', 'member.kick', 'member.ban', 'member.unban', 'member.timeout', 'member.timeout_remove',
    'channel.create', 'channel.update', 'channel.delete', 'channel.permissions_update', 'channel.permissions_remove',
    'category.create', 'category.update', 'category.delete', 'channel.move', 'invite.create']) {
    assert.ok(actions.has(a), 'missing audit action ' + a);
  }
  const ban = all.entries.find(e => e.action === 'member.ban');
  assert.equal(ban.actor.id, users.mod.id);
  assert.equal(ban.target_id, users.victim.id);
  assert.equal(ban.reason, 'spamming');
  assert.ok(ban.description.includes('banned'));
  assert.ok(ban.created_at > 0);
  // newest first
  for (let i = 1; i < all.entries.length; i++) assert.ok(all.entries[i - 1].created_at >= all.entries[i].created_at);
  // failed operations leave no record
  const n = (await audit()).total;
  await users.member.patch(`/servers/${sid}`, { name: 'nope' });
  await users.mod.post(`/servers/${sid}/bans/${users.admin.id}`, {});
  await owner.patch(`/servers/${sid}`, { name: '' });
  assert.equal((await audit()).total, n);
  // filters
  assert.ok((await audit('&action=member')).entries.every(e => e.action.startsWith('member.')));
  assert.ok((await audit(`&actor_id=${users.mod.id}`)).entries.every(e => e.actor.id === users.mod.id));
  assert.ok((await audit(`&target_id=${users.victim.id}`)).entries.length >= 2);
  assert.ok((await audit('&q=spamming')).total >= 1);
  assert.equal((await audit(`&from=${Date.now() + 100000}`)).total, 0);
  const p1 = (await owner.get(`/servers/${sid}/audit-log?page=1&page_size=3`)).body;
  assert.equal(p1.entries.length, 3);
  assert.equal(p1.has_more, true);
  const p2 = (await owner.get(`/servers/${sid}/audit-log?page=2&page_size=3`)).body;
  assert.ok(!p2.entries.some(e => p1.entries.find(x => x.id === e.id)));
  // access: only VIEW_AUDIT_LOG holders (owner, admin) — not members or moderators
  assert.equal((await users.member.get(`/servers/${sid}/audit-log`)).status, 403);
  assert.equal((await users.mod.get(`/servers/${sid}/audit-log`)).status, 403);
  assert.equal((await users.admin.get(`/servers/${sid}/audit-log`)).status, 200);
  assert.equal((await users.outsider.get(`/servers/${sid}/audit-log`)).status, 404);
  // no client-supplied actor, nothing sensitive stored
  const raw = JSON.stringify(all.entries);
  assert.ok(!/password|token|secret|ciphertext/i.test(raw));
  // no route can edit or delete audit rows
  for (const m of ['put', 'patch', 'del']) assert.ok([404, 405].includes((await owner[m](`/servers/${sid}/audit-log/${ban.id}`, {})).status));
});

// ─── Server deletion ─────────────────────────────────────────────
test('delete server: owner only, name confirmation enforced, cleans related rows', async () => {
  const r = (await users.member.post('/servers', { name: 'Doomed' })).body.server;
  assert.equal((await users.outsider.del(`/servers/${r.id}`, { confirm_name: 'Doomed' })).status, 404);
  assert.equal((await users.member.del(`/servers/${r.id}`)).status, 400);
  assert.equal((await users.member.del(`/servers/${r.id}`, { confirm_name: 'wrong' })).status, 400);
  assert.equal((await users.member.del(`/servers/${r.id}`, { confirm_name: 'Doomed' })).status, 200);
  assert.equal((await users.member.get(`/servers/${r.id}`)).status, 404);
  // non-owner admin cannot delete someone else's server
  assert.equal((await users.admin.del(`/servers/${sid}`, { confirm_name: 'Renamed' })).status, 403);
});
