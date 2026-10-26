// Safety rules that stop new trades: loss caps per period and the recovery fence after an unclean shutdown.
const fs = require('fs-extra');
const path = require('path');
const storage = require('../data/storage');
const prefs = require('./prefs');
const connectionManager = require('../ctrader/connectionManager');
const limits = require('../risk/limits');

const STATE_FILE = process.env.AIS_RUN_STATE_FILE || path.join(__dirname, '../../data/run_state.json'); // env override is for tests
const LIMITS_FILE = path.join(__dirname, '../../data/guardrails.json');
const DEFAULT_LIMITS = { dailyLossPct: 3, weeklyLossPct: 6, monthlyLossPct: 10 };

let state = { cleanShutdown: true, fenceActive: false };

async function readJson(file, fallback) {
  try { return await fs.readJson(file); } catch { return fallback; }
}

async function saveState() {
  await fs.ensureDir(path.dirname(STATE_FILE));
  await fs.writeJson(STATE_FILE, state, { spaces: 2 });
}

// Called at startup. A previous run that never reached markCleanShutdown holds trading until acknowledged.
async function init() {
  const prev = await readJson(STATE_FILE, null);
  const fenceActive = !!prev && (prev.cleanShutdown === false || prev.fenceActive === true);
  state = { cleanShutdown: false, fenceActive, startedAt: new Date().toISOString() };
  await saveState();
  if (fenceActive) console.log('[GUARD] Previous run did not shut down cleanly — trading held until acknowledged in the dashboard');
  return { fenceActive };
}

// Synchronous so it can run inside a process exit handler.
function markCleanShutdown() {
  state = { ...state, cleanShutdown: true, stoppedAt: new Date().toISOString() };
  fs.ensureDirSync(path.dirname(STATE_FILE));
  fs.writeJsonSync(STATE_FILE, state, { spaces: 2 });
}

async function acknowledgeFence() {
  state = { ...state, fenceActive: false, acknowledgedAt: new Date().toISOString() };
  await saveState();
  return { fenceActive: false };
}

function fenceStatus() {
  return { fenceActive: state.fenceActive };
}

async function getLimits() {
  return { ...DEFAULT_LIMITS, ...(await readJson(LIMITS_FILE, {})) };
}

async function setLimits(updates) {
  const next = { ...(await getLimits()) };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (updates[key] === undefined) continue;
    const v = Number(updates[key]);
    if (!Number.isFinite(v) || v <= 0 || v > 50) throw new Error(`${key} must be between 0 and 50`);
    next[key] = v;
  }
  await fs.ensureDir(path.dirname(LIMITS_FILE));
  await fs.writeJson(LIMITS_FILE, next, { spaces: 2 });
  return next;
}

// Start of the period containing `now`, in UTC.
function periodStart(period, now) {
  const d = new Date(now);
  if (period === 'daily') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (period === 'weekly') {
    const daysSinceMonday = (d.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday));
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// Pure check, so it can be tested. trades: closed-trade records; balance: current account balance.
function lossCapBreach(trades, balance, limits, now = new Date()) {
  if (balance === null || balance === undefined) return { breached: true, reason: 'Account balance unknown — trading held' };
  const live = trades.filter(t => t.source === 'ctrader' && t.status === 'CLOSED' && t.closeTime && Number.isFinite(Number(t.pnl)));
  for (const [period, pct] of [['daily', limits.dailyLossPct], ['weekly', limits.weeklyLossPct], ['monthly', limits.monthlyLossPct]]) {
    const start = periodStart(period, now);
    const realised = live
      .filter(t => new Date(t.closeTime) >= start)
      .reduce((s, t) => s + Number(t.pnl), 0);
    if (realised >= 0) continue;
    const startBalance = balance - realised; // balance at the start of the period
    const loss = -realised;
    if (loss >= startBalance * pct / 100) {
      return { breached: true, reason: `${period} loss limit reached: ${loss.toFixed(2)} lost, limit ${pct}% of ${startBalance.toFixed(2)}` };
    }
  }
  return { breached: false };
}

// Single entry point used by the engine before every cycle.
async function allowTrade(environment = 'demo') {
  const p = await prefs.get();
  if (!p.tradingEnabled) return { allow: false, reason: 'Trading disabled by owner' };
  if (environment === 'live' && !p.liveMode) return { allow: false, reason: 'Live trading not approved' };
  if (state.fenceActive) return { allow: false, reason: 'Recovery review required after an unclean shutdown — acknowledge in the dashboard' };
  const emergency = await limits.emergencyState();
  if (emergency.on) return { allow: false, reason: `Emergency stop is on${emergency.reason ? ': ' + emergency.reason : ''}` };
  const trades = await storage.load('trades');
  const balance = connectionManager.getBalance();
  const check = lossCapBreach(trades, balance ? balance.amount : null, await getLimits());
  if (check.breached) return { allow: false, reason: check.reason };
  return { allow: true };
}

module.exports = { init, markCleanShutdown, acknowledgeFence, fenceStatus, getLimits, setLimits, allowTrade, lossCapBreach, periodStart, DEFAULT_LIMITS };
