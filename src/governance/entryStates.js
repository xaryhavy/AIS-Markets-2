// Entry states for hypothetical opportunities (decision 10). Hypothetical evidence only: never an execution.
//
// Two entry types:
//   MARKET  The signal would have entered at the decision time. Fill = frozen quote + modelled half-spread.
//           No pending state exists, so INVALIDATED does not apply; the trade is monitored for target, stop or expiry.
//   LEVEL   A limit, stop or retest at a price (entryLevel). Starts PENDING_ENTRY at the decision timestamp.
//           ENTERED      a completed candle trades through the entry level inside the entry window
//           INVALIDATED  before ENTERED, a completed candle breaches invalidationLevel, or evidenceExpiresAt passes
//           EXPIRED_UNFILLED  the entry window ends with no entry and no invalidation
//           AMBIGUOUS_ENTRY   one candle touches both the entry level and the invalidation level (order unknown)
//           AMBIGUOUS_OUTCOME the entry candle also touches the stop or the target (policy below)
//
// Rules: completed candles only; nothing after the decision changes the frozen levels; every state change stores its
// exact rule and timestamp.
// Conservative policy (applied everywhere, stated in reports): when one candle touches both stop and target, or the
// entry candle touches stop or target, the outcome is ambiguous and is not counted as a win or a loss.
const CANDLE_MS = 60000;
const DEFAULT_WINDOW_CANDLES = 12;   // completed candles of the signal's timeframe (M1 here)

// Half of a typical spread, in price units. Symbols not listed model no spread, and the record says so.
const HALF_SPREAD = { EURUSD: 0.00005, GBPUSD: 0.00007, USDJPY: 0.005, XAUUSD: 0.15, BTCUSD: 7.5 };

// Market-style fill: the frozen quote plus the modelled half-spread against the trader (slippage is not modelled).
function marketFill(action, entry, symbol) {
  const hs = HALF_SPREAD[symbol];
  const halfSpread = Number.isFinite(hs) ? hs : 0;
  return {
    fill: action === 'BUY' ? entry + halfSpread : entry - halfSpread,
    costModel: { halfSpread, slippage: 0, spreadSource: Number.isFinite(hs) ? 'table for ' + symbol : 'none modelled for ' + symbol }
  };
}

// Walks completed candles from startMs to the horizon for stop and target. Both on one candle is AMBIGUOUS.
function scanTrade({ action, sl, tp, candles, startMs, horizonEnd, nowMs }) {
  const list = candles.filter(c => c.time >= startMs && c.time < horizonEnd && c.time + CANDLE_MS <= nowMs).sort((a, b) => a.time - b.time);
  let scanned = 0;
  for (const c of list) {
    scanned++;
    const stopHit = action === 'BUY' ? c.low <= sl : c.high >= sl;
    const targetHit = action === 'BUY' ? c.high >= tp : c.low <= tp;
    if (stopHit && targetHit) return { status: 'AMBIGUOUS', resolvedAt: new Date(c.time).toISOString(), candlesScanned: scanned, note: 'one candle touched both stop and target; order unknown, not counted' };
    if (stopHit) return { status: 'STOP_HIT', resolvedAt: new Date(c.time + CANDLE_MS).toISOString(), exitPrice: sl, candlesScanned: scanned };
    if (targetHit) return { status: 'TARGET_HIT', resolvedAt: new Date(c.time + CANDLE_MS).toISOString(), exitPrice: tp, candlesScanned: scanned };
  }
  if (nowMs >= horizonEnd) return { status: 'EXPIRED', resolvedAt: new Date(horizonEnd).toISOString(), candlesScanned: scanned };
  return { status: 'UNRESOLVED', candlesScanned: scanned };
}

// Pure. Resolves one LEVEL opportunity. Returns { status, rule, at, ... }.
function resolveLevelOutcome(dec, candles, nowMs) {
  const action = dec.levels.action;
  const L = dec.entryLevel;
  const I = Number.isFinite(dec.invalidationLevel) ? dec.invalidationLevel : null;
  const windowCandles = Number.isInteger(dec.entryWindowCandles) && dec.entryWindowCandles > 0 ? dec.entryWindowCandles : DEFAULT_WINDOW_CANDLES;
  const decisionMs = Date.parse(dec.timestamp);
  const firstMs = (Math.floor(decisionMs / CANDLE_MS) + 1) * CANDLE_MS;   // never the candle the decision was made in
  const windowEnd = firstMs + windowCandles * CANDLE_MS;
  const expiryMs = dec.evidenceExpiresAt ? Date.parse(dec.evidenceExpiresAt) : null;
  const iso = ms => new Date(ms).toISOString();
  const list = candles.filter(c => c.time >= firstMs && c.time < windowEnd && c.time + CANDLE_MS <= nowMs).sort((a, b) => a.time - b.time);

  for (const c of list) {
    if (expiryMs !== null && c.time >= expiryMs) return { status: 'INVALIDATED', rule: 'EVIDENCE_EXPIRED_BEFORE_ENTRY', at: iso(expiryMs) };
    const touchesEntry = c.low <= L && L <= c.high;
    const breaches = I !== null && (action === 'BUY' ? c.low <= I : c.high >= I);
    if (touchesEntry && breaches) return { status: 'AMBIGUOUS_ENTRY', rule: 'ENTRY_AND_INVALIDATION_SAME_CANDLE', at: iso(c.time) };
    if (breaches) return { status: 'INVALIDATED', rule: 'INVALIDATION_BREACHED_BEFORE_ENTRY', at: iso(c.time + CANDLE_MS) };
    if (touchesEntry) {
      const sl = dec.levels.stopLoss, tp = dec.levels.takeProfit;
      const stopOrTarget = action === 'BUY' ? (c.low <= sl || c.high >= tp) : (c.high >= sl || c.low <= tp);
      const entryFill = marketFill(action, L, dec.symbol);
      if (stopOrTarget) return { status: 'AMBIGUOUS_OUTCOME', rule: 'ENTRY_CANDLE_TOUCHED_STOP_OR_TARGET', at: iso(c.time), entryAt: iso(c.time), entryFill: entryFill.fill, costModel: entryFill.costModel };
      const horizonEnd = c.time + (dec.horizonMinutes || 60) * CANDLE_MS;
      const rest = scanTrade({ action, sl, tp, candles, startMs: c.time + CANDLE_MS, horizonEnd, nowMs });
      return { ...rest, entryAt: iso(c.time), entryRule: 'ENTRY_LEVEL_TOUCHED', entryFill: entryFill.fill, costModel: entryFill.costModel };
    }
  }
  if (expiryMs !== null && expiryMs <= nowMs) return { status: 'INVALIDATED', rule: 'EVIDENCE_EXPIRED_BEFORE_ENTRY', at: iso(expiryMs) };
  if (nowMs < windowEnd) return { status: 'PENDING_ENTRY', note: 'entry window open', windowEnd: iso(windowEnd) };
  return { status: 'EXPIRED_UNFILLED', rule: 'ENTRY_WINDOW_ENDED_NO_TOUCH', at: iso(windowEnd) };
}

module.exports = { resolveLevelOutcome, marketFill, scanTrade, HALF_SPREAD, DEFAULT_WINDOW_CANDLES, CANDLE_MS };
