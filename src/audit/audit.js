// Append-only audit trail. Each line carries the hash of the previous line, so any edit, insertion or deletion
// is detectable by verify(). Synchronous writes keep the order exact.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIT_FILE = process.env.AIS_AUDIT_FILE || path.join(__dirname, '../../data/audit.log'); // env override is for tests
const GENESIS = '0'.repeat(64);

function hashOf(entry) {
  const { hash, ...rest } = entry;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

function lastEntry() {
  if (!fs.existsSync(AUDIT_FILE)) return null;
  const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

// Records one event. `type` is a fixed code; `fields` must not contain secrets.
function record(type, fields = {}) {
  fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  const prev = lastEntry();
  const entry = {
    seq: prev ? prev.seq + 1 : 1,
    at: new Date().toISOString(),
    type,
    fields,
    prev: prev ? prev.hash : GENESIS
  };
  entry.hash = hashOf(entry);
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  return entry;
}

// Recomputes the whole chain. Returns { ok, count, brokenAt }.
function verify() {
  if (!fs.existsSync(AUDIT_FILE)) return { ok: true, count: 0, brokenAt: null };
  const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
  let prevHash = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { return { ok: false, count: i, brokenAt: i + 1, reason: 'unparseable line' }; }
    if (e.seq !== i + 1) return { ok: false, count: i, brokenAt: i + 1, reason: 'sequence gap or reorder' };
    if (e.prev !== prevHash) return { ok: false, count: i, brokenAt: i + 1, reason: 'previous-hash mismatch' };
    if (hashOf(e) !== e.hash) return { ok: false, count: i, brokenAt: i + 1, reason: 'content altered' };
    prevHash = e.hash;
  }
  return { ok: true, count: lines.length, brokenAt: null };
}

function recent(limit = 50) {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map(l => JSON.parse(l));
}

module.exports = { record, verify, recent, AUDIT_FILE };
