// Level-style opportunities (decision 10, owner rule). A strategy may define an entry condition on its signal:
//   signal.entryCondition = { type: 'LIMIT' | 'STOP' | 'RETEST', level, invalidation,
//                             stopLoss?, takeProfit?, expiresAt?, windowCandles? }
// At decision time the condition is FROZEN into the decision record: entry, invalidation, stop, target, expiry and the
// entry window. Nothing after the decision changes them.
// - No entry condition on the signal: market-style (unchanged; handled elsewhere).
// - A condition without a valid level, or without an invalidation level on the correct side: NOT EVALUABLE.
//   No level is ever derived or invented here.
// - Stop and target: the strategy's own values when it gives both; otherwise the system's standard stop rule
//   (riskManager.calculateStops) applied to the entry level with the decision-time ATR.
// - Expiry: the strategy's expiresAt when given; otherwise none (the entry window bounds the opportunity).
const { DEFAULT_WINDOW_CANDLES } = require('./entryStates');

const TYPES = new Set(['LIMIT', 'STOP', 'RETEST']);

// Pure. Returns the fields to freeze on the decision, or {} for a market-style signal.
function freeze(signal, { calculateStops, atr = null } = {}) {
  const ec = signal && signal.entryCondition;
  if (ec === undefined || ec === null) return {};
  const type = TYPES.has(ec.type) ? ec.type : null;
  const notEvaluable = reason => ({
    entryType: 'LEVEL', entryCondition: { type: ec.type ?? null }, entryLevel: null, invalidationLevel: null,
    levels: null, notEvaluableReason: reason
  });
  if (!type) return notEvaluable(`entry type must be LIMIT, STOP or RETEST (got ${String(ec.type)})`);
  if (!Number.isFinite(ec.level)) return notEvaluable('no defined entry level');
  const inv = ec.invalidation;
  const correctSide = signal.action === 'BUY' ? inv < ec.level : inv > ec.level;
  if (!Number.isFinite(inv) || !correctSide) return notEvaluable('invalidation level missing or on the wrong side of the entry');
  const stops = Number.isFinite(ec.stopLoss) && Number.isFinite(ec.takeProfit)
    ? { stopLoss: ec.stopLoss, takeProfit: ec.takeProfit }
    : calculateStops(signal.symbol, ec.level, signal.action, atr);
  const windowCandles = Number.isInteger(ec.windowCandles) && ec.windowCandles > 0 ? ec.windowCandles : DEFAULT_WINDOW_CANDLES;
  const expiry = ec.expiresAt !== undefined && ec.expiresAt !== null && Number.isFinite(Date.parse(ec.expiresAt)) ? new Date(ec.expiresAt).toISOString() : null;
  return {
    entryType: 'LEVEL',
    entryCondition: { type },
    entryLevel: ec.level,
    invalidationLevel: inv,
    evidenceExpiresAt: expiry,
    entryWindowCandles: windowCandles,
    levels: { action: signal.action, entry: ec.level, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit }
  };
}

module.exports = { freeze, TYPES };
