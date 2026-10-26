// Operating modes. A mode decides whether AIS may place broker orders. Decisions are recorded in every mode.
// A mode change never grants more than the mode says: order-placing modes need the owner's confirmation phrase.
// Modes that are not built are listed as unavailable and cannot be selected. LIVE is locked in this build.
const fs = require('fs-extra');
const path = require('path');
const audit = require('../audit/audit');

const MODE_FILE = path.join(__dirname, '../../data/operating_mode.json');
const DEFAULT_MODE = 'DEMO_AUTONOMOUS'; // the behaviour AIS already had; changing it is an owner action

const MODES = {
  OBSERVATION:     { orders: false, available: true,  why: 'Decisions are recorded and monitored; no broker orders are placed.' },
  RESEARCH:        { orders: false, available: true,  why: 'Analysis and backtests only; no broker orders are placed.' },
  PAPER:           { orders: false, available: false, why: 'Not built: simulated fills are not implemented.' },
  DEMO_SUPERVISED: { orders: false, available: false, why: 'Not built: per-trade owner confirmation is not implemented.' },
  DEMO_AUTONOMOUS: { orders: true,  available: true,  why: 'Broker demo orders are placed autonomously within the risk limits.' },
  LIVE:            { orders: false, available: false, why: 'Locked. Requires a separate readiness review and explicit authorisation; not part of this build.' }
};

let state = null; // { mode, history: [{ at, from, to, source }] }

async function init() {
  state = await fs.readJson(MODE_FILE).catch(() => null);
  if (!state || !MODES[state.mode]) {
    state = { mode: DEFAULT_MODE, history: [] };
    await save();
  }
  return state.mode;
}

async function save() {
  await fs.ensureDir(path.dirname(MODE_FILE));
  await fs.writeJson(MODE_FILE, state, { spaces: 2 });
}

function current() {
  return state ? state.mode : DEFAULT_MODE;
}

function allowsBrokerOrders() {
  return MODES[current()].orders;
}

function describe() {
  return {
    mode: current(),
    allowsBrokerOrders: allowsBrokerOrders(),
    modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, { ...v }])),
    history: (state ? state.history : []).slice(-20)
  };
}

// Selects a mode. Order-placing modes need the exact confirmation phrase, so a selection is never accidental.
async function setMode(target, { confirm = '', source = 'owner' } = {}) {
  if (!MODES[target]) throw new Error(`Unknown mode ${target}`);
  if (!MODES[target].available) throw new Error(`${target} is not available: ${MODES[target].why}`);
  if (MODES[target].orders && confirm !== `CONFIRM ${target}`) {
    throw new Error(`Selecting ${target} places broker orders. Send confirm: "CONFIRM ${target}"`);
  }
  const from = current();
  state = { mode: target, history: [...(state ? state.history : []), { at: new Date().toISOString(), from, to: target, source }] };
  await save();
  audit.record('MODE_CHANGED', { from, to: target, source });
  return describe();
}

module.exports = { init, current, allowsBrokerOrders, describe, setMode, MODES, DEFAULT_MODE };
