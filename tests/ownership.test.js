// Ownership transfer: authorization, validation, consequences, audit, live event.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, registerUser, openWs, sleep } = require('./helpers');

let s, owner, admin, mod, plain, outsider, sid, roles, general;
const NAME = 'Transfer Test';
const T = (u, body) => u.post(`/servers/${sid}/transfer-ownership`, body);
const ownerId = async () => (await owner.get(`/servers/${sid}`)).body.server.owner_id;

test.before(async () => {
  s = await startServer();
  [owner, admin, mod, plain, outsider] = await Promise.all(['xowner', 'xadmin', 'xmod', 'xplain', 'xout'].map(n => registerUser(s.base, n)));
  const r = await owner.post('/servers', { name: NAME });
  sid = r.body.server.id; general = r.body.default_channel_id;
  roles = (await owner.get(`/servers/${sid}/roles`)).body.roles;
  for (const u of [admin, mod, plain]) { const inv = (await owner.post(`/servers/${sid}/invites`, {})).body.invite.code; await u.post(`/invites/${inv}/join`); }
  await owner.patch(`/servers/${sid}/members/${admin.id}`, { add_role_ids: [roles.find(r => r.name === 'Admin').id] });
  await owner.patch(`/servers/${sid}/members/${mod.id}`, { add_role_ids: [roles.find(r => r.name === 'Moderator').id] });
});
test.after(async () => { if (s) await s.stop(); });

test('only the owner can transfer; everyone else is refused and nothing changes', async () => {
  for (const u of [admin, mod, plain]) assert.equal((await T(u, { user_id: u.id === admin.id ? plain.id : admin.id, confirm_name: NAME })).status, 403);
  assert.equal((await T(outsider, { user_id: plain.id, confirm_name: NAME })).status, 404, 'non-members cannot even see the server');
  // an Administrator trying to take ownership for themselves is refused
  assert.equal((await T(admin, { user_id: admin.id, confirm_name: NAME })).status, 403);
  assert.equal(await ownerId(), owner.id);
  assert.equal((await owner.get(`/servers/${sid}/audit-log?action=server.ownership_transfer`)).body.total, 0, 'refused attempts are not logged as transfers');
});

test('validation: target, confirmation and self-transfer', async () => {
  assert.equal((await T(owner, { confirm_name: NAME })).status, 400, 'user_id required');
  assert.equal((await T(owner, { user_id: 123, confirm_name: NAME })).status, 400, 'user_id must be text');
  assert.equal((await T(owner, { user_id: owner.id, confirm_name: NAME })).status, 400, 'cannot transfer to yourself');
  assert.equal((await T(owner, { user_id: plain.id })).status, 400, 'confirmation required');
  assert.equal((await T(owner, { user_id: plain.id, confirm_name: 'nope' })).status, 400, 'wrong confirmation');
  assert.equal((await T(owner, { user_id: plain.id, confirm_name: NAME.toLowerCase() })).status, 400, 'confirmation is exact');
  assert.equal((await T(owner, { user_id: outsider.id, confirm_name: NAME })).status, 404, 'target must be a member');
  assert.equal((await T(owner, { user_id: 'no-such-user', confirm_name: NAME })).status, 404);
  // a banned user is not a member, so cannot receive the server
  await owner.post(`/servers/${sid}/bans/${plain.id}`, {});
  assert.equal((await T(owner, { user_id: plain.id, confirm_name: NAME })).status, 404);
  await owner.del(`/servers/${sid}/bans/${plain.id}`);
  const inv = (await owner.post(`/servers/${sid}/invites`, {})).body.invite.code;
  await plain.post(`/invites/${inv}/join`);
  assert.equal(await ownerId(), owner.id, 'every failure left ownership alone');
});

