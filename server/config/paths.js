// server/config/paths.js — single source of truth for where Nyxie keeps
// its on-disk data (SQLite files + uploads/avatars/banners).
//
// Default is <project root>/data, exactly as before. Setting
// NYXIE_DATA_DIR relocates all of it (used by the automated tests so they
// never touch a real database, and handy for container volumes).
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.NYXIE_DATA_DIR
  ? path.resolve(process.env.NYXIE_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');

module.exports = {
  PROJECT_ROOT,
  DATA_DIR,
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads')
};
