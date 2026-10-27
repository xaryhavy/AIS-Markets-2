// Data integrity for candles. Pure validation plus an assessment of each symbol before any analysis.
// Rules:
//  - a candle must have finite, positive prices with high >= low, high >= open/close, low <= open/close
//  - the time must be an integer multiple of its timeframe period
//  - duplicates (same time) keep the first; out-of-order bars are sorted
//  - a candle is COMPLETED only once its period has fully ended; forming candles are never used for analysis
//  - future-dated candles are excluded
//  - the analysis is bound to a fingerprint of the exact candles it used
//  - FAIL CLOSED (decision 3): a missing completed candle inside the lookback window blocks new entries for that
//    instrument and timeframe, unless the candle was missing because the market was scheduled to be closed.
//    Tolerance defaults to zero and is configurable. Every block episode is logged with its reason code.
const crypto = require('crypto');
const marketData = require('./marketdata');
const sessions = require('./sessions');
const storage = require('./storage');
const audit = require('../audit/audit');

const PERIOD_MS = { M1: 60000, M5: 300000, M15: 900000, H1: 3600000 };
// Newest completed candle must be no older than this (about 2 periods plus slack).
const STALE_MS = { M1: 3 * 60000, M5: 12 * 60000, M15: 35 * 60000, H1: 130 * 60000 };
// Analysis lookback per timeframe, in candles. Gaps inside these windows are checked.
const LOOKBACK = { M1: 30, M5: 12, M15: 8, H1: 4 };
const FINGERPRINT_BARS = 20;
const ANALYSIS_TTL_MS = 30000;
const FRAMES = ['M1', 'M5', 'M15', 'H1'];
const GATE_CONFIG = 'data_gate_config';
const GATE_BLOCKS = 'data_gate_blocks';
const TOLERANCE_MAX = 20;

let gapTolerance = 0;             // unexplained missing candles allowed per window; default zero
const episodes = {};              // symbol -> open block episode (in memory until it closes)

// Validates and returns the tolerance, or throws.
function validTolerance(n) {
  if (!Number.isInteger(n) || n < 0 || n > TOLERANCE_MAX) throw new Error(`gap tolerance must be a whole number from 0 to ${TOLERANCE_MAX}`);
  return n;
}

async function initGate() {
  const rows = await storage.load(GATE_CONFIG);
  if (rows[0] && rows[0].gapTolerance !== undefined) gapTolerance = validTolerance(rows[0].gapTolerance);
  return { gapTolerance };
}

async function setGapTolerance(n, actor = 'owner') {
  const before = gapTolerance;
  gapTolerance = validTolerance(n);
  await storage.save(GATE_CONFIG, [{ gapTolerance, changedAt: new Date().toISOString() }]);
  audit.record('DATA_GATE_TOLERANCE_CHANGED', { actor, before, after: gapTolerance });
  return { gapTolerance };
}

function getGapTolerance() { return gapTolerance; }

function isValid(b, period) {
  const nums = [b.time, b.open, b.high, b.low, b.close];
  if (!nums.every(v => typeof v === 'number' && Number.isFinite(v))) return false;
  if (!Number.isInteger(b.time) || b.time % period !== 0) return false;
  if (b.open <= 0 || b.high <= 0 || b.low <= 0 || b.close <= 0) return false;
  if (b.high < b.low) return false;
  if (b.high < Math.max(b.open, b.close)) return false;
  if (b.low > Math.min(b.open, b.close)) return false;
  return true;
}

function fingerprint(tf, bars) {
  const tail = bars.slice(-FINGERPRINT_BARS).map(b => [b.time, b.open, b.high, b.low, b.close]);
  return `${tf}:${bars.length}:${crypto.createHash('sha256').update(JSON.stringify(tail)).digest('hex').slice(0, 16)}`;
}