test('transfer: ownership moves, former owner loses owner powers, new owner gains them, audit + live event', async () => {
  // time the new owner out first: ownership must lift it
  await owner.post(`/servers/${sid}/members/${mod.id}/timeout`, { duration_seconds: 600 });
  const wsAdmin = await openWs(s.base, admin.token);
  const wsMod = await openWs(s.base, mod.id && mod.token);
  const r = await T(owner, { user_id: mod.id, confirm_name: NAME });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.owner_id, mod.id);
  assert.equal(await ownerId(), mod.id);

  // live event reaches every member
  const ev = await wsAdmin.waitFor(m => m.type === 'server_ownership_changed');
  assert.equal(ev.owner_id, mod.id); assert.equal(ev.previous_owner_id, owner.id); assert.equal(ev.server_id, sid);
  await wsMod.waitFor(m => m.type === 'server_ownership_changed');

  // flags and powers
  const meOld = (await owner.get(`/servers/${sid}`)).body.server;
  const meNew = (await mod.get(`/servers/${sid}`)).body.server;
  assert.equal(meOld.is_owner, false); assert.equal(meNew.is_owner, true);
  // owner-only powers are gone for the former owner...
  assert.equal((await owner.del(`/servers/${sid}`, { confirm_name: NAME })).status, 403, 'cannot delete the server any more');
  assert.equal((await T(owner, { user_id: plain.id, confirm_name: NAME })).status, 403, 'cannot transfer it again');
  // ...but they keep the roles they hold. Servers give their creator the Admin role, so the former owner is
  // still an Administrator until the new owner takes that role away.
  const oldOwnerRoles = (await mod.get(`/servers/${sid}/members?search=${owner.username}`)).body.members[0].roles.map(r => r.name);
  assert.ok(oldOwnerRoles.includes('Admin'), 'roles are not silently removed');
  assert.equal((await owner.patch(`/servers/${sid}`, { description: 'admin edit' })).status, 200);
  // the new owner can remove that role (owner outranks everyone); then the former owner is an ordinary member
  const adminRoleId = roles.find(r => r.name === 'Admin').id;
  assert.equal((await mod.patch(`/servers/${sid}/members/${owner.id}`, { remove_role_ids: [adminRoleId] })).status, 200);
  assert.equal((await owner.patch(`/servers/${sid}`, { name: 'Hijack' })).status, 403, 'ordinary member cannot edit the server');
  assert.equal((await owner.get(`/servers/${sid}/audit-log`)).status, 403, 'nor read the audit log');
  assert.equal((await owner.get(`/servers/${sid}`)).body.server.name, NAME, 'name untouched');
  assert.equal((await mod.patch(`/servers/${sid}`, { description: 'mine now' })).status, 200, 'new owner can edit it');
  const members = (await mod.get(`/servers/${sid}/members`)).body.members;
  assert.equal(members.find(m => m.id === mod.id).is_owner, true);
  assert.equal(members.find(m => m.id === owner.id).is_owner, false);

  // the new owner is protected and un-timed-out; the old owner is an ordinary member now
  assert.equal((await owner.post(`/servers/${sid}/members/${mod.id}/timeout`, { duration_seconds: 60 })).status, 403);
  assert.equal((await owner.del(`/servers/${sid}/members/${mod.id}`)).status, 403, 'former owner cannot kick the new owner');
  assert.equal((await owner.post(`/servers/${sid}/bans/${mod.id}`, {})).status, 403);
  assert.equal((await owner.post(`/channels/${general}/messages`, { content: 'still talking' })).status, 201, 'former owner can still chat');
  assert.equal((await mod.post(`/channels/${general}/messages`, { content: 'timeout was lifted' })).status, 201);
  // the new owner can now act on the former owner
  assert.equal((await mod.post(`/servers/${sid}/members/${owner.id}/timeout`, { duration_seconds: 60 })).status, 200);
  await mod.del(`/servers/${sid}/members/${owner.id}/timeout`);

  // audit entry: authenticated actor, correct target, readable description
  const log = (await mod.get(`/servers/${sid}/audit-log?action=server.ownership_transfer`)).body;
  assert.equal(log.total, 1);
  assert.equal(log.entries[0].actor.id, owner.id);
  assert.equal(log.entries[0].target_id, mod.id);
  assert.match(log.entries[0].description, /transferred ownership/);

  // repeating the transfer as the former owner is refused, no second record
  assert.equal((await T(owner, { user_id: owner.id, confirm_name: NAME })).status, 403);
  assert.equal((await T(owner, { user_id: plain.id, confirm_name: NAME })).status, 403);
  assert.equal((await mod.get(`/servers/${sid}/audit-log?action=server.ownership_transfer`)).body.total, 1);
  wsAdmin.close(); wsMod.close();
});

test('the former owner can now leave; the new owner can hand it on again and cannot leave without doing so', async () => {
  assert.equal((await mod.post(`/servers/${sid}/leave`)).status, 400, 'an owner still cannot just leave');
  assert.equal((await owner.post(`/servers/${sid}/leave`)).status, 200, 'the former owner is now an ordinary member');
  assert.equal((await mod.get(`/servers/${sid}/members`)).body.members.some(m => m.id === owner.id), false);
  // hand it on again (to the Administrator)
  assert.equal((await mod.post(`/servers/${sid}/transfer-ownership`, { user_id: admin.id, confirm_name: NAME })).status, 200);
  assert.equal((await mod.get(`/servers/${sid}`)).body.server.owner_id, admin.id);
  assert.equal((await admin.get(`/servers/${sid}/audit-log?action=server.ownership_transfer`)).body.total, 2);
});

test('members list flags can_transfer only for the owner and never for themselves', async () => {
  const fromAdmin = (await admin.get(`/servers/${sid}/members?page=1&page_size=50`)).body.members;
  assert.ok(fromAdmin.filter(m => m.id !== admin.id).every(m => m.actions.can_transfer === true));
  assert.equal(fromAdmin.find(m => m.id === admin.id).actions.can_transfer, false);
  const fromMod = (await mod.get(`/servers/${sid}/members?page=1&page_size=50`)).body.members;
  assert.ok(fromMod.every(m => m.actions.can_transfer === false));
});
