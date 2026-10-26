// Risk limits: validated, persisted, versioned, and enforced at the order boundary.
// Active values are the values AIS already used. New limits start DISABLED and only take effect after the
// owner approves a proposal. Every change is recorded in the history with its source.
const fs = require('fs-extra');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../../data/risk_config.json');
const EMERGENCY_FILE = process.env.AIS_EMERGENCY_FILE || path.join(__dirname, '../../data/emergency_stop.json'); // env override is for tests
const EQUITY_FILE = path.join(__dirname, '../../data/equity_history.json');
const EQUITY_MIN_INTERVAL_MS = 5 * 60 * 1000;
const EQUITY_MAX_POINTS = 20000;
const DRAWDOWN_WINDOW_MS = 30 * 24 * 3600 * 1000;

// Each limit: default value, safe bounds, whether it is active from the start, and why.
const SCHEMA = {
  riskPerTradePct:       { value: 1,     min: 0.1, max: 2,   enabled: true,  why: 'Loss at stop as % of balance. Existing behaviour.' },
  maxOpenPositions:      { value: 3,     min: 1,   max: 10,  enabled: true, integer: true, why: 'Concurrent broker positions. Existing behaviour.' },
  maxExposurePct:        { value: 20,    min: 5,   max: 500, enabled: true,  why: 'Total notional as % of balance (100 = 1x leverage). Default 20 is the original setting.' },
  minRewardRisk:         { value: 3,     min: 3,   max: 10,  enabled: true,  why: 'Take-profit distance / stop distance. Cannot go below 1:3.' },
  stopAtrMultiple:       { value: 1.5,   min: 0.5, max: 5,   enabled: true,  why: 'Stop distance in ATR multiples. Existing behaviour.' },
  orderCooldownMinutes:  { value: 10,    min: 1,   max: 120, enabled: true,  why: 'Pause on a symbol after a failed order. Existing behaviour.' },
  maxQuoteAgeSeconds:    { value: 15,    min: 1,   max: 60,  enabled: true,  why: 'Oldest quote an entry may use. Existing behaviour.' },
  maxTotalOpenRiskPct:   { value: 3,     min: 0.5, max: 10,  enabled: false, why: 'Sum of loss-at-stop across open positions as % of balance. Proposed.' },
  maxDrawdownPct:        { value: 10,    min: 1,   max: 50,  enabled: false, why: 'Stop new entries when equity is this far below its 30-day peak. Proposed.' },
  maxSpreadPct:          { value: 0.05,  min: 0.001, max: 0.5, enabled: false, why: 'Refuse entries when bid-ask spread exceeds this % of price. Proposed.' },
  maxConsecutiveLosses:  { value: 5,     min: 2,   max: 20,  enabled: false, integer: true, why: 'Stop new entries after this many losing trades in a row. Proposed.' },
  maxPositionsPerInstrument: { value: 1, min: 1,   max: 3,   enabled: false, integer: true, why: 'Concurrent positions on one symbol. Proposed.' }
};

const SESSION_FIELD = 'blockedSessionsUtc'; // [{ from: 'HH:MM', to: 'HH:MM' }], disabled until approved
const DEFAULT_SESSIONS = { value: [], enabled: false, why: 'UTC windows with no new entries (e.g. rollover). Proposed.' };

let state = null; // { values: {k: n}, enabled: {k: bool}, sessions: {value, enabled}, proposals: [], history: [] }

function defaults() {
  const values = {}, enabled = {};
  for (const [k, s] of Object.entries(SCHEMA)) { values[k] = s.value; enabled[k] = s.enabled; }
  return { values, enabled, sessions: { value: DEFAULT_SESSIONS.value, enabled: DEFAULT_SESSIONS.enabled }, proposals: [], history: [] };
}

