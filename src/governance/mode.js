// Operating modes (decision 7). A mode decides whether AIS may place broker orders. Decisions are recorded in every mode.
//   OBSERVATION      no broker orders
//   RESEARCH         no broker orders (analysis and backtests)
//   PAPER            NEVER a broker order. Entries are simulated fills stored as SIMULATED_PAPER evidence.
//   DEMO_SUPERVISED  demo broker orders only, and only inside an owner-enabled session that expires.
//                    All risk limits apply. Expiry reverts the mode to OBSERVATION.
//   DEMO_AUTONOMOUS  demo broker orders within the risk limits (the default; unchanged behaviour)
//   LIVE             locked; needs a separate readiness review and explicit authorisation
// A mode change never grants more than the mode says. Order-placing modes need the exact confirmation phrase.
const fs = require('fs-extra');
const path = require('path');
const audit = require('../audit/audit');

const MODE_FILE = process.env.AIS_MODE_FILE || path.join(__dirname, '../../data/operating_mode.json'); // env override is for tests
const DEFAULT_MODE = 'DEMO_AUTONOMOUS'; // the behaviour AIS already had; changing it is an owner action
const SUPERVISED_MAX_HOURS = 8;
const SUPERVISED_MIN_HOURS = 0.1;

const MODES = {
  OBSERVATION:     { orders: false, available: true,  why: 'Decisions are recorded and monitored; no broker orders are placed.' },
  RESEARCH:        { orders: false, available: true,  why: 'Analysis and backtests only; no broker orders are placed.' },
  PAPER:           { orders: false, available: true,  why: 'Simulated fills only. No broker order is ever sent in this mode.' },
  DEMO_SUPERVISED: { orders: 'session', available: true, why: 'Demo broker orders inside an owner-enabled session that expires.' },
  DEMO_AUTONOMOUS: { orders: true,  available: true,  why: 'Broker demo orders are placed autonomously within the risk limits.' },
  LIVE:            { orders: false, available: false, why: 'Locked. Requires a separate readiness review and explicit authorisation; not part of this build.' }
};

let state = null; // { mode, history: [{ at, from, to, source }], session: { enabledAt, expiresAt, actor } | null }

async function init() {
  state = await fs.readJson(MODE_FILE).catch(() => null);
  if (!state || !MODES[state.mode]) {
    state = { mode: DEFAULT_MODE, history: [], session: null };
    await save();
  }
  if (state.session === undefined) state.session = null;
  return state.mode;
}

async function save() {
  await fs.ensureDir(path.dirname(MODE_FILE));
  await fs.writeJson(MODE_FILE, state, { spaces: 2 });
}

function current() {
  return state ? state.mode : DEFAULT_MODE;
}

function sessionActive(now = Date.now()) {
  return !!(state && state.session && Date.parse(state.session.expiresAt) > now);
}

// True only when broker orders may be sent right now. A supervised session that has expired gives false.
function allowsBrokerOrders(now = Date.now()) {
  const m = current();
  if (m === 'DEMO_SUPERVISED') return sessionActive(now);
  return MODES[m].orders === true;
}

// Persists the reversion when an owner's supervised session has run out. Called every engine cycle.
async function expireIfDue(now = Date.now()) {
  if (current() !== 'DEMO_SUPERVISED' || sessionActive(now)) return false;
  const from = current();
  const expired = state.session;
  state = { mode: 'OBSERVATION', history: [...state.history, { at: new Date(now).toISOString(), from, to: 'OBSERVATION', source: 'session expired' }], session: null };
  await save();
  audit.record('SUPERVISED_SESSION_EXPIRED', { expiredAt: expired && expired.expiresAt, actor: expired && expired.actor });
  audit.record('MODE_CHANGED', { from, to: 'OBSERVATION', source: 'session expired' });
  return true;
}

function describe() {
  return {
    mode: current(),
    allowsBrokerOrders: allowsBrokerOrders(),
    session: state && state.session ? { ...state.session, active: sessionActive() } : null,
    modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, { ...v }])),
    history: (state ? state.history : []).slice(-20)
  };
}

// Selects a mode. Order-placing modes need the exact confirmation phrase, so a selection is never accidental.
// DEMO_SUPERVISED is not selected here: it needs its own session (enableSupervised).
async function setMode(target, { confirm = '', source = 'owner' } = {}) {
  if (!MODES[target]) throw new Error(`Unknown mode ${target}`);
  if (!MODES[target].available) throw new Error(`${target} is not available: ${MODES[target].why}`);
  if (target === 'DEMO_SUPERVISED') throw new Error('DEMO_SUPERVISED needs an owner-enabled session with an expiry: use enableSupervised');
  if (MODES[target].orders === true && confirm !== `CONFIRM ${target}`) {
    throw new Error(`Selecting ${target} places broker orders. Send confirm: "CONFIRM ${target}"`);
  }
  const from = current();
  state = { mode: target, history: [...(state ? state.history : []), { at: new Date().toISOString(), from, to: target, source }], session: null };
  await save();
  audit.record('MODE_CHANGED', { from, to: target, source });
  return describe();
}

// Owner enables DEMO_SUPERVISED for a fixed number of hours. Needs the exact phrase and a valid duration.
async function enableSupervised({ hours, confirm = '', actor = 'owner', now = Date.now() } = {}) {
  if (confirm !== 'CONFIRM DEMO_SUPERVISED') throw new Error('Send confirm: "CONFIRM DEMO_SUPERVISED" to enable a supervised session');
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < SUPERVISED_MIN_HOURS || hours > SUPERVISED_MAX_HOURS) {
    throw new Error(`hours must be a number from ${SUPERVISED_MIN_HOURS} to ${SUPERVISED_MAX_HOURS}`);
  }
  const from = current();
  const session = { enabledAt: new Date(now).toISOString(), expiresAt: new Date(now + hours * 3600000).toISOString(), actor };
  state = { mode: 'DEMO_SUPERVISED', history: [...(state ? state.history : []), { at: new Date(now).toISOString(), from, to: 'DEMO_SUPERVISED', source: actor }], session };
  await save();
  audit.record('MODE_CHANGED', { from, to: 'DEMO_SUPERVISED', source: actor });
  audit.record('SUPERVISED_SESSION_ENABLED', { actor, expiresAt: session.expiresAt, hours });
  return describe();
}

module.exports = { init, current, allowsBrokerOrders, expireIfDue, describe, setMode, enableSupervised, sessionActive, MODES, DEFAULT_MODE, SUPERVISED_MAX_HOURS, SUPERVISED_MIN_HOURS };
