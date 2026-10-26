// Mark-to-market loss caps (decision 2). Equity = broker balance + unrealised P&L of open positions.
// Caps: daily MTM loss, weekly MTM loss, and drawdown from peak equity. Demo defaults: 2%, 5%, 10%.
// When a cap is hit: new entries are blocked, the owner is alerted, and open positions stay managed (never force-closed).
// Resuming needs owner action plus a successful broker reconciliation. Live values need a separate approval.
// Unknown equity blocks new entries for that cycle but does not latch a cap: the broker being unreachable is not a loss.
const storage = require('../data/storage');
const audit = require('../audit/audit');
const entryPause = require('../engine/entryPause');

const CONFIG = 'mtm_caps_config';
const STATE = 'mtm_caps_state';
const DEFAULTS = { dailyLossPct: 2, weeklyLossPct: 5, maxDrawdownPct: 10 };
const LIMIT_MIN = 0.1;
const LIMIT_MAX = 50;

// Pure. Returns the validated caps or throws with the field named.
function validateCaps(c) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = c && c[k] !== undefined ? c[k] : DEFAULTS[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < LIMIT_MIN || v > LIMIT_MAX) {
      throw new Error(`${k} must be a number from ${LIMIT_MIN} to ${LIMIT_MAX} (percent)`);
    }
    out[k] = v;
  }
  return out;
}

async function getCaps() {
  const rows = await storage.load(CONFIG);
  return validateCaps(rows[0] || DEFAULTS);
}

async function setCaps(c, actor = 'owner') {
  const next = validateCaps(c);
  const before = await getCaps();
  await storage.save(CONFIG, [next]);
  audit.record('MTM_CAPS_CHANGED', { actor, before, after: next });
  return next;
}

// Day and week keys in UTC. A week starts on Monday, matching the owner reports.
function dayKey(d) { return d.toISOString().slice(0, 10); }
function weekKey(d) {
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return dayKey(monday);
}

async function getState() {
  const rows = await storage.load(STATE);
  return rows[0] || null;
}

// Pure. The breaches for one equity reading against the caps and the baselines.
function breaches({ equity, state, caps }) {
  if (!Number.isFinite(equity)) return [{ code: 'EQUITY_UNKNOWN', message: 'account equity unknown; new entries blocked this cycle' }];
  const out = [];
  if (state.dayStartEquity > 0) {
    const lossPct = (state.dayStartEquity - equity) / state.dayStartEquity * 100;
    if (lossPct >= caps.dailyLossPct) out.push({ code: 'DAILY_MTM_LOSS', message: `daily mark-to-market loss ${lossPct.toFixed(2)}% reached the ${caps.dailyLossPct}% cap` });
  }
  if (state.weekStartEquity > 0) {
    const lossPct = (state.weekStartEquity - equity) / state.weekStartEquity * 100;
    if (lossPct >= caps.weeklyLossPct) out.push({ code: 'WEEKLY_MTM_LOSS', message: `weekly mark-to-market loss ${lossPct.toFixed(2)}% reached the ${caps.weeklyLossPct}% cap` });
  }
  if (state.peakEquity > 0) {
    const ddPct = (state.peakEquity - equity) / state.peakEquity * 100;
    if (ddPct >= caps.maxDrawdownPct) out.push({ code: 'MAX_DRAWDOWN', message: `drawdown ${ddPct.toFixed(2)}% from peak reached the ${caps.maxDrawdownPct}% cap` });
  }
  return out;
}

// Called once per engine cycle with the current equity (or null when unknown).
// Returns { block, reason, latched, breaches }. A real breach latches until the owner resumes.
async function checkCycle(equity, now = new Date()) {
  const caps = await getCaps();
  const latched = await getLatch();
  if (latched) return { block: true, reason: latched.reason, latched: true, breaches: latched.breaches || [] };

  let state = await getState();
  if (Number.isFinite(equity)) {
    const day = dayKey(now), week = weekKey(now);
    if (!state) state = { day, dayStartEquity: equity, week, weekStartEquity: equity, peakEquity: equity };
    if (state.day !== day) state = { ...state, day, dayStartEquity: equity };
    if (state.week !== week) state = { ...state, week, weekStartEquity: equity };
    state = { ...state, peakEquity: Math.max(state.peakEquity, equity), lastEquity: equity, lastAt: now.toISOString() };
    await storage.save(STATE, [state]);
  }
  const found = breaches({ equity, state: state || { dayStartEquity: 0, weekStartEquity: 0, peakEquity: 0 }, caps });
  const real = found.filter(b => b.code !== 'EQUITY_UNKNOWN');
  if (real.length) {
    const reason = real.map(b => b.message).join('; ');
    await storage.save('mtm_caps_latch', [{ reason, breaches: real, at: now.toISOString() }]);
    await entryPause.pauseEntries(`risk cap hit: ${reason}`);
    audit.record('MTM_CAP_HIT', { breaches: real.map(b => b.code), equity, reason });
    return { block: true, reason, latched: true, breaches: real };
  }
  if (found.length) return { block: true, reason: found[0].message, latched: false, breaches: found };
  return { block: false, reason: null, latched: false, breaches: [] };
}

async function getLatch() {
  const rows = await storage.load('mtm_caps_latch');
  return rows[0] || null;
}

async function status() {
  const latch = await getLatch();
  return { tripped: !!latch, reason: latch ? latch.reason : null, at: latch ? latch.at : null, caps: await getCaps(), state: await getState() };
}

// Owner action. Refused unless the last broker reconciliation succeeded.
async function resume({ actor = 'owner', reconcileOk } = {}) {
  const latch = await getLatch();
  if (!latch) return { resumed: false, reason: 'no risk cap is latched' };
  if (reconcileOk !== true) return { resumed: false, reason: 'a successful broker reconciliation is required before resuming' };
  await storage.save('mtm_caps_latch', []);
  await entryPause.resume({ reconcileOk: true, actor });
  audit.record('MTM_CAP_RESUMED', { actor, cleared: latch.reason });
  return { resumed: true };
}

// Equity now: broker balance plus unrealised P&L of open positions (deposit currency). Null when the broker is not
// authenticated or the unrealised figures cannot be read. Unknown equity is never treated as zero.
async function equitySnapshot() {
  const cm = require('../ctrader/connectionManager');
  const auth = require('../ctrader/auth');
  const b = cm.getBalance();
  if (!b || !Number.isFinite(b.amount) || cm.getStatus().state !== 'ACCOUNT_AUTHENTICATED') return null;
  try {
    const r = await cm.getClient().unrealizedPnl(Number(auth.getConfig().accountId));
    const sum = (r.positionUnrealizedPnL || []).reduce((s, p) => s + Number(p.netUnrealizedPnL || 0), 0);
    return b.amount + sum / Math.pow(10, Number(r.moneyDigits || 0));
  } catch (e) {
    return null;
  }
}

module.exports = { validateCaps, getCaps, setCaps, breaches, checkCycle, status, resume, equitySnapshot, dayKey, weekKey, DEFAULTS, LIMIT_MIN, LIMIT_MAX };