// Validates one limit value against its bounds. Returns an error string or null.
function checkValue(key, v) {
  if (key === SESSION_FIELD) return validateSessions(v);
  const s = SCHEMA[key];
  if (!s) return `Unknown limit ${key}`;
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${key} must be a number`;
  if (s.integer && !Number.isInteger(v)) return `${key} must be a whole number`;
  if (v < s.min || v > s.max) return `${key} must be between ${s.min} and ${s.max}`;
  return null;
}

function validateSessions(list) {
  if (!Array.isArray(list)) return 'blockedSessionsUtc must be a list';
  if (list.length > 10) return 'at most 10 session windows';
  for (const w of list) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.from || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.to || '')) return 'session times must be HH:MM (UTC)';
  }
  return null;
}

async function readJson(file, fallback) {
  try { return await fs.readJson(file); } catch { return fallback; }
}

async function init() {
  const saved = await readJson(CONFIG_FILE, null);
  state = saved ? { ...defaults(), ...saved } : defaults();
  for (const [k, v] of Object.entries(state.values)) {
    if (checkValue(k, v)) throw new Error(`Saved risk config is invalid: ${k}=${v}`);
  }
  await save();
  return state;
}

async function save() {
  await fs.ensureDir(path.dirname(CONFIG_FILE));
  await fs.writeJson(CONFIG_FILE, state, { spaces: 2 });
}

// The values the engine and the order boundary use. Disabled proposals are not in effect.
// Before init() the built-in defaults apply, so the limits are never silently missing.
function current() {
  return state || defaults();
}

function active() {
  const s = current();
  const out = {};
  for (const k of Object.keys(SCHEMA)) out[k] = s.enabled[k] ? s.values[k] : null;
  out.blockedSessionsUtc = s.sessions.enabled ? s.sessions.value : [];
  return out;
}

// The stored value of a limit, whether or not it is enabled.
function value(key) { return current().values[key]; }

function describe() {
  return {
    limits: Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, {
      value: state.values[k], enabled: state.enabled[k], min: s.min, max: s.max, why: s.why
    }])),
    blockedSessionsUtc: { value: state.sessions.value, enabled: state.sessions.enabled },
    proposals: state.proposals,
    history: state.history.slice(-50)
  };
}

// Owner proposes a change. It is validated now and only takes effect when approved.
async function propose({ key, value: v, enabled = true, rationale = '' }) {
  const err = checkValue(key, v);
  if (err) throw new Error(err);
  if (!rationale || rationale.length < 10) throw new Error('A rationale of at least 10 characters is required');
  const p = {
    id: `P-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    key, value: v, enabled: !!enabled, rationale, status: 'PENDING', proposedAt: new Date().toISOString()
  };
  state.proposals.push(p);
  await save();
  return p;
}

// Applies an approved proposal. The change is recorded with its previous value.
async function approve(id, { source = 'owner approval' } = {}) {
  const p = state.proposals.find(x => x.id === id);
  if (!p) throw new Error('Unknown proposal');
  if (p.status !== 'PENDING') throw new Error(`Proposal is ${p.status}`);
  const from = p.key === SESSION_FIELD ? state.sessions.value : state.values[p.key];
  if (p.key === SESSION_FIELD) {
    state.sessions = { value: p.value, enabled: p.enabled };
  } else {
    state.values[p.key] = p.value;
    state.enabled[p.key] = p.enabled;
  }
  p.status = 'APPROVED';
  p.decidedAt = new Date().toISOString();
  state.history.push({ at: p.decidedAt, key: p.key, from, to: p.value, enabled: p.enabled, source, proposalId: p.id });
  await save();
  return p;
}

async function reject(id) {
  const p = state.proposals.find(x => x.id === id);
  if (!p) throw new Error('Unknown proposal');
  if (p.status !== 'PENDING') throw new Error(`Proposal is ${p.status}`);
  p.status = 'REJECTED';
  p.decidedAt = new Date().toISOString();
  await save();
  return p;
}

// ---- emergency stop ----

async function emergencyState() {
  return readJson(EMERGENCY_FILE, { on: false });
}

// Turning the emergency stop on blocks every new entry. Exits and reconciliation keep running.
async function setEmergencyStop(on, reason = '') {
  const s = { on: !!on, reason, changedAt: new Date().toISOString() };
  await fs.ensureDir(path.dirname(EMERGENCY_FILE));
  await fs.writeJson(EMERGENCY_FILE, s, { spaces: 2 });
  return s;
}

// ---- equity history (for drawdown) ----

async function recordEquity(balance, nowMs = Date.now()) {
  const h = await readJson(EQUITY_FILE, []);
  const last = h[h.length - 1];
  if (last && nowMs - last.t < EQUITY_MIN_INTERVAL_MS) return;
  h.push({ t: nowMs, balance });
  if (h.length > EQUITY_MAX_POINTS) h.splice(0, h.length - EQUITY_MAX_POINTS);
  await fs.ensureDir(path.dirname(EQUITY_FILE));
  await fs.writeJson(EQUITY_FILE, h);
}

// Pure: drawdown % of the latest balance below the highest balance in the window.
function drawdownPct(history, nowMs = Date.now()) {
  const pts = history.filter(p => nowMs - p.t <= DRAWDOWN_WINDOW_MS);
  if (!pts.length) return 0;
  const peak = Math.max(...pts.map(p => p.balance));
  const cur = pts[pts.length - 1].balance;
  if (peak <= 0) return 0;
  return Math.max(0, (peak - cur) / peak * 100);
}

// Pure: is the current UTC time inside any blocked window (windows may cross midnight).
function inBlockedSession(windows, nowMs) {
  const d = new Date(nowMs);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return windows.some(w => {
    const [fh, fm] = w.from.split(':').map(Number);
    const [th, tm] = w.to.split(':').map(Number);
    const from = fh * 60 + fm, to = th * 60 + tm;
    return from <= to ? (m >= from && m < to) : (m >= from || m < to);
  });
}

async function currentDrawdown(nowMs = Date.now()) {
  return drawdownPct(await readJson(EQUITY_FILE, []), nowMs);
}

module.exports = {
  init, active, value, describe, propose, approve, reject, checkValue, SCHEMA, SESSION_FIELD,
  emergencyState, setEmergencyStop, recordEquity, drawdownPct, currentDrawdown, inBlockedSession, EQUITY_FILE
};
