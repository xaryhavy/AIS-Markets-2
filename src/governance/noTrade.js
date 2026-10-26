// NO-TRADE outcome monitor. Hypothetical: nothing here is an execution, profit, loss or closed position.
// Every rejected or waiting signal that had levels is frozen at decision time (entry, stop, target, horizon),
// then resolved later from COMPLETED one-minute candles that began after the decision. Results are kept as
// separate outcome records linked by decisionId; decision records are never rewritten.
const storage = require('../data/storage');
const marketData = require('../data/marketdata');
const entryStates = require('./entryStates');

const HORIZON_MINUTES = 60;
const CANDLE_MS = 60000;
const MIN_DECISIVE_FOR_REVIEW = 30;

// Rejection reason -> stable code. Unknown text falls to OTHER so it is visible, not hidden.
const REASON_CODES = [
  [/^Data quality/, 'DATA_QUALITY'],
  [/^Higher timeframes/, 'MTF_CONFIRMATION'],
  [/^Entries paused/, 'ENTRY_BLOCKED'],
  [/^Cooling down/, 'COOLDOWN'],
  [/^Reward to risk/, 'RR_FLOOR'],
  [/^Model win probability/, 'ML_THRESHOLD'],
  [/^Zero position size/, 'SIZE_ZERO'],
  [/^Max \d+ positions|^Exposure limit|^Max exposure/, 'RISK_ADMISSION'],
  [/^Data changed/, 'STALE_ANALYSIS'],
  [/^Pre-trade check refused/, 'PRETRADE_BOUNDARY'],
  [/order not placed|cTrader|Order outcome|Adopted/, 'EXECUTION_REFUSED']
];

// Temporary conditions are WAIT (the setup may become valid); rule decisions are NO_TRADE.
const WAIT_CODES = new Set(['DATA_QUALITY', 'ENTRY_BLOCKED', 'COOLDOWN', 'STALE_ANALYSIS', 'NOT_QUALIFIED']);

function reasonCode(reason, qualified = true) {
  if (!reason) return qualified ? 'EXECUTED' : 'NOT_QUALIFIED';
  for (const [re, code] of REASON_CODES) if (re.test(reason)) return code;
  return 'OTHER';
}

function stateFor(decision, code) {
  if (decision === 'EXECUTED') return 'TRADE';
  return WAIT_CODES.has(code) ? 'WAIT' : 'NO_TRADE';
}

// Older records stored the whole {decision, reason} object in the decision field. Read them as they were
// written, flagged as legacy, without rewriting them.
function normalizeDecision(d) {
  if (d && typeof d.decision === 'object' && d.decision !== null) {
    return { ...d, decision: d.decision.decision, skipReason: d.decision.reason || d.skipReason || null, legacy: true };
  }
  return { ...d, legacy: false };
}

// Pure: resolves one frozen hypothetical against completed candles.
//   dec: { timestamp, levels: { action, entry, stopLoss, takeProfit }, horizonMinutes }
//   candles: completed M1 candles (any order); nowMs: evaluation time
// Returns { status, resolvedAt, exitPrice, candlesScanned, note }.
function resolveOutcome(dec, candles, nowMs) {
  if (dec.entryType === 'LEVEL') {
    if (!dec.levels || !Number.isFinite(dec.entryLevel)) return { status: 'NOT_EVALUABLE', note: 'level entry without a defined entry level' };
    return entryStates.resolveLevelOutcome(dec, candles, nowMs);
  }
  if (!dec.levels || ![dec.levels.entry, dec.levels.stopLoss, dec.levels.takeProfit].every(Number.isFinite)) {
    return { status: 'NOT_EVALUABLE', note: 'no frozen levels at decision time' };
  }
  const { action, stopLoss: sl, takeProfit: tp } = dec.levels;
  const decisionMs = Date.parse(dec.timestamp);
  const horizonEnd = decisionMs + (dec.horizonMinutes || HORIZON_MINUTES) * 60000;
  // First candle that began after the decision moment: never uses the candle the decision was made in.
  const firstMs = (Math.floor(decisionMs / CANDLE_MS) + 1) * CANDLE_MS;
  const list = candles.filter(c => c.time >= firstMs && c.time < horizonEnd && c.time + CANDLE_MS <= nowMs)
    .sort((a, b) => a.time - b.time);

  let prevEnd = firstMs;
  let scanned = 0;
  for (const c of list) {
    if (c.time > prevEnd) return { status: 'MISSING_DATA', candlesScanned: scanned, note: `missing candles from ${new Date(prevEnd).toISOString()}` };
    scanned++;
    const stopHit = action === 'BUY' ? c.low <= sl : c.high >= sl;
    const targetHit = action === 'BUY' ? c.high >= tp : c.low <= tp;
    if (stopHit && targetHit) {
      return { status: 'AMBIGUOUS', resolvedAt: new Date(c.time).toISOString(), candlesScanned: scanned, note: 'one candle touched both stop and target; order unknown, not counted' };
    }
    if (stopHit) return { status: 'STOP_HIT', resolvedAt: new Date(c.time + CANDLE_MS).toISOString(), exitPrice: sl, candlesScanned: scanned };
    if (targetHit) return { status: 'TARGET_HIT', resolvedAt: new Date(c.time + CANDLE_MS).toISOString(), exitPrice: tp, candlesScanned: scanned };
    prevEnd = c.time + CANDLE_MS;
  }
  if (nowMs >= horizonEnd) {
    if (prevEnd < horizonEnd) return { status: 'MISSING_DATA', candlesScanned: scanned, note: 'candles missing before the horizon ended' };
    return { status: 'EXPIRED', resolvedAt: new Date(horizonEnd).toISOString(), candlesScanned: scanned };
  }
  return { status: 'UNRESOLVED', candlesScanned: scanned };
}