// Pure. Returns the usable completed candles plus counts of everything that was excluded.
// `symbol` is needed to tell scheduled closures from missing candles; without it every missing candle counts.
function validateBars(raw, tf, nowMs = Date.now(), symbol = null) {
  const period = PERIOD_MS[tf];
  const issues = { invalid: 0, duplicates: 0, future: 0, incomplete: 0, gaps: 0, missingBars: 0, unexplainedMissing: 0 };
  const byTime = new Map();
  for (const b of raw) {
    if (!isValid(b, period)) { issues.invalid++; continue; }
    if (byTime.has(b.time)) { issues.duplicates++; continue; }
    byTime.set(b.time, b);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  const completed = [];
  for (const b of sorted) {
    if (b.time > nowMs) issues.future++;
    else if (b.time + period > nowMs) issues.incomplete++;
    else completed.push(b);
  }
  for (let i = 1; i < completed.length; i++) {
    const step = completed[i].time - completed[i - 1].time;
    if (step > period) {
      issues.gaps++;
      issues.missingBars += Math.round(step / period) - 1;
      issues.unexplainedMissing += symbol
        ? sessions.unexplainedMissing(symbol, completed[i - 1].time, completed[i].time, period)
        : Math.round(step / period) - 1;
    }
  }
  return {
    bars: completed,
    issues,
    lastCompleted: completed[completed.length - 1] || null,
    fingerprint: fingerprint(tf, completed)
  };
}

// Completed candles of a symbol for one timeframe, validated. The most recent `limit` are returned.
function completedBars(symbol, tf, limit, nowMs = Date.now()) {
  const v = validateBars(marketData.getHistory(symbol, 5000, tf), tf, nowMs, symbol);
  return v.bars.slice(-limit);
}

// Unexplained missing candles inside the last LOOKBACK[tf] completed candles.
function windowGaps(bars, tf, symbol) {
  const window = bars.slice(-LOOKBACK[tf]);
  let n = 0;
  for (let i = 1; i < window.length; i++) {
    const step = window[i].time - window[i - 1].time;
    if (step > PERIOD_MS[tf]) n += sessions.unexplainedMissing(symbol, window[i - 1].time, window[i].time, PERIOD_MS[tf]);
  }
  return n;
}

// Whole-symbol assessment. ok=false means: do not analyse or trade this symbol now.
// reasonCodes are stable codes; reasons are the readable text.
function assess(symbol, nowMs = Date.now()) {
  const reasons = [];
  const reasonCodes = [];
  const frames = {};
  const add = (code, text) => { reasonCodes.push(code); reasons.push(text); };
  for (const tf of FRAMES) {
    const v = validateBars(marketData.getHistory(symbol, 5000, tf), tf, nowMs, symbol);
    frames[tf] = {
      completed: v.bars.length,
      lastCompletedTime: v.lastCompleted ? v.lastCompleted.time : null,
      fingerprint: v.fingerprint,
      issues: v.issues
    };
    if (!v.lastCompleted) {
      add('DATA_NO_BARS', `${tf}: no completed candles`);
      continue;
    }
    const age = nowMs - (v.lastCompleted.time + PERIOD_MS[tf]);
    // Staleness always blocks: the calendar excuses missing candles, never old data.
    if (age > STALE_MS[tf]) add('DATA_STALE', `${tf}: newest completed candle is ${Math.round(age / 60000)} min old`);
    const gaps = windowGaps(v.bars, tf, symbol);
    if (gaps > gapTolerance) add('DATA_GAP', `${tf}: ${gaps} gap(s) in the last ${LOOKBACK[tf]} candles (tolerance ${gapTolerance})`);
    if (v.issues.invalid) add('DATA_INVALID', `${tf}: ${v.issues.invalid} invalid candle(s) excluded`);
  }
  return { symbol, ok: reasonCodes.length === 0, reasons, reasonCodes, frames, assessedAt: nowMs };
}

// Logs each block episode once: a new record when a symbol becomes blocked, and a close with the number of
// cycles it stayed blocked when it clears. Reason codes are stored with the episode.
async function recordEpisode(assessment, nowMs = Date.now()) {
  const sym = assessment.symbol;
  const open = episodes[sym];
  if (!assessment.ok) {
    const codes = [...new Set(assessment.reasonCodes)].sort().join(',');
    if (open && open.codes === codes) { open.cycles++; return; }
    if (open) await closeEpisode(sym, nowMs);
    episodes[sym] = { id: `GATE-${sym}-${nowMs}`, symbol: sym, codes, reasons: assessment.reasons, startedAt: new Date(nowMs).toISOString(), cycles: 1 };
    await storage.append(GATE_BLOCKS, { ...episodes[sym], endedAt: null });
    return;
  }
  if (open) await closeEpisode(sym, nowMs);
}

async function closeEpisode(sym, nowMs) {
  const open = episodes[sym];
  if (!open) return;
  await storage.update(GATE_BLOCKS, open.id, { endedAt: new Date(nowMs).toISOString(), cycles: open.cycles });
  delete episodes[sym];
}

function isExpired(assessment, nowMs = Date.now()) {
  return nowMs - assessment.assessedAt > ANALYSIS_TTL_MS;
}

module.exports = {
  validateBars, completedBars, assess, isExpired, isValid, fingerprint, PERIOD_MS, STALE_MS, LOOKBACK, ANALYSIS_TTL_MS,
  initGate, setGapTolerance, getGapTolerance, validTolerance, recordEpisode, GATE_BLOCKS, TOLERANCE_MAX
};
