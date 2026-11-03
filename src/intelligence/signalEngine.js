const { strategies, listStrategies } = require('./strategies');
const marketData = require('../data/marketdata');
const dataQuality = require('../data/quality');
const regimeDetector = require('./regimeDetector');
const adaptiveLearner = require('./adaptiveLearner');
const candlestickPatterns = require('./candlestickPatterns');
const registry = require('../strategy/registry');
const baseline = require('../strategy/baseline');

const MIN_SCORE = 30;

// The registry is registered and adopted once per process, not once per symbol per cycle. Strategies are
// loaded statically, so the descriptors cannot change underneath a running process.
let baselineReady = null;
function ensureBaseline() {
  if (!baselineReady) {
    baselineReady = baseline.ensure().catch((e) => {
      baselineReady = null;
      throw e;
    });
  }
  return baselineReady;
}
function resetBaseline() { baselineReady = null; }

// The strategies the engine is allowed to run. Fails closed: if the registry cannot be read, nothing runs.
async function runnableStrategies() {
  try {
    await ensureBaseline();
    return new Set(await registry.runnableNames());
  } catch (e) {
    console.log(`[SIGNALS] Strategy registry unavailable (${e.message}) — no strategy may run`);
    return new Set();
  }
}

async function evaluateSymbol(symbol) {
  // Completed, validated candles only: a forming candle must never drive a decision.
  const history = dataQuality.completedBars(symbol, 'M1', 60);
  const regime = regimeDetector.classify(history);
  const priors = regimeDetector.REGIME_STRATEGY_PRIORS[regime.regime] || {};

  // Detect candlestick patterns (from Bible)
  const detectedPatterns = candlestickPatterns.detectAll(history);

  // Only a strategy with a DEPLOYED version may vote — approval alone is not enough. An undeployed strategy
  // is not skipped quietly: it is named in the result, so a drop in coverage can never pass for no signal.
  const runnable = await runnableStrategies();
  const blockedStrategies = listStrategies().filter((name) => !runnable.has(name));

  const signals = [];
  for (const name of listStrategies()) {
    if (!runnable.has(name)) continue;
    const strat = strategies[name];
    const sig = strat.generate(history, strat.defaultParams || {});
    const adaptiveWeight = await adaptiveLearner.getWeight(name, regime.regime);
    const prior = priors[name] || 1.0;
    // Price action strategies already include confluence — boost their weight
    const isPriceAction = name.includes('Confluence') || name.includes('Breakout') || name.includes('Patterns');
    const boost = isPriceAction ? 1.3 : 1.0;
    const weightedScore = Math.round(sig.score * adaptiveWeight * prior * boost);
    signals.push({ strategy: name, ...sig, weightedScore, adaptiveWeight, prior, isPriceAction });
  }

  // Ensemble vote
  let buyScore = 0, sellScore = 0, contributing = [];
  for (const s of signals) {
    if (s.action === 'BUY') { buyScore += s.weightedScore; contributing.push(s); }
    else if (s.action === 'SELL') { sellScore += s.weightedScore; contributing.push(s); }
  }

  // No runnable strategy is a different situation from strategies agreeing on nothing, and the owner should
  // be able to tell them apart without reading the registry by hand.
  let action = 'HOLD', reason = 'No consensus', score = 0, dominantStrategy = null;
  if (runnable.size === 0) reason = 'No strategy is deployed — approve and deploy one in the strategy registry';
  if (buyScore > sellScore && buyScore >= MIN_SCORE) {
    action = 'BUY'; score = buyScore;
    const buyers = contributing.filter(s => s.action === 'BUY').sort((a, b) => b.weightedScore - a.weightedScore);
    dominantStrategy = buyers[0]?.strategy;
    reason = `Ensemble BUY (${buyers.length} strategies agree, led by ${dominantStrategy})`;
  } else if (sellScore > buyScore && sellScore >= MIN_SCORE) {
    action = 'SELL'; score = sellScore;
    const sellers = contributing.filter(s => s.action === 'SELL').sort((a, b) => b.weightedScore - a.weightedScore);
    dominantStrategy = sellers[0]?.strategy;
    reason = `Ensemble SELL (${sellers.length} strategies agree, led by ${dominantStrategy})`;
  }

  const qualified = action !== 'HOLD' && score >= MIN_SCORE;
  return {
    symbol, action, reason, score, qualified,
    dominantStrategy,
    regime: regime.regime,
    regimeConfidence: regime.confidence,
    strategiesRun: signals.length,
    strategiesBlocked: blockedStrategies,
    detectedPatterns: detectedPatterns.map(p => ({ pattern: p.pattern, direction: p.direction, strength: p.strength })),
    strategySignals: signals.map(s => ({ strategy: s.strategy, action: s.action, score: s.score, weightedScore: s.weightedScore, pattern: s.pattern || null, confluenceGrade: s.confluence?.grade || null }))
  };
}

async function scanAll() {
  const results = [];
  for (const s of marketData.getSymbols()) results.push(await evaluateSymbol(s));
  return results;
}

module.exports = { evaluateSymbol, scanAll, runnableStrategies, resetBaseline, MIN_SCORE };