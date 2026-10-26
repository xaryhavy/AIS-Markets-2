const { runBacktest } = require('../backtest/engine');
const { strategies } = require('./strategies');

// Grid search over parameter ranges for a strategy
function gridSearch(strategyName, paramGrid, options = {}) {
  const strategy = strategies[strategyName];
  if (!strategy) return { error: 'Unknown strategy' };
  const keys = Object.keys(paramGrid);
  const combos = [];
  // Build all combinations
  function build(idx, current) {
    if (idx === keys.length) { combos.push({ ...current }); return; }
    for (const val of paramGrid[keys[idx]]) build(idx + 1, { ...current, [keys[idx]]: val });
  }
  build(0, {});
  const results = combos.map(params => runBacktest(strategyName, params, options));
  return results.sort((a, b) => b.sharpeRatio - a.sharpeRatio);
}

// Optimize all strategies with sensible default grids
function optimizeAll(options = {}) {
  const grids = {
    smaCrossover: { fast: [5, 10, 15, 20], slow: [20, 30, 50] },
    rsiMeanReversion: { rsiPeriod: [7, 14, 21], oversold: [25, 30, 35], overbought: [65, 70, 75] },
    bollingerBreakout: { period: [15, 20, 30], mult: [1.5, 2, 2.5] },
    momentum: { period: [5, 10, 20], threshold: [0.001, 0.002, 0.005] },
    macdCrossover: {}
  };
  const best = {};
  for (const name of Object.keys(strategies)) {
    const results = gridSearch(name, grids[name] || {}, options);
    best[name] = results[0] || null;
  }
  return best;
}

module.exports = { gridSearch, optimizeAll };