// Wilson score interval for a proportion (95%). Honest about small samples.
function wilson(k, n, z = 1.96) {
  if (n === 0) return { rate: null, low: null, high: null };
  const p = k / n;
  const denom = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denom;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom;
  return { rate: Math.round(p * 1000) / 1000, low: Math.round((centre - half) * 1000) / 1000, high: Math.round((centre + half) * 1000) / 1000 };
}

// Analytics by group. Target-vs-stop is over decisive outcomes only (AMBIGUOUS/EXPIRED excluded).
// A group is flagged for owner review only when its interval is clearly on one side of 50%. Nothing changes automatically.
function summarise(outcomes, key) {
  const groups = {};
  for (const o of outcomes) {
    const g = (groups[o[key]] ||= { n: 0, TARGET_HIT: 0, STOP_HIT: 0, EXPIRED: 0, AMBIGUOUS: 0, MISSING_DATA: 0, NOT_EVALUABLE: 0, INVALIDATED: 0, EXPIRED_UNFILLED: 0, AMBIGUOUS_ENTRY: 0, AMBIGUOUS_OUTCOME: 0, PENDING_ENTRY: 0 });
    g.n++;
    if (g[o.status] !== undefined) g[o.status]++;
  }
  return Object.fromEntries(Object.entries(groups).map(([name, g]) => {
    const decisive = g.TARGET_HIT + g.STOP_HIT;
    const ci = wilson(g.TARGET_HIT, decisive);
    let flag = 'insufficient sample';
    if (decisive >= MIN_DECISIVE_FOR_REVIEW) {
      if (ci.low > 0.5) flag = 'review: rejected setups reached target more often than stop (possibly over-restrictive)';
      else if (ci.high < 0.5) flag = 'appropriately protective: rejected setups reached stop more often than target';
      else flag = 'no clear difference from 50%';
    }
    // INVALIDATED is reported as a count and rate, and is never part of win, loss or decisive counts.
    return [name, { ...g, decisive, targetRate: ci.rate, targetRateLow95: ci.low, targetRateHigh95: ci.high, invalidatedRate: g.n ? Math.round(g.INVALIDATED / g.n * 1000) / 1000 : null, expiredUnfilledRate: g.n ? Math.round(g.EXPIRED_UNFILLED / g.n * 1000) / 1000 : null, pendingEntryRate: g.n ? Math.round(g.PENDING_ENTRY / g.n * 1000) / 1000 : null, flag, label: 'HYPOTHETICAL' }];
  }));
}

// Records a rejected or waiting signal with its frozen levels. Only the monitor writes outcomes.
function frozenLevels(signal, entry, stopLoss, takeProfit) {
  if (![entry, stopLoss, takeProfit].every(Number.isFinite)) return null;
  return { action: signal.action, entry, stopLoss, takeProfit };
}

