const { strategies, listStrategies } = require('./strategies');
const marketData = require('../data/marketdata');
const dataQuality = require('../data/quality');
const regimeDetector = require('./regimeDetector');
const adaptiveLearner = require('./adaptiveLearner');
const candlestickPatterns = require('./candlestickPatterns');

const MIN_SCORE = 30;

async function evaluateSymbol(symbol) {
  // Completed, validated candles only: a forming candle must never drive a decision.
  const history = dataQuality.completedBars(symbol, 'M1', 60);
  const regime = regimeDetector.classify(history);
  const priors = regimeDetector.REGIME_STRATEGY_PRIORS[regime.regime] || {};

  // Detect candlestick patterns (from Bible)
  const detectedPatterns = candlestickPatterns.detectAll(history);

  // Get signals from ALL strategies (9 total: 5 indicator + 4 price action)
  const signals = [];
  for (const name of listStrategies()) {
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

  let action = 'HOLD', reason = 'No consensus', score = 0, dominantStrategy = null;
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
    detectedPatterns: detectedPatterns.map(p => ({ pattern: p.pattern, direction: p.direction, strength: p.strength })),
    strategySignals: signals.map(s => ({ strategy: s.strategy, action: s.action, score: s.score, weightedScore: s.weightedScore, pattern: s.pattern || null, confluenceGrade: s.confluence?.grade || null }))
  };
}

async function scanAll() {
  const results = [];
  for (const s of marketData.getSymbols()) results.push(await evaluateSymbol(s));
  return results;
}

module.exports = { evaluateSymbol, scanAll, MIN_SCORE };