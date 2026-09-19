// server/services/discoveryCategories.js — the fixed set of Server
// Discovery categories. Shared by routes/servers.js (validation on
// create/update + the /discover filter) so the backend is the single
// source of truth; the frontend category tabs/select just mirror this
// list rather than hard-coding their own copy that could drift.
//
// Keys are what's actually stored on servers.category and accepted by
// ?category= on GET /servers/discover. Labels are display-only.
const CATEGORIES = [
  { key: 'gaming', label: 'Gaming' },
  { key: 'music', label: 'Music' },
  { key: 'entertainment', label: 'Entertainment' },
  { key: 'science-tech', label: 'Science & Tech' },
  { key: 'education', label: 'Education' },
  { key: 'student-hubs', label: 'Student Hubs' }
];

const CATEGORY_KEYS = new Set(CATEGORIES.map(c => c.key));

function isValidCategory(key) {
  return typeof key === 'string' && CATEGORY_KEYS.has(key);
}

module.exports = { CATEGORIES, isValidCategory };
