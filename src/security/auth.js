// Owner authentication for the API. One owner role. The token is generated once, shown once in the server
// console, and only a salted scrypt hash is stored. Nothing secret is written to the repository or logs.
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

const AUTH_FILE = process.env.AIS_AUTH_FILE || path.join(__dirname, '../../data/auth.json'); // env override is for tests
const KEY_LEN = 64;

let stored = null; // { salt, hash, createdAt }

function derive(token, salt) {
  return crypto.scryptSync(token, Buffer.from(salt, 'hex'), KEY_LEN).toString('hex');
}

// Creates the owner token on first run. Returns the new token (only on first run), else null.
async function init() {
  stored = await fs.readJson(AUTH_FILE).catch(() => null);
  if (stored && stored.hash && stored.salt) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  stored = { salt, hash: derive(token, salt), createdAt: new Date().toISOString() };
  await fs.ensureDir(path.dirname(AUTH_FILE));
  await fs.writeJson(AUTH_FILE, stored, { spaces: 2 });
  return token;
}

// Replaces the owner token. The old token stops working at once. Returns the new token; only its hash is stored.
async function rotate() {
  const token = crypto.randomBytes(32).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  stored = { salt, hash: derive(token, salt), createdAt: stored?.createdAt || now, rotatedAt: now };
  await fs.ensureDir(path.dirname(AUTH_FILE));
  await fs.writeJson(AUTH_FILE, stored, { spaces: 2 });
  return token;
}

function configured() {
  return !!(stored && stored.hash);
}

// Constant-time comparison of a presented token against the stored hash.
function verify(token) {
  if (!configured() || typeof token !== 'string' || token.length === 0 || token.length > 200) return false;
  const a = Buffer.from(derive(token, stored.salt), 'hex');
  const b = Buffer.from(stored.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Failed-attempt limiter, per client address. After MAX_FAILURES wrong tokens inside WINDOW_MS the address is
// locked for LOCK_MS. A correct token is still accepted while locked (checked before the lock), so guessing is
// slowed without locking out the owner who holds the token.
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60000;
const LOCK_MS = 15 * 60000;
const failures = new Map(); // address -> { count, windowStart, lockedUntil }

// Milliseconds the address stays locked, or 0.
function lockedFor(key, now = Date.now()) {
  const f = failures.get(key);
  return f && f.lockedUntil > now ? f.lockedUntil - now : 0;
}

// Records one wrong token. Returns the state, including lockedUntil when this failure triggered the lock.
function recordFailure(key, now = Date.now()) {
  let f = failures.get(key);
  if (!f || now - f.windowStart > WINDOW_MS) f = { count: 0, windowStart: now, lockedUntil: 0 };
  f.count++;
  if (f.count >= MAX_FAILURES && !f.lockedUntil) f.lockedUntil = now + LOCK_MS;
  failures.set(key, f);
  return { ...f };
}

function clearFailures(key) { failures.delete(key); }

module.exports = { init, rotate, verify, configured, AUTH_FILE, lockedFor, recordFailure, clearFailures, MAX_FAILURES, LOCK_MS };
