const storage = require('../data/storage');
const marketData = require('../data/marketdata');
const noTrade = require('./noTrade');

// Records EVERY decision with a structured state. `decision` is the outcome string ('EXECUTED' or 'SKIPPED').
// `decisionInfo` is { decision, reason } from the engine. Levels come from signal.levels when they were computed.
async function recordDecision(signal, decisionInfo) {
  const decision = typeof decisionInfo === 'string' ? decisionInfo : decisionInfo.decision;
  const reason = typeof decisionInfo === 'string' ? null : (decisionInfo.reason || null);
  const code = decision === 'EXECUTED' ? 'EXECUTED' : noTrade.reasonCode(reason, signal.qualified !== false);
  const levels = signal.levels || null;
  const record = {
    id: 'DEC-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    symbol: signal.symbol,
    timeframe: 'M1',
    signalAction: signal.action,
    signalScore: signal.score,
    regime: signal.regime || null,
    strategy: signal.dominantStrategy || null,
    strategyVersion: 'unversioned', // no strategy versioning exists yet; recorded honestly
    indicators: signal.indicators,
    decision,
    reasonCode: code,
    state: noTrade.stateFor(decision, code),
    skipReason: reason,
    priceAtDecision: marketData.getPrice(signal.symbol),
    // Links the decision to the exact completed candles it was made from.
    dataFingerprint: signal.dataFingerprint || null,
    // Frozen at decision time; never updated afterwards.
    levels,
    horizonMinutes: levels ? noTrade.HORIZON_MINUTES : null
  };
  const waitWithLevels = decision === 'SKIPPED' && levels && noTrade.stateFor(decision, code) === 'WAIT';
  if (waitWithLevels) {
    // A repeat of the last logged WAIT for this symbol and reason is not logged again. Its frozen levels are kept
    // as a PENDING hypothetical in the outcome store, so every setup the monitor saw is still evaluated.
    const decisions = await storage.load('decisions');
    const last = [...decisions].reverse().find(d => d.symbol === signal.symbol);
    if (last && last.decision === 'SKIPPED' && last.reasonCode === code && last.levels) {
      await storage.append('no_trade_outcomes', {
        id: `OUT-PEND-${record.id}`,
        decisionId: record.id,
        collapsedInto: last.id,
        symbol: signal.symbol,
        reasonCode: code,
        regime: record.regime,
        strategy: record.strategy,
        timestamp: record.timestamp,
        status: 'PENDING',
        levels,
        horizonMinutes: noTrade.HORIZON_MINUTES,
        label: 'HYPOTHETICAL'
      });
      return;
    }
  }
  await storage.append('decisions', record);
}

// Retired. It judged skipped decisions against the price at evaluation time and never ran on the stored
// records (their decision field was an object). Outcomes now come from src/governance/noTrade.js runMonitor.
async function evaluateShadows() {
  return { deprecated: true, use: 'noTrade.runMonitor' };
}

module.exports = { recordDecision, evaluateShadows };
