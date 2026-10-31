// 0.10.0: Developer role (derived from the developer badge), Developer
// workspace API (Feedback & Issues), report submission, attachments, security
// reports and migrations. Each test runs against the real server on a
// throwaway data dir (see helpers.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const initSqlJs = require('sql.js');
const { startServer, registerUser, client, ROOT } = require('./helpers');

const PW = 'correct-horse-battery';
const base = () => S.base;
let S;                       // { base, dir, stop }
const U = {};                // named clients

async function login(base, username) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
  const b = await res.json();
  assert.ok(b.token, 'login failed for ' + username);
  const c = client(base, b.token); c.id = b.user.id; c.username = username; return c;
}
async function editDb(dir, fn) {
  const SQL = await initSqlJs();
  const file = path.join(dir, 'nyxie_users.db');
  const db = new SQL.Database(fs.readFileSync(file));
  const q = (sql, p = []) => { const st = db.prepare(sql); st.bind(p); const r = []; while (st.step()) r.push(st.getAsObject()); st.free(); return r; };
  const out = await fn(db, q);
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return out;
}
// Stop, run fn on the database file, start again with the same data dir and log everyone in again.
async function reboot(fn) {
  const dir = S.dir;
  await S.stop();
  if (fn) await editDb(dir, fn);
  S = await startServer({ dataDir: dir });
  for (const k of Object.keys(U)) U[k] = await login(S.base, U[k].username);
}
const submit = (c, over = {}) => c.post('/reports', { title: 'Something is wrong', description: 'It does not work the way I expect it to.', category: 'BUG', ...over });
async function upload(c, number, files) {
  const fd = new FormData();
  for (const f of files) fd.append('files', new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.name);
  const res = await fetch(`${S.base}/api/reports/mine/${number}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + c.token }, body: fd });
  let body = null; try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}
const download = (c, id) => fetch(`${S.base}/api/reports/attachments/${id}/download`, { headers: c ? { Authorization: 'Bearer ' + c.token } : {} });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(32, 7)]);

test.before(async () => {
  S = await startServer();
  for (const n of ['admin', 'dev', 'dev2', 'sec', 'user', 'rep', 'rep2']) U[n] = await registerUser(S.base, n);
  // The only way to become an ADMIN is the DB role column (scripts/setRole.js).
  await reboot((db) => db.run("UPDATE users SET role = 'ADMIN' WHERE id = ?", [U.admin.id]));
  // Developers are made the real way: an admin grants the official badge.
  for (const n of ['dev', 'dev2', 'sec']) {
    const r = await U.admin.post(`/admin/badges/users/${U[n].id}/badges`, { badge_id: 'developer' });
    assert.equal(r.status, 201, 'grant developer badge: ' + JSON.stringify(r.body));
  }
});
test.after(async () => { if (S) await S.stop(); });

const me = async c => (await c.get('/auth/me')).body.user;

// ─── Role ⇄ badge ────────────────────────────────────────────────────
test('granting the developer badge gives the DEVELOPER role; ordinary users stay USER', async () => {
  assert.equal((await me(U.dev)).role, 'DEVELOPER');
  assert.equal((await me(U.user)).role, 'USER');
  assert.equal((await me(U.admin)).role, 'ADMIN');
});

test('a normal user (and anonymous callers) cannot reach any Developer API', async () => {
  const anon = client(S.base);
  const calls = [
    ['get', '/developer/overview'], ['get', '/developer/reports'], ['get', '/developer/reports/1'], ['get', '/developer/staff'],
    ['patch', '/developer/reports/1', { status: 'CLOSED' }], ['post', '/developer/reports/1/notes', { body: 'x' }],
    ['post', '/developer/reports/1/duplicates', { of: 2 }], ['put', '/developer/reports/1/link', { url: 'https://github.com/a/b/issues/1' }],
    ['get', '/admin/staff/permissions'],
  ];
  for (const [m, p, b] of calls) {
    assert.equal((await U.user[m](p, b)).status, 403, `${m} ${p} as user`);
    assert.equal((await anon[m](p, b)).status, 401, `${m} ${p} anonymous`);
  }
  assert.equal((await download(U.user, 'nope')).status, 404);
  assert.equal((await download(null, 'nope')).status, 401);
});

test('client-supplied role / badge / developer claims grant nothing', async () => {
  const forged = { role: 'DEVELOPER', isDeveloper: true, is_developer: true, badges: ['developer'], badge_id: 'developer', permissions: ['SECURITY_REPORTS'] };
  await U.user.patch('/users/me', forged);                       // profile edit with forged fields
  assert.equal((await me(U.user)).role, 'USER');
  const res = await fetch(S.base + '/api/developer/overview?role=ADMIN&isDeveloper=true', {
    headers: { Authorization: 'Bearer ' + U.user.token, 'X-Role': 'ADMIN', 'X-Is-Developer': 'true' },
  });
  assert.equal(res.status, 403);
  // Granting the badge is admin-only.
  assert.equal((await U.user.post(`/admin/badges/users/${U.user.id}/badges`, { badge_id: 'developer' })).status, 403);
  assert.equal((await U.dev.post(`/admin/badges/users/${U.user.id}/badges`, { badge_id: 'developer' })).status, 403);
  assert.equal((await U.user.get('/developer/overview')).status, 403);
});

test('a developer gets the workspace but no administrator powers', async () => {
  assert.equal((await U.dev.get('/developer/overview')).status, 200);
  for (const p of ['/admin/badges/users', '/admin/badges/log', '/admin/staff/permissions']) {
    assert.equal((await U.dev.get(p)).status, 403, p);
  }
  assert.equal((await U.dev.put('/admin/staff/permissions', { user_id: U.dev.id, permission: 'SECURITY_REPORTS' })).status, 403);
  assert.equal((await U.dev.post('/admin/staff/developers/sync')).status, 403);
  assert.equal((await U.dev.get('/admin/marketplace/disputes')).status, 403);
});

test('an administrator reaches the workspace without the badge and is never downgraded by badge changes', async () => {
  assert.equal((await U.admin.get('/developer/overview')).status, 200);
  const hasBadge = (await U.admin.get(`/admin/badges/users/${U.admin.id}`)).body.user.badges.some(b => (b.id || b) === 'developer');
  assert.equal(hasBadge, false);
  assert.equal((await U.admin.post(`/admin/badges/users/${U.admin.id}/badges`, { badge_id: 'developer' })).status, 201);
  assert.equal((await me(U.admin)).role, 'ADMIN');
  assert.equal((await U.admin.del(`/admin/badges/users/${U.admin.id}/badges/developer`)).status, 200);
  assert.equal((await me(U.admin)).role, 'ADMIN');
  assert.equal((await U.admin.get('/developer/overview')).status, 200);
});

test('badge grant is idempotent and revoking it removes Developer access immediately (and its staff grants)', async () => {
  const t = await registerUser(S.base, 'temp');
  U.temp = t;
  assert.equal((await U.admin.post(`/admin/badges/users/${t.id}/badges`, { badge_id: 'developer' })).status, 201);
  assert.equal((await U.admin.post(`/admin/badges/users/${t.id}/badges`, { badge_id: 'developer' })).status < 500, true);
  assert.equal((await me(t)).role, 'DEVELOPER');
  assert.equal((await t.get('/developer/overview')).status, 200);
  assert.equal((await U.admin.put('/admin/staff/permissions', { user_id: t.id, permission: 'SECURITY_REPORTS' })).status, 200);
  assert.equal((await U.admin.del(`/admin/badges/users/${t.id}/badges/developer`)).status, 200);
  assert.equal((await me(t)).role, 'USER');
  assert.equal((await t.get('/developer/overview')).status, 403);          // same token, no re-login needed
  const grants = (await U.admin.get('/admin/staff/permissions')).body.permissions;
  assert.equal(grants.some(g => g.user_id === t.id), false, 'developer-only grants are removed with the role');
  assert.equal((await U.admin.put('/admin/staff/permissions', { user_id: t.id, permission: 'SECURITY_REPORTS' })).status, 409);
});

// ─── Submission ──────────────────────────────────────────────────────
test('submitting a report persists it, appears in the queue and ignores forged privileged fields', async () => {
  const before = (await U.dev.get('/developer/overview')).body.overview.total;
  const r = await submit(U.rep, {
    title: 'Crash when opening settings', category: 'BUG', app_version: '0.10.0', platform: 'Linux / Firefox',
    status: 'RESOLVED', priority: 'URGENT', assignee_id: U.dev.id, reporter_id: U.rep2.id, reporter_ref: 'forged',
    internal_notes: 'forged', notes: ['forged'], role: 'ADMIN', linked_url: 'https://evil.example', version: 99,
    diagnostics: 'should not be stored', // no consent flag
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const { number, display_id } = r.body.report;
  assert.match(display_id, /^NYX-\d+$/);

  const d = (await U.dev.get(`/developer/reports/${number}`)).body.report;
  assert.equal(d.status, 'OPEN'); assert.equal(d.priority, 'NORMAL'); assert.equal(d.assignee, null);
  assert.equal(d.linked, null); assert.equal(d.version, 1);
  assert.equal(d.app_version, '0.10.0'); assert.equal(d.platform, 'Linux / Firefox');
  assert.equal(d.diagnostics, null, 'diagnostics are only stored with explicit consent');
  assert.equal(d.events.filter(e => e.type === 'CREATED').length, 1);
  assert.equal(d.events.some(e => e.type === 'NOTE'), false);
  // owned by the real submitter, not by whoever the body named
  assert.equal((await U.rep.get('/reports/mine')).body.reports.some(x => x.number === number), true);
  assert.equal((await U.rep2.get('/reports/mine')).body.reports.some(x => x.number === number), false);
  assert.equal((await U.dev.get('/developer/overview')).body.overview.total, before + 1);

  const withDiag = await submit(U.rep, { title: 'Diagnostics opted in', diagnostics_consent: true, diagnostics: 'app 0.10.0 · Linux · Firefox 130' });
  assert.equal((await U.dev.get(`/developer/reports/${withDiag.body.report.number}`)).body.report.diagnostics, 'app 0.10.0 · Linux · Firefox 130');
});

test('submission is validated server-side and rate limited', async () => {
  for (const bad of [{ title: 'abc' }, { title: 'x'.repeat(121) }, { description: 'short' }, { description: 'y'.repeat(5001) }, { category: 'NOPE' }, { category: undefined }, { app_version: 'v'.repeat(40) }]) {
    const r = await submit(U.rep, bad);
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await submit(client(S.base))).status, 401);
  const spammer = await registerUser(S.base, 'spam');
  let last;
  for (let i = 0; i < 11; i++) last = await submit(spammer, { title: 'Spam report ' + i });
  assert.equal(last.status, 429);
});

test('report text is stored as plain text and never as markup the API would render', async () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const r = await submit(U.rep, { title: 'XSS ' + evil.slice(0, 40), description: evil + ' and more text here' });
  assert.equal(r.status, 201);
  const d = (await U.dev.get(`/developer/reports/${r.body.report.number}`)).body.report;
  assert.ok(d.description.startsWith('<img src=x'), 'stored verbatim as text (the UI escapes on render)');
  const note = await U.dev.post(`/developer/reports/${d.number}/notes`, { body: '\u0000bad\u202Econtrol chars\u0007' });
  assert.equal(note.status, 200);
  const notes = (await U.dev.get(`/developer/reports/${d.number}`)).body.report.events.filter(e => e.type === 'NOTE');
  assert.equal(notes[0].body, 'badcontrol chars', 'control and bidi-override characters are stripped');
});

// ─── Workflow ────────────────────────────────────────────────────────
test('status, priority, assignment, notes and history persist; transitions are validated', async () => {
  const n = (await submit(U.rep, { title: 'Workflow report one' })).body.report.number;
  const patch = (b, c = U.dev) => c.patch(`/developer/reports/${n}`, b);

  assert.equal((await patch({ status: 'RESOLVED' })).status, 409, 'OPEN cannot jump to RESOLVED');
  assert.equal((await patch({ status: 'NOPE' })).status, 400);
  assert.equal((await patch({ priority: 'MEGA' })).status, 400);
  assert.equal((await patch({ status: 'IN_PROGRESS', priority: 'HIGH', assignee_id: U.dev2.id })).status, 200);
  assert.equal((await patch({ status: 'RESOLVED' })).status, 200);

  const d = (await U.dev2.get(`/developer/reports/${n}`)).body.report;
  assert.equal(d.status, 'RESOLVED'); assert.equal(d.priority, 'HIGH'); assert.equal(d.assignee.id, U.dev2.id);
  assert.ok(d.resolved_at);
  const hist = d.events.filter(e => ['STATUS', 'PRIORITY', 'ASSIGNEE'].includes(e.type));
  assert.deepEqual(hist.map(e => `${e.type}:${e.from}>${e.to}`).slice(0, 3),
    ['STATUS:OPEN>IN_PROGRESS', 'PRIORITY:NORMAL>HIGH', `ASSIGNEE:null>${U.dev2.id}`]);
  assert.ok(hist.every(e => e.actor && e.actor.id === U.dev.id && e.created_at > 0), 'actor + timestamp recorded');

  // unassign, reopen
  assert.equal((await patch({ assignee_id: null })).status, 200);
  assert.equal((await patch({ status: 'OPEN' })).status, 200);
  assert.equal((await U.dev.get(`/developer/reports/${n}`)).body.report.resolved_at, null);
  // declined/closed reports are kept, never deleted
  assert.equal((await patch({ status: 'DECLINED' })).status, 200);
  assert.equal((await U.dev.get(`/developer/reports/${n}`)).body.report.status, 'DECLINED');

  // assignee validation
  assert.equal((await patch({ assignee_id: U.user.id })).status, 400, 'ordinary user is not eligible');
  assert.equal((await patch({ assignee_id: 'does-not-exist' })).status, 400);
  assert.equal((await patch({ assignee_id: U.admin.id })).status, 200, 'an administrator is eligible');

  // stale edits are rejected
  const v = (await U.dev.get(`/developer/reports/${n}`)).body.report.version;
  assert.equal((await patch({ priority: 'LOW', expected_version: v - 1 })).status, 409);
  assert.equal((await patch({ priority: 'LOW', expected_version: v })).status, 200);

  // notes
  assert.equal((await U.dev.post(`/developer/reports/${n}/notes`, { body: '   ' })).status, 400);
  assert.equal((await U.dev.post(`/developer/reports/${n}/notes`, { body: 'x'.repeat(4001) })).status, 400);
  assert.equal((await U.dev2.post(`/developer/reports/${n}/notes`, { body: 'Looks like a regression' })).status, 200);
  const notes = (await U.dev.get(`/developer/reports/${n}`)).body.report.events.filter(e => e.type === 'NOTE');
  assert.equal(notes.length, 1); assert.equal(notes[0].actor.id, U.dev2.id);
  // survives a restart
  await reboot();
  const again = (await U.dev.get(`/developer/reports/${n}`)).body.report;
  assert.equal(again.status, 'DECLINED'); assert.equal(again.priority, 'LOW');
  assert.equal(again.events.filter(e => e.type === 'NOTE').length, 1);
});

test('duplicates, related reports and development links', async () => {
  const a = (await submit(U.rep, { title: 'Original problem report' })).body.report.number;
  const b = (await submit(U.rep, { title: 'Same problem again here' })).body.report.number;
  const c = (await submit(U.rep, { title: 'Third similar problem x' })).body.report.number;
  assert.equal((await U.dev.post(`/developer/reports/${b}/duplicates`, { of: b })).status, 400);
  assert.equal((await U.dev.post(`/developer/reports/${b}/duplicates`, { of: 999999 })).status, 404);
  assert.equal((await U.dev.post(`/developer/reports/${b}/duplicates`, { of: a })).status, 200);
  const bd = (await U.dev.get(`/developer/reports/${b}`)).body.report;
  assert.equal(bd.status, 'CLOSED', 'a duplicate is closed, not deleted');
  assert.equal(bd.relations[0].number, a); assert.equal(bd.relations[0].kind, 'DUPLICATE');
  assert.equal((await U.dev.get(`/developer/reports/${a}`)).body.report.relations[0].number, b, 'visible from the original too');
  assert.equal((await U.dev.post(`/developer/reports/${b}/duplicates`, { of: a })).status, 409);
  assert.equal((await U.dev.post(`/developer/reports/${c}/duplicates`, { of: b })).status, 409, 'must point at the original');
  assert.equal((await U.dev.post(`/developer/reports/${c}/related`, { with: a })).status, 200);
  assert.equal((await U.dev.del(`/developer/reports/${c}/relations/${a}`)).status, 200);
  assert.equal((await U.dev.get(`/developer/reports/${c}`)).body.report.relations.length, 0);

  for (const bad of ['javascript:alert(1)', 'http://github.com/a/b/issues/1', 'https://user:pw@github.com/a/b/issues/1', 'not a url', 'https://' + 'a'.repeat(300) + '.com']) {
    assert.equal((await U.dev.put(`/developer/reports/${a}/link`, { url: bad })).status, 400, bad.slice(0, 40));
  }
  const ok = await U.dev.put(`/developer/reports/${a}/link`, { url: 'https://github.com/nyxie/nyxie/pull/12' });
  assert.equal(ok.status, 200); assert.equal(ok.body.linked.kind, 'PULL_REQUEST');
  assert.deepEqual((await U.dev.get(`/developer/reports/${a}`)).body.report.linked, { url: 'https://github.com/nyxie/nyxie/pull/12', kind: 'PULL_REQUEST' });
  assert.equal((await U.dev.put(`/developer/reports/${a}/link`, { url: null })).status, 200);
  assert.equal((await U.dev.get(`/developer/reports/${a}`)).body.report.linked, null);
});

// ─── Queues: filter / search / sort / pagination ─────────────────────
test('queues filter, search, sort and paginate together on real data', async () => {
  const q = await registerUser(S.base, 'queue'); U.queue = q;
  assert.equal((await U.admin.post(`/admin/badges/users/${q.id}/badges`, { badge_id: 'developer' })).status, 201);
  const marker = 'Zq' + Math.random().toString(36).slice(2, 7);
  const made = [];
  const plan = [
    ['BUG', 'LOW'], ['BUG', 'URGENT'], ['BUG', 'NORMAL'], ['FEATURE', 'HIGH'], ['FEATURE', 'LOW'], ['GENERAL', 'NORMAL'], ['GENERAL', 'URGENT'],
  ];
  for (const [i, [category, priority]] of plan.entries()) {
    const rep = (await submit(U.rep2, { title: `${marker} item ${i} % _ ${category}`, category })).body.report;
    await q.patch(`/developer/reports/${rep.number}`, { priority, ...(i === 1 ? { status: 'IN_PROGRESS', assignee_id: q.id } : {}) });
    made.push({ ...rep, priority, i });
    await new Promise(r => setTimeout(r, 4));
  }
  const list = (qs) => q.get('/developer/reports?' + qs).then(r => { assert.equal(r.status, 200, qs); return r.body; });

  const all = await list(`q=${marker}&page_size=50`);
  assert.equal(all.total, 7);
  assert.deepEqual(all.counts, { all: 7, bug: 3, feature: 2, general: 2 }, 'no security figure without permission');
  // search by id and by title; LIKE wildcards are literal
  assert.equal((await list(`q=NYX-${made[3].number}`)).reports[0].number, made[3].number);
  assert.equal((await list(`q=${made[3].number}`)).reports.some(r => r.number === made[3].number), true);
  assert.equal((await list(`q=${marker}%20item%203`)).total, 1);
  assert.equal((await list(`q=%25`)).reports.every(r => /%/.test(r.title)), true);
  assert.equal((await list(`q=%25%20_%20BUG`)).total, 3, 'percent and underscore are matched literally');
  assert.equal((await list(`q=${marker}%20item%20_`)).total, 0, 'underscore is not a wildcard (it would match "item 0")');

  // queues + filters combine; counts honour filters but not the queue
  const bugs = await list(`q=${marker}&queue=bug`);
  assert.equal(bugs.total, 3);
  const bugsUrgent = await list(`q=${marker}&queue=bug&priority=URGENT`);
  assert.equal(bugsUrgent.total, 1); assert.equal(bugsUrgent.counts.all, 2); assert.equal(bugsUrgent.counts.bug, 1);
  assert.equal((await list(`q=${marker}&status=IN_PROGRESS`)).total, 1);
  assert.equal((await list(`q=${marker}&assignee=me`)).total, 1);
  assert.equal((await list(`q=${marker}&assignee=none`)).total, 6);
  assert.equal((await list(`q=${marker}&queue=feature&category=BUG`)).total, 0);

  // sorting
  const newest = (await list(`q=${marker}&sort=newest&page_size=50`)).reports.map(r => r.number);
  const oldest = (await list(`q=${marker}&sort=oldest&page_size=50`)).reports.map(r => r.number);
  assert.deepEqual(newest, [...oldest].reverse());
  const prio = (await list(`q=${marker}&sort=priority&page_size=50`)).reports.map(r => r.priority);
  const rank = { URGENT: 4, HIGH: 3, NORMAL: 2, LOW: 1 };
  assert.deepEqual(prio, [...prio].sort((x, y) => rank[y] - rank[x]));
  await q.patch(`/developer/reports/${made[0].number}`, { priority: 'LOW' });   // no-op change keeps updated_at stable
  await q.post(`/developer/reports/${made[0].number}/notes`, { body: 'bump' });
  assert.equal((await list(`q=${marker}&sort=updated`)).reports[0].number, made[0].number);

  // pagination with a filter: pages are disjoint and complete
  const seen = [];
  for (let p = 1; p <= 3; p++) {
    const page = await list(`q=${marker}&page_size=3&page=${p}&sort=oldest`);
    assert.equal(page.total, 7); assert.equal(page.total_pages, 3);
    seen.push(...page.reports.map(r => r.number));
  }
  assert.equal(new Set(seen).size, 7);
  assert.deepEqual(seen, oldest);
  assert.equal((await list(`q=${marker}&page_size=3&page=9`)).reports.length, 0);

  // row fields
  const row = (await list(`q=${marker}%20item%201&page_size=5`)).reports[0];
  for (const k of ['id', 'display_id', 'title', 'category', 'status', 'priority', 'assignee', 'created_at', 'updated_at', 'note_count', 'reporter_ref']) assert.ok(k in row, k);
  assert.equal(row.assignee.id, q.id);
  assert.equal('reporter_id' in row, false); assert.equal('username' in row, false);

  for (const bad of ['status=NOPE', 'priority=NOPE', 'sort=NOPE', 'queue=NOPE']) assert.equal((await q.get('/developer/reports?' + bad)).status, 400, bad);
});

test('overview metrics come from real records', async () => {
  const o = (await U.dev.get('/developer/overview')).body.overview;
  const list = (await U.dev.get('/developer/reports?page_size=1')).body;
  assert.equal(o.total, list.total);
  assert.equal(o.total, Object.values(o.by_category).reduce((a, b) => a + b, 0));
  assert.equal('SECURITY' in o.by_category, false, 'no security figures for developers without access');
  const open = (await U.dev.get('/developer/reports?page_size=1&status=OPEN')).body.total;
  assert.equal(o.awaiting_review, open);
  assert.ok(o.open >= o.awaiting_review + o.in_progress);
  assert.equal(o.recent.length, 5);
  assert.equal((await U.dev.get('/developer/overview?days=7')).body.overview.days, 7);
  assert.equal((await U.dev.get('/developer/overview?days=99999')).body.overview.days, 365);
});

// ─── Notes never leak; reporter view is limited ──────────────────────
test('internal notes, history, priority and assignee are never returned to reporters or other users', async () => {
  const secret = 'INTERNAL-ONLY-' + Math.random().toString(36).slice(2);
  const n = (await submit(U.rep, { title: 'Leak check report one' })).body.report.number;
  await U.dev.patch(`/developer/reports/${n}`, { priority: 'URGENT', assignee_id: U.dev2.id });
  await U.dev.post(`/developer/reports/${n}/notes`, { body: secret });
  for (const c of [U.rep, U.rep2, U.user]) {
    for (const p of ['/reports/mine', '/account/feedback']) {
      const res = await c.get(p);
      assert.equal(res.status, 200);
      assert.equal(JSON.stringify(res.body).includes(secret), false, p);
    }
  }
  const mine = (await U.rep.get('/reports/mine')).body.reports.find(r => r.number === n);
  assert.deepEqual(Object.keys(mine).sort(), ['attachment_count', 'category', 'created_at', 'display_id', 'number', 'status', 'title', 'updated_at']);
  assert.equal((await U.rep.get(`/developer/reports/${n}`)).status, 403);
  assert.equal((await U.rep.get('/reports/1')).status, 404);
  // the legacy endpoint maps onto the same store and cannot be used to forge fields either
  const legacy = await U.rep.post('/account/feedback', { category: 'idea', message: 'Please add a dark-dark theme', status: 'resolved', priority: 'URGENT' });
  assert.equal(legacy.status, 201);
  const row = (await U.dev.get('/developer/reports?q=dark-dark')).body.reports[0];
  assert.equal(row.category, 'FEATURE'); assert.equal(row.status, 'OPEN'); assert.equal(row.priority, 'NORMAL');
});

test('reporter identity is hidden from developers unless explicitly permitted', async () => {
  const n = (await submit(U.rep, { title: 'Identity check report' })).body.report.number;
  const dev = (await U.dev.get(`/developer/reports/${n}`)).body.report;
  assert.equal(dev.reporter, null);
  assert.equal(JSON.stringify(dev).includes(U.rep.username), false);
  assert.equal(JSON.stringify((await U.dev.get('/developer/reports?page_size=50')).body).includes(U.rep.username), false);
  const adm = (await U.admin.get(`/developer/reports/${n}`)).body.report;
  assert.equal(adm.reporter.id, U.rep.id);
  assert.equal(dev.reporter_ref, adm.reporter_ref, 'same opaque reference everywhere');
  assert.equal((await U.admin.put('/admin/staff/permissions', { user_id: U.dev2.id, permission: 'REPORTER_IDENTITY' })).status, 200);
  assert.equal((await U.dev2.get(`/developer/reports/${n}`)).body.report.reporter.username, U.rep.username);
  assert.equal((await U.admin.del(`/admin/staff/permissions/${U.dev2.id}/REPORTER_IDENTITY`)).status, 200);
  assert.equal((await U.dev2.get(`/developer/reports/${n}`)).body.report.reporter, null);
});

// ─── Security reports ────────────────────────────────────────────────
test('security reports are invisible to developers without explicit permission on every endpoint', async () => {
  const sr = await registerUser(S.base, 'secrep');
  const total0 = (await U.dev.get('/developer/overview')).body.overview.total;
  const r = await submit(sr, { title: 'Auth bypass in vault-xyz', description: 'Details of the vulnerability go here.', category: 'SECURITY' });
  assert.equal(r.status, 201);
  const n = r.body.report.number;
  // the reporter sees only their own entry, with reporter-safe fields
  assert.equal((await sr.get('/reports/mine')).body.reports.some(x => x.number === n && x.category === 'SECURITY'), true);
  assert.equal((await U.rep2.get('/reports/mine')).body.reports.some(x => x.number === n), false);

  const att = await upload(sr, n, [{ name: 'poc.png', data: PNG }]);
  assert.equal(att.status, 201);
  const attId = att.body.attachments[0].id;

  // plain developer: no trace anywhere
  assert.equal((await U.dev.get(`/developer/reports/${n}`)).status, 404);
  assert.equal((await U.dev.get(`/developer/reports/NYX-${n}`)).status, 404);
  assert.equal((await U.dev.patch(`/developer/reports/${n}`, { status: 'CLOSED' })).status, 404);
  assert.equal((await U.dev.post(`/developer/reports/${n}/notes`, { body: 'x' })).status, 404);
  assert.equal((await U.dev.post(`/developer/reports/${n}/related`, { with: n })).status, 404);
  assert.equal((await U.dev.put(`/developer/reports/${n}/link`, { url: 'https://github.com/a/b/issues/1' })).status, 404);
  assert.equal((await U.dev.get('/developer/reports?queue=security')).status, 404);
  assert.equal((await U.dev.get('/developer/reports?category=SECURITY')).status, 404);
  const listed = (await U.dev.get('/developer/reports?page_size=50&q=vault-xyz')).body;
  assert.equal(listed.total, 0); assert.equal('security' in listed.counts, false);
  assert.equal(JSON.stringify((await U.dev.get(`/developer/reports?page_size=50&q=${n}`)).body).includes('vault-xyz'), false);
  const ov = (await U.dev.get('/developer/overview')).body.overview;
  assert.equal(ov.total, total0, 'counts do not disclose that a security report exists');
  assert.equal(JSON.stringify(ov).includes('vault-xyz'), false);
  assert.equal((await download(U.dev, attId)).status, 404);
  // another developer's relation attempt to the security report is also a 404
  const other = (await submit(sr, { title: 'Ordinary report to link' })).body.report.number;
  assert.equal((await U.dev.post(`/developer/reports/${other}/related`, { with: n })).status, 404);
  assert.equal(JSON.stringify((await U.dev.get(`/developer/reports/${other}`)).body).includes('vault-xyz'), false);

  // administrators have access implicitly
  assert.equal((await U.admin.get(`/developer/reports/${n}`)).status, 200);
  assert.equal((await U.admin.get('/developer/reports?queue=security')).body.total >= 1, true);
  assert.equal((await download(U.admin, attId)).status, 200);

  // an eligible assignee must be authorised for security reports
  assert.equal((await U.admin.patch(`/developer/reports/${n}`, { assignee_id: U.sec.id })).status, 400);
  assert.equal((await U.admin.put('/admin/staff/permissions', { user_id: U.sec.id, permission: 'SECURITY_REPORTS' })).status, 200);
  assert.equal((await U.admin.patch(`/developer/reports/${n}`, { assignee_id: U.sec.id })).status, 200);

  // explicitly authorised developer
  assert.equal((await U.sec.get(`/developer/reports/${n}`)).status, 200);
  assert.equal((await U.sec.get('/developer/reports?queue=security')).body.total >= 1, true);
  assert.equal((await U.sec.get('/developer/overview')).body.overview.by_category.SECURITY >= 1, true);
  assert.equal((await download(U.sec, attId)).status, 200);
  assert.equal((await U.sec.post(`/developer/reports/${n}/notes`, { body: 'triaged' })).status, 200);
  // still not an admin
  assert.equal((await U.sec.get('/admin/staff/permissions')).status, 403);

  // only admins may grant, only to staff, only known permissions
  assert.equal((await U.admin.put('/admin/staff/permissions', { user_id: U.user.id, permission: 'SECURITY_REPORTS' })).status, 409);
  assert.equal((await U.admin.put('/admin/staff/permissions', { user_id: U.dev.id, permission: 'ROOT' })).status, 400);

  // access to security data is audited
  const dir = S.dir;
  await S.stop();
  const actions = await editDb(dir, (db, q) => q("SELECT action, COUNT(*) AS c FROM audit_logs WHERE action LIKE 'report.%' OR action LIKE 'staff.%' GROUP BY action"));
  S = await startServer({ dataDir: dir });
  for (const k of Object.keys(U)) U[k] = await login(S.base, U[k].username);
  const seen = Object.fromEntries(actions.map(a => [a.action, a.c]));
  for (const k of ['report.security_view', 'report.security_attachment_download', 'report.security_note', 'staff.permission_granted', 'staff.developer_role_synced']) assert.ok(seen[k] >= 1, 'audited: ' + k);
});

// ─── Attachments ─────────────────────────────────────────────────────
test('attachments: validated by content, size and count; downloads are authorised every time', async () => {
  const ar = await registerUser(S.base, 'attrep');
  const n = (await submit(ar, { title: 'Report with files here' })).body.report.number;
  assert.equal((await upload(ar, n, [{ name: 'a.exe', data: Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0, 0, 0]), type: 'image/png' }])).status, 415, 'claimed image/png, bytes say binary');
  assert.equal((await upload(ar, n, [{ name: 'big.png', data: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]) }])).status, 413);
  assert.equal((await upload(U.rep2, n, [{ name: 'x.png', data: PNG }])).status, 404, "cannot attach to someone else's report");
  assert.equal((await upload(U.dev, n, [{ name: 'x.png', data: PNG }])).status, 404, 'staff upload goes through the reporter only');
  const ok = await upload(ar, n, [{ name: '../../evil/../shot.png', data: PNG }, { name: 'log.txt', data: Buffer.from('line one\nline two') }]);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.ok(!ok.body.attachments[0].original_name.includes('/'));
  assert.equal((await upload(ar, n, [{ name: 'b.png', data: PNG }, { name: 'c.png', data: PNG }])).status, 409, 'max three per report');
  assert.equal((await upload(ar, n, [])).status, 400);

  const d = (await U.dev.get(`/developer/reports/${n}`)).body.report;
  assert.equal(d.attachments.length, 2);
  assert.equal(d.attachments.some(a => 'stored_name' in a || 'path' in a), false, 'storage names are never exposed');
  const png = d.attachments.find(a => a.mime === 'image/png');

  const res = await download(ar, png.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-disposition'), /^attachment;/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  assert.equal((await download(U.dev, png.id)).status, 200);
  assert.equal((await download(U.rep2, png.id)).status, 404, 'another user cannot guess their way in');
  assert.equal((await download(U.user, png.id)).status, 404);
  assert.equal((await download(null, png.id)).status, 401);
  assert.equal((await fetch(`${S.base}/uploads/${png.id}`)).status === 200, false, 'not reachable through the public /uploads route');
  // files are stored outside the public upload folder under random names
  const stored = fs.readdirSync(path.join(S.dir, 'report-attachments'));
  assert.ok(stored.length >= 2 && stored.every(f => /^[0-9a-f]{48}\.bin$/.test(f)));
  assert.equal(fs.existsSync(path.join(S.dir, 'uploads')) && fs.readdirSync(path.join(S.dir, 'uploads')).some(f => stored.includes(f)), false);
});

// ─── Migration / reconciliation on an existing database ──────────────
test('upgrading an existing database migrates feedback, reconciles developer roles and is repeatable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxie-devmig-'));
  let s = await startServer({ dataDir: dir });
  const names = {};
  for (const n of ['adm', 'badge', 'stale', 'adminbadge', 'plain']) names[n] = await registerUser(s.base, n);
  await s.stop();

  await editDb(dir, (db) => {
    const now = Date.now();
    // a 0.8.0-shaped database: legacy feedback, a badge with no role, a stale DEVELOPER role, an admin with the badge
    db.run("INSERT INTO user_feedback (id, user_id, category, message, diagnostics, status, created_at) VALUES ('fb1', ?, 'bug', 'App crashes when I open the emoji picker twice', 'v0.8.0 Linux', 'new', ?)", [names.plain.id, now - 3000]);
    db.run("INSERT INTO user_feedback (id, user_id, category, message, diagnostics, status, created_at) VALUES ('fb2', ?, 'idea', 'Please add pinned messages for DMs', NULL, 'new', ?)", [names.plain.id, now - 2000]);
    db.run("INSERT INTO user_feedback (id, user_id, category, message, diagnostics, status, created_at) VALUES ('fb3', ?, 'other', 'Nice app!!', NULL, 'new', ?)", [names.badge.id, now - 1000]);
    db.run("UPDATE users SET role = 'ADMIN' WHERE id = ?", [names.adm.id]);
    db.run("UPDATE users SET role = 'ADMIN' WHERE id = ?", [names.adminbadge.id]);
    db.run("UPDATE users SET role = 'DEVELOPER' WHERE id = ?", [names.stale.id]);
    for (const id of [names.badge.id, names.adminbadge.id]) db.run("INSERT INTO user_badges (user_id, badge_id, assigned_by, assigned_at) VALUES (?, 'developer', ?, ?)", [id, names.adm.id, now]);
    db.run("DELETE FROM schema_migrations WHERE id IN ('0.10.0-feedback-to-reports', '0.10.0-sync-developer-roles')");
    db.run('DELETE FROM reports');
  });

  const snapshot = async () => editDb(dir, (db, q) => ({
    roles: Object.fromEntries(q('SELECT username, role FROM users').map(r => [r.username, r.role])),
    reports: q('SELECT number, category, title, status, legacy_feedback_id, diagnostics FROM reports ORDER BY number'),
    feedback: q('SELECT COUNT(*) AS c FROM user_feedback')[0].c,
    users: q('SELECT COUNT(*) AS c FROM users')[0].c,
  }));

  s = await startServer({ dataDir: dir }); await s.stop();
  const one = await snapshot();
  assert.equal(one.roles[names.badge.username], 'DEVELOPER');
  assert.equal(one.roles[names.stale.username], 'USER', 'a DEVELOPER role without the badge is removed');
  assert.equal(one.roles[names.adminbadge.username], 'ADMIN', 'admins keep their role');
  assert.equal(one.roles[names.adm.username], 'ADMIN');
  assert.equal(one.roles[names.plain.username], 'USER');
  assert.equal(one.users, 5); assert.equal(one.feedback, 3, 'legacy table is left untouched');
  assert.deepEqual(one.reports.map(r => [r.category, r.status, r.legacy_feedback_id]), [['BUG', 'OPEN', 'fb1'], ['FEATURE', 'OPEN', 'fb2'], ['GENERAL', 'OPEN', 'fb3']]);
  assert.equal(one.reports[0].title, 'App crashes when I open the emoji picker twice');
  assert.equal(one.reports[0].diagnostics, 'v0.8.0 Linux');

  // run everything again, including forcing the migrations to re-apply: nothing duplicates
  await editDb(dir, (db) => db.run("DELETE FROM schema_migrations WHERE id IN ('0.10.0-feedback-to-reports', '0.10.0-sync-developer-roles')"));
  s = await startServer({ dataDir: dir }); await s.stop();
  assert.deepEqual(await snapshot(), one);
  const run = () => execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'syncDeveloperRoles.js')], { env: { ...process.env, NYXIE_DATA_DIR: dir }, cwd: ROOT }).toString();
  assert.match(run(), /0 promoted, 0 demoted/);
  assert.match(run(), /0 promoted, 0 demoted/);
  assert.deepEqual(await snapshot(), one);

  // the migrated reports show up in the workspace of an upgraded install
  s = await startServer({ dataDir: dir });
  try {
    const admin = await login(s.base, names.adm.username);
    const dev = await login(s.base, names.badge.username);
    assert.equal((await dev.get('/developer/reports?page_size=50')).body.total, 3);
    assert.equal((await admin.get('/developer/overview')).body.overview.total, 3);
    const plain = await login(s.base, names.plain.username);
    assert.equal((await plain.get('/developer/overview')).status, 403);
    // and the old Settings → Feedback history still works for the author
    assert.equal((await plain.get('/account/feedback')).body.feedback.length, 2);
  } finally { await s.stop(); }
});
