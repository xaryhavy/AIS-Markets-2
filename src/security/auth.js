// Sign-in authentication — single local admin user.
// Credentials are stored as a salted scrypt hash in data/users.json (never plaintext).
// Sessions are managed by express-session; this module handles only user storage and verification.
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

const USERS_FILE = process.env.AIS_USERS_FILE || process.env.AIS_AUTH_FILE || path.join(__dirname, '../../data/users.json');
const KEY_LEN = 64;

// Keep AUTH_FILE alias for backwards compat with tests that check it
const AUTH_FILE = USERS_FILE;

let stored = null; // { username, salt, hash, createdAt }

function derive(password, salt) {
  return crypto.scryptSync(password, Buffer.from(salt, 'hex'), KEY_LEN).toString('hex');
}

async function load() {
  try {
    const data = await fs.readJson(USERS_FILE);
    // Support both new format { username, salt, hash } and legacy array
    if (data && data.username && data.salt && data.hash) {
      stored = data;
    } else if (Array.isArray(data) && data[0] && data[0].username) {
      stored = data[0];
    } else {
      stored = null;
    }
  } catch {
    stored = null;
  }
  return stored;
}

async function save() {
  await fs.ensureDir(path.dirname(USERS_FILE));
  await fs.writeJson(USERS_FILE, stored, { spaces: 2 });
}

// Called at startup — loads existing user if any. Returns null (no auto-creation).
async function init() {
  await load();
  return null;
}

function configured() {
  return !!(stored && stored.hash && stored.salt && stored.username);
}

function getUsername() {
  return stored ? stored.username : null;
}

// Create the first (and only) local admin account. Fails if one already exists.
async function createUser(username, password) {
  if (configured()) throw new Error('An account already exists — use login instead');
  if (!username || typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 32) {
    throw new Error('Username must be 3-32 characters');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username.trim())) {
    throw new Error('Username may only contain letters, numbers, dot, underscore and hyphen');
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (password.length > 128) throw new Error('Password must be at most 128 characters');
  const clean = username.trim();
  const salt = crypto.randomBytes(16).toString('hex');
  stored = { username: clean, salt, hash: derive(password, salt), createdAt: new Date().toISOString() };
  await save();
  return { username: clean };
}

// Constant-time password verification for the single user.
function verify(username, password) {
  if (!configured() || typeof username !== 'string' || typeof password !== 'string') return false;
  if (username.trim() !== stored.username) return false;
  if (password.length === 0 || password.length > 200) return false;
  const a = Buffer.from(derive(password, stored.salt), 'hex');
  const b = Buffer.from(stored.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Change password — requires old password verification.
async function changePassword(username, oldPassword, newPassword) {
  if (!configured()) throw new Error('No account configured');
  if (!verify(username, oldPassword)) throw new Error('Current password is incorrect');
  if (!newPassword || newPassword.length < 8) throw new Error('New password must be at least 8 characters');
  if (newPassword.length > 128) throw new Error('New password must be at most 128 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  stored = { ...stored, salt, hash: derive(newPassword, salt), passwordChangedAt: new Date().toISOString() };
  await save();
  return { username: stored.username };
}

// Legacy: rotate() kept as alias to changePassword for backwards compat if called without args — now throws.
// New code should use changePassword. We keep a stub so old tests that import `rotate` fail clearly.
async function rotate() {
  throw new Error('Token rotation is removed — use changePassword instead');
}

// ── Rate limiter (per client address + username) ──
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60000;
const LOCK_MS = 15 * 60000;
const failures = new Map(); // key -> { count, windowStart, lockedUntil }

function failureKey(ip, username) {
  return `${ip || 'unknown'}:${(username || '').toLowerCase().trim() || '_'}`;
}

function lockedFor(key, now = Date.now()) {
  const f = failures.get(key);
  return f && f.lockedUntil > now ? f.lockedUntil - now : 0;
}

function recordFailure(key, now = Date.now()) {
  let f = failures.get(key);
  if (!f || now - f.windowStart > WINDOW_MS) f = { count: 0, windowStart: now, lockedUntil: 0 };
  f.count++;
  if (f.count >= MAX_FAILURES && !f.lockedUntil) f.lockedUntil = now + LOCK_MS;
  failures.set(key, f);
  return { ...f };
}

function clearFailures(key) { failures.delete(key); }

function resetForTests() {
  stored = null;
  failures.clear();
}

module.exports = {
  init, configured, getUsername, createUser, verify, changePassword, rotate,
  USERS_FILE, AUTH_FILE, derive, load,
  lockedFor, recordFailure, clearFailures, failureKey, resetForTests,
  MAX_FAILURES, LOCK_MS, WINDOW_MS, KEY_LEN,
};
