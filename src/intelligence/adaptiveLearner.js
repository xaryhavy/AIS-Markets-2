const fs = require('fs-extra');
const path = require('path');
const WEIGHTS_FILE = path.join(__dirname, '../../data/adaptive_weights.json');
const DECAY = 0.95; // old results decay over time
const CIRCUIT_BREAKER_LOSSES = 3;

async function loadWeights() {
  if (!await fs.pathExists(WEIGHTS_FILE)) {
    const initial = { perStrategy: {}, recentTrades: [], totalTrades: 0, consecutiveLosses: 0 };
    await fs.writeJson(WEIGHTS_FILE, initial, { spaces: 2 });
    return initial;
  }
  return fs.readJson(WEIGHTS_FILE);
}

async function saveWeights(w) { await fs.writeJson(WEIGHTS_FILE, w, { spaces: 2 }); }

// Called after every closed trade — updates strategy performance weights
async function updateOnTrade(trade, strategyName, regime) {
  const w = await loadWeights();
  w.totalTrades++;
  // Decay all existing weights
  for (const s in w.perStrategy) {
    for (const r in w.perStrategy[s]) {
      w.perStrategy[s][r].wins *= DECAY;
      w.perStrategy[s][r].losses *= DECAY;
      w.perStrategy[s][r].pnl *= DECAY;
    }
  }
  if (!w.perStrategy[strategyName]) w.perStrategy[strategyName] = {};
  if (!w.perStrategy[strategyName][regime]) w.perStrategy[strategyName][regime] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
  const entry = w.perStrategy[strategyName][regime];
  entry.trades++;
  if ((trade.pnl || 0) > 0) { entry.wins++; w.consecutiveLosses = 0; }
  else { entry.losses++; w.consecutiveLosses++; }
  entry.pnl += (trade.pnl || 0);
  w.recentTrades.push({ strategy: strategyName, regime, pnl: trade.pnl, time: new Date().toISOString() });
  if (w.recentTrades.length > 100) w.recentTrades.shift();
  await saveWeights(w);
  return w;
}

// Records the result of a real-data backtest for one strategy and symbol. Each run replaces the previous
// run for the same strategy and symbol, so repeated runs do not double-count.
async function recordBacktest(strategyName, symbol, trades) {
  const w = await loadWeights();
  w.backtest = w.backtest || {};
  const byRegime = {};
  for (const t of trades) {
    const regime = t.regime || 'UNKNOWN';
    const e = byRegime[regime] || (byRegime[regime] = { wins: 0, losses: 0, pnl: 0, trades: 0 });
    e.trades++;
    if ((t.pnl || 0) > 0) e.wins++; else e.losses++;
    e.pnl += t.pnl || 0;
  }
  w.backtest[`${strategyName}|${symbol}`] = { updatedAt: new Date().toISOString(), byRegime };
  await saveWeights(w);
  return byRegime;
}

// Sums backtest evidence for a strategy in a regime across all symbols.
function backtestEntry(w, strategyName, regime) {
  const total = { wins: 0, losses: 0, pnl: 0, trades: 0 };
  for (const [key, run] of Object.entries(w.backtest || {})) {
    if (!key.startsWith(`${strategyName}|`)) continue;
    const e = run.byRegime[regime];
    if (!e) continue;
    total.wins += e.wins; total.losses += e.losses; total.pnl += e.pnl; total.trades += e.trades;
  }
  return total.trades ? total : null;
}

const BACKTEST_DISCOUNT = 0.8; // backtest evidence counts for less than live results

// Get normalized performance weight for a strategy in a regime.
// Live results win when there are enough of them; backtest results are used otherwise, discounted.
// A 50% win rate with no net profit is neutral (1.0); better results raise the weight, worse ones lower it.
function scoreWeight(wins, losses, pnl) {
  const winRate = wins / (wins + losses);
  const pnlFactor = Math.max(0.3, Math.min(2, 1 + pnl / 1000));
  return Math.max(0.2, Math.min(2, (winRate / 0.5) * pnlFactor));
}

async function getWeight(strategyName, regime) {
  const w = await loadWeights();
  const entry = w.perStrategy[strategyName]?.[regime];
  if (entry && entry.trades >= 3) {
    return Math.round(scoreWeight(entry.wins, entry.losses, entry.pnl) * 100) / 100;
  }
  const bt = backtestEntry(w, strategyName, regime);
  if (bt && bt.trades >= 10) {
    return Math.round(scoreWeight(bt.wins, bt.losses, bt.pnl) * BACKTEST_DISCOUNT * 100) / 100;
  }
  return 1.0; // not enough evidence — neutral
}

// Circuit breaker: after N consecutive losses, halve position sizes
async function getPositionMultiplier() {
  const w = await loadWeights();
  if (w.consecutiveLosses >= CIRCUIT_BREAKER_LOSSES) return 0.5;
  return 1.0;
}

async function getStats() {
  const w = await loadWeights();
  return { totalTrades: w.totalTrades, consecutiveLosses: w.consecutiveLosses, positionMultiplier: await getPositionMultiplier(), perStrategy: w.perStrategy };
}

module.exports = { updateOnTrade, recordBacktest, getWeight, getPositionMultiplier, getStats };