// Resolves every open hypothetical that now has final evidence. Writes separate outcome records.
// Market-style hypothetical fill: frozen quote plus modelled half-spread (decision 10).
function marketCosts(d, dec) {
  const f = entryStates.marketFill(dec.levels.action, dec.levels.entry, d.symbol);
  return { entryFill: f.fill, costModel: f.costModel };
}

async function runMonitor(nowMs = Date.now()) {
  const decisions = (await storage.load('decisions')).map(normalizeDecision);
  let written = 0;
  // Collapsed repeats (PENDING) are resolved in place, in one write, from their own frozen levels.
  // Read, change and write in one locked step, so an outcome appended meanwhile is never dropped.
  await storage.mutate('no_trade_outcomes', stored => {
    if (!stored.some(o => o.status === 'PENDING')) return undefined;
    let changed = false;
    const updated = stored.map(o => {
      if (o.status !== 'PENDING') return o;
      const candles = marketData.getHistory(o.symbol, 6000, 'M1');
      const r = resolveOutcome({ timestamp: o.timestamp, levels: o.levels, horizonMinutes: o.horizonMinutes }, candles, nowMs);
      if (r.status === 'UNRESOLVED') return o;
      changed = true;
      written++;
      return { ...o, ...r, producedAt: new Date(nowMs).toISOString() };
    });
    return changed ? updated : undefined;
  });
  const outcomes = await storage.load('no_trade_outcomes');
  const final = new Set(outcomes.filter(o => !['PENDING', 'PENDING_ENTRY'].includes(o.status)).map(o => o.decisionId));
  for (const d of decisions) {
    if (d.decision !== 'SKIPPED' || final.has(d.id)) continue;
    // Entry fields are passed through: a LEVEL opportunity must be resolved as one (decision 10).
    const dec = {
      timestamp: d.timestamp, symbol: d.symbol, levels: d.levels || null, horizonMinutes: d.horizonMinutes || HORIZON_MINUTES,
      entryType: d.entryType, entryLevel: d.entryLevel, invalidationLevel: d.invalidationLevel,
      evidenceExpiresAt: d.evidenceExpiresAt, entryWindowCandles: d.entryWindowCandles
    };
    if (!dec.levels) {
      // Not evaluable is final: there was nothing to freeze, so nothing is invented.
      await storage.append('no_trade_outcomes', { id: `OUT-${d.id}`, decisionId: d.id, symbol: d.symbol, reasonCode: d.reasonCode || reasonCode(d.skipReason, false), regime: d.regime || null, status: 'NOT_EVALUABLE', producedAt: new Date(nowMs).toISOString(), label: 'HYPOTHETICAL' });
      written++;
      continue;
    }
    const candles = marketData.getHistory(d.symbol, 6000, 'M1');
    const r = resolveOutcome(dec, candles, nowMs);
    if (r.status === 'UNRESOLVED') continue;
    const costs = r.entryFill !== undefined ? {} : marketCosts(d, dec);
    const record = {
      id: `OUT-${d.id}`, decisionId: d.id, symbol: d.symbol, reasonCode: d.reasonCode || reasonCode(d.skipReason, false), regime: d.regime || null,
      strategy: d.strategy || null, horizonMinutes: dec.horizonMinutes, levels: dec.levels, entryType: dec.entryType || 'MARKET',
      producedAt: new Date(nowMs).toISOString(), label: 'HYPOTHETICAL', ...costs, ...r
    };
    if (r.status === 'PENDING_ENTRY') {
      // Open: stored once, updated each run until it resolves. Not a final outcome.
      const existing = (await storage.load('no_trade_outcomes')).find(o => o.id === record.id);
      if (existing) await storage.update('no_trade_outcomes', record.id, record);
      else await storage.append('no_trade_outcomes', record);
      continue;
    }
    // A pending record for this opportunity is resolved in place, never duplicated.
    const prior = (await storage.load('no_trade_outcomes')).find(o => o.id === record.id);
    if (prior) await storage.update('no_trade_outcomes', record.id, record);
    else await storage.append('no_trade_outcomes', record);
    written++;
  }
  return { written };
}

module.exports = {
  reasonCode, stateFor, normalizeDecision, resolveOutcome, wilson, summarise, frozenLevels, runMonitor,
  HORIZON_MINUTES, MIN_DECISIVE_FOR_REVIEW
};
