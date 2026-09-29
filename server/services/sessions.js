// server/services/sessions.js — device sessions behind the Sessions
// settings tab. A session row is created at login/register; its id rides
// inside the JWT as `sid`. Revoking the row invalidates that token.
const crypto = require('crypto');
const { run, get, all } = require('../database/userDb');

const TOUCH_INTERVAL_MS = 60 * 1000;

function describeUserAgent(ua) {
  ua = String(ua || '');
  let browser = 'Unknown browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let os = 'Unknown OS';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  const mobile = /Android|iPhone|iPad|Mobile/.test(ua);
  return { browser, os, mobile };
}

function createSession(db, userId, req) {
  const id = crypto.randomUUID();
  const now = Date.now();
  run(db,
    'INSERT INTO user_sessions (id, user_id, user_agent, ip, created_at, last_active, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)',
    [id, userId, String(req.get('user-agent') || '').slice(0, 300), String(req.ip || '').slice(0, 64), now, now]);
  // Keep the table from growing forever: drop revoked rows and anything
  // idle for longer than the token lifetime (7 days).
  const cutoff = now - 8 * 24 * 60 * 60 * 1000;
  run(db, 'DELETE FROM user_sessions WHERE user_id = ? AND (revoked = 1 OR last_active < ?) AND id != ?', [userId, cutoff, id]);
  return id;
}

// Returns true when the session exists and is live. Also bumps
// last_active at most once a minute so listing stays useful without
// writing the database on every request.
function checkSession(db, sid, userId) {
  const row = get(db, 'SELECT id, user_id, revoked, last_active FROM user_sessions WHERE id = ?', [sid]);
  if (!row || row.user_id !== userId || row.revoked) return false;
  const now = Date.now();
  if (now - row.last_active > TOUCH_INTERVAL_MS) {
    run(db, 'UPDATE user_sessions SET last_active = ? WHERE id = ?', [now, sid]);
  }
  return true;
}

function listSessions(db, userId, currentSid) {
  return all(db,
    'SELECT id, user_agent, ip, created_at, last_active FROM user_sessions WHERE user_id = ? AND revoked = 0 ORDER BY last_active DESC',
    [userId]
  ).map(r => ({
    id: r.id,
    ...describeUserAgent(r.user_agent),
    ip: r.ip || null,
    createdAt: r.created_at,
    lastActive: r.last_active,
    current: r.id === currentSid,
  }));
}

module.exports = { createSession, checkSession, listSessions, describeUserAgent };
