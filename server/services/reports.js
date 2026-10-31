// server/services/reports.js — Feedback & Issues: all report business logic.
//
// Rules this module enforces for every caller (routes never touch SQL):
//   * Reporters can only ever set title/description/category/app_version/
//     platform/diagnostics. Status, priority, assignee, notes, links are
//     staff-only and are never read from a submission.
//   * Staff access is checked per object. A SECURITY report is invisible
//     (404, excluded from lists/counts/search/metrics) to staff without the
//     SECURITY_REPORTS permission.
//   * Every staff mutation runs in one transaction, bumps `version` and
//     writes its report_events row(s) with the actor and a timestamp.
//   * Nothing here ever reads message contents, keys, tokens or presence.
const crypto = require('crypto');
const { all, get, run, transaction } = require('../database/userDb');
const { ensureWalletTables } = require('../database/walletDb');
const { audit } = require('./walletService');
const staff = require('./staff');

class ReportError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const CATEGORIES = Object.freeze(['BUG', 'FEATURE', 'GENERAL', 'SECURITY']);
const STATUSES = Object.freeze(['OPEN', 'UNDER_REVIEW', 'PLANNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'DECLINED']);
const PRIORITIES = Object.freeze(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const ACTIVE_STATUSES = Object.freeze(['OPEN', 'UNDER_REVIEW', 'PLANNED', 'IN_PROGRESS']);

// Allowed status transitions. Anything not listed is rejected with 409.
const TRANSITIONS = Object.freeze({
  OPEN:         ['UNDER_REVIEW', 'PLANNED', 'IN_PROGRESS', 'DECLINED', 'CLOSED'],
  UNDER_REVIEW: ['OPEN', 'PLANNED', 'IN_PROGRESS', 'RESOLVED', 'DECLINED', 'CLOSED'],
  PLANNED:      ['UNDER_REVIEW', 'IN_PROGRESS', 'DECLINED', 'CLOSED'],
  IN_PROGRESS:  ['UNDER_REVIEW', 'PLANNED', 'RESOLVED', 'DECLINED', 'CLOSED'],
  RESOLVED:     ['OPEN', 'IN_PROGRESS', 'CLOSED'],
  CLOSED:       ['OPEN'],
  DECLINED:     ['OPEN'],
});

const LIMITS = Object.freeze({
  TITLE_MIN: 5, TITLE_MAX: 120,
  DESC_MIN: 10, DESC_MAX: 5000,
  NOTE_MAX: 4000,
  VERSION_MAX: 32, PLATFORM_MAX: 64, DIAG_MAX: 600,
  LINK_MAX: 300,
  MAX_ATTACHMENTS: 3,
  SUBMISSIONS_PER_HOUR: 10,
});

const displayId = n => `NYX-${n}`;

function parseReportNumber(v) {
  const m = /^(?:NYX-)?#?(\d{1,9})$/i.exec(String(v == null ? '' : v).trim());
  return m ? parseInt(m[1], 10) : null;
}

// Plain text only: normalise newlines, drop control characters (keeps \n and \t).
// HTML is never interpreted server-side; the UI escapes on render.
function cleanText(v, max) {
  let s = String(v == null ? '' : v).replace(/\r\n?/g, '\n');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '');
  s = s.trim();
  return max ? s.slice(0, max) : s;
}

function reporterRef(userId) {
  const key = process.env.REPORT_REF_SECRET || require('./jwt').JWT_SECRET;
  return crypto.createHmac('sha256', key).update('reporter-ref:' + userId).digest('hex').slice(0, 10);
}

function auditSensitive(db, actorId, action, report, extra = {}) {
  try {
    ensureWalletTables(db);
    audit(db, actorId, action, report.id, { number: report.number, category: report.category, ...extra });
  } catch (e) { console.error('[reports] audit failed:', e.message); }
}

// ── Submission (reporter) ───────────────────────────────────────────
function createReport(db, user, input = {}) {
  const category = String(input.category || '').toUpperCase();
  if (!CATEGORIES.includes(category)) throw new ReportError(400, 'BAD_CATEGORY', 'Pick a category');
  const title = cleanText(input.title, LIMITS.TITLE_MAX + 1);
  const description = cleanText(input.description, LIMITS.DESC_MAX + 1);
  if (title.length < LIMITS.TITLE_MIN || title.length > LIMITS.TITLE_MAX) {
    throw new ReportError(400, 'BAD_TITLE', `Title must be ${LIMITS.TITLE_MIN}–${LIMITS.TITLE_MAX} characters`);
  }
  if (description.length < LIMITS.DESC_MIN || description.length > LIMITS.DESC_MAX) {
    throw new ReportError(400, 'BAD_DESCRIPTION', `Description must be ${LIMITS.DESC_MIN}–${LIMITS.DESC_MAX} characters`);
  }
  const appVersion = cleanText(input.app_version, LIMITS.VERSION_MAX + 1);
  const platform = cleanText(input.platform, LIMITS.PLATFORM_MAX + 1);
  if (appVersion.length > LIMITS.VERSION_MAX) throw new ReportError(400, 'BAD_VERSION', 'App version is too long');
  if (platform.length > LIMITS.PLATFORM_MAX) throw new ReportError(400, 'BAD_PLATFORM', 'Platform is too long');
  // Diagnostics are only stored when the reporter explicitly opted in.
  let diagnostics = null;
  if (input.diagnostics_consent === true && input.diagnostics != null) {
    diagnostics = cleanText(input.diagnostics, LIMITS.DIAG_MAX + 1);
    if (diagnostics.length > LIMITS.DIAG_MAX) throw new ReportError(400, 'BAD_DIAGNOSTICS', 'Diagnostics are too long');
    if (!diagnostics) diagnostics = null;
  }

  const recent = get(db, 'SELECT COUNT(*) AS c FROM reports WHERE reporter_id = ? AND created_at > ?', [user.id, Date.now() - 3600 * 1000]).c;
  if (recent >= LIMITS.SUBMISSIONS_PER_HOUR) {
    throw new ReportError(429, 'RATE_LIMITED', 'You have sent a lot of reports recently. Please try again later.');
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  let number;
  transaction(db, () => {
    number = get(db, 'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM reports').n;
    run(db, `INSERT INTO reports (id, number, reporter_id, reporter_ref, title, description, category, status, priority,
                                  app_version, platform, diagnostics, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', 'NORMAL', ?, ?, ?, 1, ?, ?)`,
      [id, number, user.id, reporterRef(user.id), title, description, category,
       appVersion || null, platform || null, diagnostics, now, now]);
    run(db, `INSERT INTO report_events (id, report_id, actor_id, type, to_value, created_at) VALUES (?, ?, NULL, 'CREATED', ?, ?)`,
      [crypto.randomUUID(), id, category, now]);
  });
  return { id, number, display_id: displayId(number), category, status: 'OPEN', title, created_at: now };
}

// What a reporter may see about their own reports: no priority, assignee,
// notes, history or links.
function listMine(db, userId, limit = 20) {
  return all(db, `
    SELECT r.number, r.title, r.category, r.status, r.created_at, r.updated_at,
           (SELECT COUNT(*) FROM report_attachments a WHERE a.report_id = r.id) AS attachment_count
    FROM reports r WHERE r.reporter_id = ?
    ORDER BY r.created_at DESC, r.number DESC LIMIT ?`, [userId, Math.min(Math.max(limit | 0, 1), 50)])
    .map(r => ({ ...r, display_id: displayId(r.number) }));
}

function getOwnReport(db, userId, number) {
  const n = parseReportNumber(number);
  if (n == null) return null;
  return get(db, 'SELECT * FROM reports WHERE number = ? AND reporter_id = ?', [n, userId]);
}

// ── Staff access ────────────────────────────────────────────────────
// Returns the raw report row or null. null covers "doesn't exist" AND "you
// may not see it", so a restricted report cannot be probed for existence.
function loadForStaff(db, user, number) {
  if (!staff.hasWorkspaceAccess(user)) return null;
  const n = parseReportNumber(number);
  if (n == null) return null;
  const r = get(db, 'SELECT * FROM reports WHERE number = ?', [n]);
  if (!r) return null;
  if (r.category === 'SECURITY' && !staff.canViewSecurityReports(db, user)) return null;
  return r;
}

function mustLoad(db, user, number) {
  const r = loadForStaff(db, user, number);
  if (!r) throw new ReportError(404, 'NOT_FOUND', 'Report not found');
  return r;
}

// ── Listing / search ────────────────────────────────────────────────
const SORTS = {
  newest: 'r.created_at DESC, r.number DESC',
  oldest: 'r.created_at ASC, r.number ASC',
  updated: 'r.updated_at DESC, r.number DESC',
  priority: `CASE r.priority WHEN 'URGENT' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'NORMAL' THEN 2 ELSE 1 END DESC, r.updated_at DESC, r.number DESC`,
};
const QUEUES = { all: null, bug: 'BUG', feature: 'FEATURE', general: 'GENERAL', security: 'SECURITY' };

function escapeLike(s) { return s.replace(/[\\%_]/g, ch => '\\' + ch); }

function parseListParams(q = {}) {
  const out = {};
  const queue = String(q.queue || 'all').toLowerCase();
  if (!(queue in QUEUES)) throw new ReportError(400, 'BAD_QUEUE', 'Unknown queue');
  out.queue = queue;
  for (const [key, allowed] of [['status', STATUSES], ['priority', PRIORITIES], ['category', CATEGORIES]]) {
    if (q[key] != null && q[key] !== '') {
      const v = String(q[key]).toUpperCase();
      if (!allowed.includes(v)) throw new ReportError(400, 'BAD_FILTER', `Unknown ${key}`);
      out[key] = v;
    }
  }
  if (q.assignee != null && q.assignee !== '') {
    const a = String(q.assignee);
    if (a.length > 64) throw new ReportError(400, 'BAD_FILTER', 'Unknown assignee');
    out.assignee = a;
  }
  const sort = String(q.sort || 'newest');
  if (!(sort in SORTS)) throw new ReportError(400, 'BAD_SORT', 'Unknown sort');
  out.sort = sort;
  out.q = cleanText(q.q, 100);
  out.page = Math.max(parseInt(q.page, 10) || 1, 1);
  out.pageSize = Math.min(Math.max(parseInt(q.page_size, 10) || 25, 1), 50);
  if (out.page > 100000) out.page = 100000;
  return out;
}

// Builds the WHERE for everything except queue/category (so queue counts can
// reuse it). The security restriction is part of every query.
function baseWhere(db, user, p) {
  const where = [];
  const args = [];
  if (!staff.canViewSecurityReports(db, user)) where.push("r.category <> 'SECURITY'");
  if (p.status) { where.push('r.status = ?'); args.push(p.status); }
  if (p.priority) { where.push('r.priority = ?'); args.push(p.priority); }
  if (p.assignee) {
    if (p.assignee === 'none') where.push('r.assignee_id IS NULL');
    else if (p.assignee === 'me') { where.push('r.assignee_id = ?'); args.push(user.id); }
    else { where.push('r.assignee_id = ?'); args.push(p.assignee); }
  }
  if (p.q) {
    const num = parseReportNumber(p.q);
    const like = `%${escapeLike(p.q)}%`;
    if (num != null) { where.push("(r.number = ? OR r.title LIKE ? ESCAPE '\\')"); args.push(num, like); }
    else { where.push("r.title LIKE ? ESCAPE '\\'"); args.push(like); }
  }
  return { where, args };
}

function listForStaff(db, user, query) {
  if (!staff.hasWorkspaceAccess(user)) throw new ReportError(403, 'FORBIDDEN', 'Developer access required');
  const p = parseListParams(query);
  const allowSecurity = staff.canViewSecurityReports(db, user);
  // Asking for the security queue/category without permission is "no such queue".
  const wantsSecurity = QUEUES[p.queue] === 'SECURITY' || p.category === 'SECURITY';
  if (wantsSecurity && !allowSecurity) throw new ReportError(404, 'NOT_FOUND', 'Queue not found');

  const base = baseWhere(db, user, p);
  const where = [...base.where];
  const args = [...base.args];
  const queueCat = QUEUES[p.queue];
  if (queueCat) { where.push('r.category = ?'); args.push(queueCat); }
  if (p.category) { where.push('r.category = ?'); args.push(p.category); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = get(db, `SELECT COUNT(*) AS c FROM reports r ${clause}`, args).c;
  const rows = all(db, `
    SELECT r.id, r.number, r.title, r.category, r.status, r.priority, r.reporter_ref,
           r.assignee_id, r.created_at, r.updated_at, r.version,
           u.display_name AS assignee_name, u.username AS assignee_username,
           (SELECT COUNT(*) FROM report_events e WHERE e.report_id = r.id AND e.type = 'NOTE') AS note_count,
           (SELECT COUNT(*) FROM report_events e WHERE e.report_id = r.id) AS activity_count
    FROM reports r LEFT JOIN users u ON u.id = r.assignee_id
    ${clause}
    ORDER BY ${SORTS[p.sort]}
    LIMIT ? OFFSET ?`, [...args, p.pageSize, (p.page - 1) * p.pageSize]);

  // Queue counts honour status/priority/assignee/search but not the queue.
  const countRows = all(db, `SELECT r.category AS category, COUNT(*) AS c FROM reports r ${base.where.length ? 'WHERE ' + base.where.join(' AND ') : ''} GROUP BY r.category`, base.args);
  const byCat = Object.fromEntries(countRows.map(r => [r.category, r.c]));
  const counts = {
    all: countRows.reduce((a, r) => a + r.c, 0),
    bug: byCat.BUG || 0, feature: byCat.FEATURE || 0, general: byCat.GENERAL || 0,
  };
  if (allowSecurity) counts.security = byCat.SECURITY || 0;

  return {
    reports: rows.map(r => ({
      id: r.id, number: r.number, display_id: displayId(r.number), title: r.title, category: r.category,
      status: r.status, priority: r.priority, reporter_ref: r.reporter_ref,
      assignee: r.assignee_id ? { id: r.assignee_id, display_name: r.assignee_name || r.assignee_username } : null,
      created_at: r.created_at, updated_at: r.updated_at, version: r.version,
      note_count: r.note_count, activity_count: r.activity_count,
    })),
    page: p.page, page_size: p.pageSize, total, total_pages: Math.max(Math.ceil(total / p.pageSize), 1), counts,
  };
}

// ── Details ─────────────────────────────────────────────────────────
function relationView(db, user, rows, allowSecurity) {
  const out = [];
  for (const r of rows) {
    if (r.category === 'SECURITY' && !allowSecurity) continue;
    out.push({ number: r.number, display_id: displayId(r.number), title: r.title, status: r.status, kind: r.kind, direction: r.direction });
  }
  return out;
}

function getDetail(db, user, number) {
  const r = mustLoad(db, user, number);
  const allowSecurity = staff.canViewSecurityReports(db, user);
  const events = all(db, `
    SELECT e.id, e.type, e.from_value, e.to_value, e.body, e.created_at, e.actor_id,
           u.display_name AS actor_name, u.username AS actor_username
    FROM report_events e LEFT JOIN users u ON u.id = e.actor_id
    WHERE e.report_id = ? ORDER BY e.created_at ASC, e.rowid ASC`, [r.id])
    .map(e => ({
      id: e.id, type: e.type, from: e.from_value, to: e.to_value, body: e.body, created_at: e.created_at,
      actor: e.actor_id ? { id: e.actor_id, display_name: e.actor_name || e.actor_username || 'Unknown' } : null,
    }));
  const attachments = all(db, 'SELECT id, original_name, mime, size, created_at FROM report_attachments WHERE report_id = ? ORDER BY created_at ASC', [r.id]);
  const relRows = all(db, `
    SELECT x.number, x.title, x.status, x.category, rel.kind, 'out' AS direction
      FROM report_relations rel JOIN reports x ON x.id = rel.related_id WHERE rel.report_id = ?
    UNION ALL
    SELECT x.number, x.title, x.status, x.category, rel.kind, 'in' AS direction
      FROM report_relations rel JOIN reports x ON x.id = rel.report_id WHERE rel.related_id = ?
    ORDER BY number`, [r.id, r.id]);

  const detail = {
    id: r.id, number: r.number, display_id: displayId(r.number), title: r.title, description: r.description,
    category: r.category, status: r.status, priority: r.priority, version: r.version,
    allowed_transitions: TRANSITIONS[r.status],
    reporter_ref: r.reporter_ref, app_version: r.app_version, platform: r.platform,
    diagnostics: r.diagnostics, diagnostics_provided: !!r.diagnostics,
    linked: r.linked_url ? { url: r.linked_url, kind: r.linked_kind } : null,
    assignee: null, created_at: r.created_at, updated_at: r.updated_at, resolved_at: r.resolved_at,
    events, attachments, relations: relationView(db, user, relRows, allowSecurity),
    reporter: null,
    permissions: { can_view_identity: staff.canViewReporterIdentity(db, user) },
  };
  if (r.assignee_id) {
    const a = get(db, 'SELECT id, display_name, username, role FROM users WHERE id = ?', [r.assignee_id]);
    detail.assignee = a ? { id: a.id, display_name: a.display_name || a.username, role: a.role } : { id: r.assignee_id, display_name: 'Unknown', role: null };
  }
  if (detail.permissions.can_view_identity) {
    const rep = get(db, 'SELECT id, username, display_name FROM users WHERE id = ?', [r.reporter_id]);
    detail.reporter = rep ? { id: rep.id, username: rep.username, display_name: rep.display_name || rep.username } : null;
    auditSensitive(db, user.id, 'report.identity_view', r);
  }
  if (r.category === 'SECURITY') auditSensitive(db, user.id, 'report.security_view', r);
  return detail;
}

// ── Mutations ───────────────────────────────────────────────────────
function pushEvent(db, reportId, actorId, type, from, to, body, now) {
  run(db, `INSERT INTO report_events (id, report_id, actor_id, type, from_value, to_value, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [crypto.randomUUID(), reportId, actorId, type, from == null ? null : String(from), to == null ? null : String(to), body || null, now]);
}

function bump(db, reportId, now, extraSet = '', extraArgs = []) {
  run(db, `UPDATE reports SET version = version + 1, updated_at = ?${extraSet} WHERE id = ?`, [now, ...extraArgs, reportId]);
}

function checkVersion(r, expected) {
  if (expected != null && expected !== '' && Number(expected) !== r.version) {
    throw new ReportError(409, 'VERSION_CONFLICT', 'This report was changed by someone else. Reload and try again.');
  }
}

function validateAssignee(db, report, assigneeId) {
  const a = get(db, 'SELECT id, role, disabled FROM users WHERE id = ?', [assigneeId]);
  if (!a) throw new ReportError(400, 'BAD_ASSIGNEE', 'That account does not exist');
  if (a.disabled) throw new ReportError(400, 'BAD_ASSIGNEE', 'That account is disabled');
  if (!staff.hasWorkspaceAccess(a)) throw new ReportError(400, 'BAD_ASSIGNEE', 'Only developers and administrators can be assigned reports');
  if (report.category === 'SECURITY' && !staff.canViewSecurityReports(db, a)) {
    throw new ReportError(400, 'BAD_ASSIGNEE', 'That person is not authorised for security reports');
  }
  return a;
}

function updateReport(db, user, number, patch = {}) {
  return transaction(db, () => {
    const r = mustLoad(db, user, number);
    checkVersion(r, patch.expected_version);
    const now = Date.now();
    const changes = [];
    const set = [];
    const args = [];

    if (patch.status !== undefined) {
      const to = String(patch.status).toUpperCase();
      if (!STATUSES.includes(to)) throw new ReportError(400, 'BAD_STATUS', 'Unknown status');
      if (to !== r.status) {
        if (!TRANSITIONS[r.status].includes(to)) {
          throw new ReportError(409, 'BAD_TRANSITION', `A report that is ${r.status} cannot move to ${to}`);
        }
        pushEvent(db, r.id, user.id, 'STATUS', r.status, to, null, now);
        set.push(', status = ?'); args.push(to);
        set.push(', resolved_at = ?'); args.push(to === 'RESOLVED' ? now : null);
        changes.push('status');
      }
    }
    if (patch.priority !== undefined) {
      const to = String(patch.priority).toUpperCase();
      if (!PRIORITIES.includes(to)) throw new ReportError(400, 'BAD_PRIORITY', 'Unknown priority');
      if (to !== r.priority) {
        pushEvent(db, r.id, user.id, 'PRIORITY', r.priority, to, null, now);
        set.push(', priority = ?'); args.push(to);
        changes.push('priority');
      }
    }
    if (patch.assignee_id !== undefined) {
      const to = patch.assignee_id === null || patch.assignee_id === '' ? null : String(patch.assignee_id).slice(0, 64);
      if (to !== (r.assignee_id || null)) {
        if (to) validateAssignee(db, r, to);
        pushEvent(db, r.id, user.id, 'ASSIGNEE', r.assignee_id, to, null, now);
        set.push(', assignee_id = ?'); args.push(to);
        changes.push('assignee');
      }
    }
    if (changes.length) {
      bump(db, r.id, now, set.join(''), args);
      if (r.category === 'SECURITY') auditSensitive(db, user.id, 'report.security_update', r, { changes });
    }
    return { changed: changes, report: getDetailNoAudit(db, user, r.number) };
  });
}

// Re-read after a mutation without writing another "viewed" audit row.
function getDetailNoAudit(db, user, number) {
  const r = mustLoad(db, user, number);
  return { number: r.number, display_id: displayId(r.number), status: r.status, priority: r.priority, assignee_id: r.assignee_id, version: r.version, updated_at: r.updated_at };
}

function addNote(db, user, number, body) {
  const text = cleanText(body, LIMITS.NOTE_MAX + 1);
  if (!text) throw new ReportError(400, 'BAD_NOTE', 'Write something first');
  if (text.length > LIMITS.NOTE_MAX) throw new ReportError(400, 'BAD_NOTE', `Notes are limited to ${LIMITS.NOTE_MAX} characters`);
  return transaction(db, () => {
    const r = mustLoad(db, user, number);
    const now = Date.now();
    pushEvent(db, r.id, user.id, 'NOTE', null, null, text, now);
    bump(db, r.id, now);
    if (r.category === 'SECURITY') auditSensitive(db, user.id, 'report.security_note', r);
    return { ok: true };
  });
}

function addRelation(db, user, number, otherNumber, kind) {
  if (kind !== 'DUPLICATE' && kind !== 'RELATED') throw new ReportError(400, 'BAD_RELATION', 'Unknown relation');
  return transaction(db, () => {
    const r = mustLoad(db, user, number);
    const other = loadForStaff(db, user, otherNumber);
    if (!other) throw new ReportError(404, 'NOT_FOUND', 'Report not found');
    if (other.id === r.id) throw new ReportError(400, 'BAD_RELATION', 'A report cannot be linked to itself');
    const existing = get(db, `SELECT 1 AS x FROM report_relations WHERE (report_id = ? AND related_id = ?) OR (report_id = ? AND related_id = ?)`, [r.id, other.id, other.id, r.id]);
    if (existing) throw new ReportError(409, 'ALREADY_LINKED', 'Those reports are already linked');
    if (kind === 'DUPLICATE') {
      // Always point at the original, never at another duplicate.
      const chained = get(db, "SELECT 1 AS x FROM report_relations WHERE report_id = ? AND kind = 'DUPLICATE'", [other.id]);
      if (chained) throw new ReportError(409, 'BAD_RELATION', `${displayId(other.number)} is itself a duplicate; link to the original report`);
    }
    const now = Date.now();
    run(db, 'INSERT INTO report_relations (report_id, related_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [r.id, other.id, kind, user.id, now]);
    pushEvent(db, r.id, user.id, kind, null, displayId(other.number), null, now);
    let set = '', args = [];
    // A duplicate is closed (never deleted) unless it already is finished.
    if (kind === 'DUPLICATE' && ['OPEN', 'UNDER_REVIEW', 'PLANNED', 'IN_PROGRESS'].includes(r.status)) {
      pushEvent(db, r.id, user.id, 'STATUS', r.status, 'CLOSED', 'Closed as duplicate', now);
      set = ', status = ?, resolved_at = NULL'; args = ['CLOSED'];
    }
    bump(db, r.id, now, set, args);
    if (r.category === 'SECURITY') auditSensitive(db, user.id, 'report.security_update', r, { changes: [kind.toLowerCase()] });
    return { ok: true };
  });
}

function removeRelation(db, user, number, otherNumber) {
  return transaction(db, () => {
    const r = mustLoad(db, user, number);
    const other = loadForStaff(db, user, otherNumber);
    if (!other) throw new ReportError(404, 'NOT_FOUND', 'Report not found');
    const rel = get(db, `SELECT report_id, related_id, kind FROM report_relations WHERE (report_id = ? AND related_id = ?) OR (report_id = ? AND related_id = ?)`, [r.id, other.id, other.id, r.id]);
    if (!rel) throw new ReportError(404, 'NOT_FOUND', 'Those reports are not linked');
    run(db, 'DELETE FROM report_relations WHERE report_id = ? AND related_id = ?', [rel.report_id, rel.related_id]);
    const now = Date.now();
    pushEvent(db, r.id, user.id, rel.kind, displayId(other.number), null, 'Link removed', now);
    bump(db, r.id, now);
    return { ok: true };
  });
}

// Only https links; the UI renders them with rel="noopener noreferrer".
function parseDevLink(raw) {
  const s = cleanText(raw, LIMITS.LINK_MAX + 1);
  if (s.length > LIMITS.LINK_MAX) throw new ReportError(400, 'BAD_LINK', 'That link is too long');
  let u;
  try { u = new URL(s); } catch (_) { throw new ReportError(400, 'BAD_LINK', 'Enter a full https:// link'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new ReportError(400, 'BAD_LINK', 'Only https:// links are allowed');
  const gh = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+$/.exec(u.origin + u.pathname.replace(/\/$/, ''));
  return { url: u.origin + u.pathname.replace(/\/$/, '') + u.search, kind: gh ? (gh[1] === 'pull' ? 'PULL_REQUEST' : 'ISSUE') : 'LINK' };
}

function setDevLink(db, user, number, rawUrl) {
  return transaction(db, () => {
    const r = mustLoad(db, user, number);
    const clearing = rawUrl === null || rawUrl === '';
    const link = clearing ? null : parseDevLink(rawUrl);
    const now = Date.now();
    if ((link && link.url) === (r.linked_url || null) || (clearing && !r.linked_url)) return { ok: true, changed: false };
    pushEvent(db, r.id, user.id, 'LINK', r.linked_url, link ? link.url : null, null, now);
    bump(db, r.id, now, ', linked_url = ?, linked_kind = ?', [link ? link.url : null, link ? link.kind : null]);
    return { ok: true, changed: true, linked: link };
  });
}

function recordAttachment(db, report, uploaderId, file) {
  const id = crypto.randomUUID();
  const now = Date.now();
  transaction(db, () => {
    run(db, `INSERT INTO report_attachments (id, report_id, uploader_id, original_name, stored_name, mime, size, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, report.id, uploaderId, file.original_name, file.stored_name, file.mime, file.size, now]);
    pushEvent(db, report.id, null, 'ATTACHMENT', null, file.original_name, null, now);
  });
  return { id, original_name: file.original_name, mime: file.mime, size: file.size, created_at: now };
}

// Who may download an attachment: the reporter of that report, or staff who
// may see that report (the security rule applies to attachments too).
function authorizeAttachment(db, user, attachmentId) {
  const a = get(db, 'SELECT * FROM report_attachments WHERE id = ?', [String(attachmentId).slice(0, 64)]);
  if (!a) return null;
  const r = get(db, 'SELECT * FROM reports WHERE id = ?', [a.report_id]);
  if (!r) return null;
  if (r.reporter_id === user.id) return { attachment: a, report: r, asStaff: false };
  if (!staff.hasWorkspaceAccess(user)) return null;
  if (r.category === 'SECURITY' && !staff.canViewSecurityReports(db, user)) return null;
  return { attachment: a, report: r, asStaff: true };
}

// ── Overview metrics ────────────────────────────────────────────────
function overview(db, user, daysRaw) {
  if (!staff.hasWorkspaceAccess(user)) throw new ReportError(403, 'FORBIDDEN', 'Developer access required');
  let days = parseInt(daysRaw, 10);
  if (!Number.isFinite(days)) days = 30;
  days = Math.min(Math.max(days, 1), 365);
  const allowSecurity = staff.canViewSecurityReports(db, user);
  const vis = allowSecurity ? '1=1' : "category <> 'SECURITY'";
  const since = Date.now() - days * 86400000;
  const active = ACTIVE_STATUSES.map(() => '?').join(',');
  const c = (extra, args = []) => get(db, `SELECT COUNT(*) AS c FROM reports WHERE ${vis} ${extra}`, args).c;

  const byCategory = {};
  for (const row of all(db, `SELECT category, COUNT(*) AS c FROM reports WHERE ${vis} GROUP BY category`)) byCategory[row.category] = row.c;
  for (const cat of CATEGORIES) { if (cat !== 'SECURITY' || allowSecurity) byCategory[cat] = byCategory[cat] || 0; }

  const attentionCond = p => `${p}status IN (${active}) AND (${p}priority IN ('HIGH','URGENT') OR (${p}assignee_id IS NULL AND ${p}created_at < ?))`;
  const attentionArgs = [...ACTIVE_STATUSES, Date.now() - 72 * 3600000];
  const visR = allowSecurity ? '1=1' : "r.category <> 'SECURITY'";
  const recent = all(db, `SELECT r.number, r.title, r.category, r.status, r.priority, r.created_at FROM reports r
                          WHERE ${visR} ORDER BY r.created_at DESC, r.number DESC LIMIT 5`);
  const attention = all(db, `SELECT r.number, r.title, r.category, r.status, r.priority, r.created_at FROM reports r
                             WHERE ${visR} AND ${attentionCond('r.')}
                             ORDER BY CASE r.priority WHEN 'URGENT' THEN 4 WHEN 'HIGH' THEN 3 ELSE 1 END DESC, r.created_at ASC LIMIT 5`, attentionArgs);
  const fmt = r => ({ ...r, display_id: displayId(r.number) });
  return {
    days,
    total: c(''),
    open: c(`AND status IN (${active})`, ACTIVE_STATUSES),
    awaiting_review: c("AND status = 'OPEN'"),
    in_progress: c("AND status = 'IN_PROGRESS'"),
    resolved_in_period: c("AND status = 'RESOLVED' AND resolved_at >= ?", [since]),
    needs_attention: c(`AND ${attentionCond('')}`, attentionArgs),
    by_category: byCategory,
    recent: recent.map(fmt),
    attention: attention.map(fmt),
  };
}

function listAssignable(db, user) {
  if (!staff.hasWorkspaceAccess(user)) throw new ReportError(403, 'FORBIDDEN', 'Developer access required');
  return all(db, `SELECT id, display_name, username, role FROM users
                  WHERE role IN ('DEVELOPER','ADMIN') AND (disabled IS NULL OR disabled = 0)
                  ORDER BY COALESCE(display_name, username) COLLATE NOCASE LIMIT 200`)
    .map(u => ({ id: u.id, display_name: u.display_name || u.username, role: u.role }));
}

module.exports = {
  ReportError, CATEGORIES, STATUSES, PRIORITIES, TRANSITIONS, LIMITS, ACTIVE_STATUSES,
  displayId, parseReportNumber, cleanText,
  createReport, listMine, getOwnReport,
  listForStaff, getDetail, updateReport, addNote, addRelation, removeRelation, setDevLink,
  recordAttachment, authorizeAttachment, loadForStaff, overview, listAssignable, auditSensitive,
};
