// server/database/migrations.js — versioned, re-runnable data migrations.
//
// Schema *additions* (new tables / ALTER TABLE ADD COLUMN) stay in
// userDb.js with the app's existing "try ALTER, ignore if it exists"
// pattern. This file is only for migrations that change existing ROWS.
// Each migration is recorded in `schema_migrations` once it has run, so
// starting the server again never re-applies it. Every migration runs
// inside a single transaction: it either applies completely or not at all.
//
// Bit values are written as literals on purpose — a migration describes
// the world as it was when it was written and must not change if the
// permission table in services/permissions.js grows later.
const fs = require('fs');

const BIT = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  MANAGE_SERVER: 1 << 3,
  KICK_MEMBERS: 1 << 6,
  VIEW_AUDIT_LOG: 1 << 11,
  MODERATE_MEMBERS: 1 << 12,
  READ_MESSAGE_HISTORY: 1 << 13,
  ATTACH_FILES: 1 << 14
};

const MIGRATIONS = [
  {
    id: '0.2.0-permission-backfill',
    // Roles created before 0.2.0 only know the original 11 permission
    // bits. Give them the new bits that preserve what they could already
    // do, so upgrading doesn't silently take abilities away:
    //   view channels  -> read message history
    //   send messages  -> attach files
    //   kick members   -> time out members
    //   manage server  -> view audit log
    up({ all, run }) {
      const roles = all('SELECT id, permissions FROM server_roles');
      for (const r of roles) {
        let p = r.permissions | 0;
        const before = p;
        if (p & BIT.VIEW_CHANNEL) p |= BIT.READ_MESSAGE_HISTORY;
        if (p & BIT.SEND_MESSAGES) p |= BIT.ATTACH_FILES;
        if (p & BIT.KICK_MEMBERS) p |= BIT.MODERATE_MEMBERS;
        if (p & BIT.MANAGE_SERVER) p |= BIT.VIEW_AUDIT_LOG;
        if (p !== before) run('UPDATE server_roles SET permissions = ? WHERE id = ?', [p, r.id]);
      }
    }
  },
  {
    id: '0.2.0-role-positions',
    // Reordering roles needs a strict, unique ranking. Older servers can
    // contain ties (every custom role used to default to position 10).
    // Rank non-default roles by (position DESC, created_at ASC) — the
    // same order the app already displayed — and number them n..1. The
    // default role stays at 0. Relative order is preserved; only exact
    // ties are broken (older role first).
    up({ all, run }) {
      const servers = all('SELECT DISTINCT server_id FROM server_roles');
      for (const { server_id } of servers) {
        const roles = all(
          `SELECT id, is_default FROM server_roles WHERE server_id = ?
           ORDER BY position DESC, created_at ASC, id ASC`, [server_id]);
        const others = roles.filter(r => !r.is_default);
        others.forEach((r, i) => run('UPDATE server_roles SET position = ? WHERE id = ?', [others.length - i, r.id]));
        roles.filter(r => r.is_default).forEach(r => run('UPDATE server_roles SET position = 0 WHERE id = ?', [r.id]));
      }
    }
  },
  {
    id: '0.2.0-orphan-member-roles',
    // Kicking/banning/leaving used to delete the membership row but leave
    // the member's role assignments behind, so a kicked Admin who rejoined
    // got Admin back. Drop assignments that no longer have a membership
    // (or whose role no longer exists).
    up({ run }) {
      run(`DELETE FROM server_member_roles WHERE NOT EXISTS (
             SELECT 1 FROM server_members sm
             WHERE sm.server_id = server_member_roles.server_id AND sm.user_id = server_member_roles.user_id)`);
      run(`DELETE FROM server_member_roles WHERE NOT EXISTS (
             SELECT 1 FROM server_roles sr
             WHERE sr.id = server_member_roles.role_id AND sr.server_id = server_member_roles.server_id)`);
    }
  },
  {
    id: '0.8.0-clear-last-seen',
    // 0.8.0 stops recording when a user was last connected. Wipe the
    // values already stored so old data doesn't linger in the database for
    // no purpose. The `last_seen` column itself is deliberately kept —
    // dropping columns is not supported on every SQLite build and older
    // code/tools may still name it — it simply stays NULL from now on.
    // Session `last_active` (the user's own device list, used for expiry)
    // is a different field and is not touched.
    up({ run }) {
      run('UPDATE users SET last_seen = NULL WHERE last_seen IS NOT NULL');
    }
  },
  {
    id: '0.10.0-feedback-to-reports',
    // The old Settings → Feedback form wrote to `user_feedback`, which nothing
    // could read. Copy those rows into `reports` so the Developer workspace
    // sees them. `user_feedback` is left untouched (nothing is deleted), and
    // legacy_feedback_id is UNIQUE + INSERT OR IGNORE so a re-run can never
    // duplicate a report. The reporter reference is a plain per-user hash
    // here; new reports use the keyed one from services/reports.js.
    up({ all, run }) {
      const crypto = require('crypto');
      const map = { bug: 'BUG', idea: 'FEATURE', other: 'GENERAL' };
      const rows = all('SELECT id, user_id, category, message, diagnostics, created_at FROM user_feedback ORDER BY created_at ASC, id ASC');
      let n = (all('SELECT COALESCE(MAX(number), 0) AS n FROM reports')[0] || { n: 0 }).n;
      for (const r of rows) {
        if (all('SELECT 1 AS x FROM reports WHERE legacy_feedback_id = ?', [r.id]).length) continue;
        n += 1;
        const message = String(r.message || '');
        const firstLine = message.split('\n')[0].trim();
        const title = (firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine) || 'Feedback';
        const ref = crypto.createHash('sha256').update('legacy:' + r.user_id).digest('hex').slice(0, 10);
        run(`INSERT OR IGNORE INTO reports
               (id, number, reporter_id, reporter_ref, title, description, category, status, priority, diagnostics,
                version, legacy_feedback_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', 'NORMAL', ?, 1, ?, ?, ?)`,
          [crypto.randomUUID(), n, r.user_id, ref, title, message, map[r.category] || 'GENERAL',
           r.diagnostics || null, r.id, r.created_at, r.created_at]);
      }
    }
  },
  {
    id: '0.10.0-sync-developer-roles',
    // The Developer role is derived from the developer badge (see
    // services/staff.js). Bring existing databases in line once; the same
    // reconciliation also runs on every start and via
    // scripts/syncDeveloperRoles.js, and is idempotent. ADMIN is never touched.
    up({ run }) {
      run(`UPDATE users SET role = 'DEVELOPER'
           WHERE role = 'USER' AND id IN (SELECT user_id FROM user_badges WHERE badge_id = 'developer')`);
      run(`UPDATE users SET role = 'USER'
           WHERE role = 'DEVELOPER' AND id NOT IN (SELECT user_id FROM user_badges WHERE badge_id = 'developer')`);
    }
  }
];

// `helpers` come from userDb.js so this file has no circular import.
function runMigrations(db, { all, get, run, transaction }, dbPath) {
  const pending = MIGRATIONS.filter(m => !get(db, 'SELECT 1 FROM schema_migrations WHERE id = ?', [m.id]));
  if (!pending.length) return [];

  // One-time safety copy of the on-disk database before any row is
  // rewritten. Best effort: a read-only disk must not stop startup.
  if (dbPath && fs.existsSync(dbPath)) {
    try {
      const safety = dbPath + '.pre-0.2.0.bak';
      if (!fs.existsSync(safety)) fs.copyFileSync(dbPath, safety);
    } catch (e) { console.warn('Could not write pre-migration backup:', e.message); }
  }

  const applied = [];
  for (const m of pending) {
    transaction(db, () => {
      m.up({
        all: (sql, params) => all(db, sql, params),
        run: (sql, params) => run(db, sql, params)
      });
      run(db, 'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [m.id, Date.now()]);
    });
    applied.push(m.id);
  }
  return applied;
}

module.exports = { runMigrations, MIGRATIONS };
