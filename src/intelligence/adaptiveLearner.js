const fs = require('fs-extra');
const path = require('path');
// Env override is for tests, matching AIS_REGISTRY_FILE and AIS_DATA_DIR.
const WEIGHTS_FILE = process.env.AIS_WEIGHTS_FILE || path.join(__dirname, '../../data/adaptive_weights.json');
const DECAY = 0.95; // old results decay over time
const CIRCUIT_BREAKER_LOSSES = 3;

// The weights file is rewritten whole on every closed trade and every backtest run, and read once per
// strategy per symbol per cycle (45 reads for 9 strategies on 5 symbols). Two writes overlapping, or a read
// landing inside a write, left the file truncated and threw "Unexpected end of JSON input" — three cycles
// died on 2026-11-02 and the entry pause latched, and a live backtest reproduced it on 2026-11-03.
//
// So: writes are atomic (temp file then rename, the pattern src/data/storage.js uses), read-modify-write
// cycles are serialised so two of them cannot interleave, and reads are served from memory so the engine
// no longer touches this file in the trading path at all.
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;
let cache = null;               // the weights object once loaded
let chain = Promise.resolve();  // mutations run one at a time
let tmpCounter = 0;

function serial(fn) {
  const run = chain.catch(() => {}).then(fn);
  chain = run;
  return run;
}

function initial() {
  return { perStrategy: {}, recentTrades: [], totalTrades: 0, consecutiveLosses: 0 };
}

// Loads once, without serialising: a caller already inside a serialised mutation must use this one, or it
// would wait on the chain it is itself holding.
async function ensureLoaded() {
  if (cache) return cache;
  if (!await fs.pathExists(WEIGHTS_FILE)) {
    cache = initial();
    await writeAtomic(cache);
    return cache;
  }
  try {
    cache = await fs.readJson(WEIGHTS_FILE);
  } catch (e) {
    // A file that cannot be read is not silently replaced with neutral weights: a weight of 1.0 sizes
    // positions differently from a learned weight of 0.2, and that is the owner's decision, not a fallback's.
    throw new Error(`adaptive weights unreadable (${e.message})`);
  }
  return cache;
}

async function loadWeights() {
  if (cache) return cache;
  return serial(ensureLoaded);
}

// Write to a temp file, then rename, so a reader never sees a half-written file. On Windows the rename can
// fail while another handle is open, so it is retried briefly; a final failure is raised, never swallowed.
async function writeAtomic(w) {
  await fs.ensureDir(path.dirname(WEIGHTS_FILE));
  const tmp = `${WEIGHTS_FILE}.${process.pid}.${++tmpCounter}.tmp`;
  await fs.writeJson(tmp, w, { spaces: 2 });
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmp, WEIGHTS_FILE);
      cache = w;
      return;
    } catch (e) {
      if (!RETRYABLE.has(e.code) || attempt >= RENAME_ATTEMPTS) { await fs.remove(tmp).catch(() => {}); throw e; }
      await new Promise(r => setTimeout(r, 50 * attempt));
    }
  }
}

// Read-modify-write on a copy, so a failed write leaves memory and disk agreeing rather than drifting.
async function mutate(fn) {
  return serial(async () => {
    const w = JSON.parse(JSON.stringify(await ensureLoaded()));
    const result = fn(w);
    await writeAtomic(w);
    return result === undefined ? w : result;
  });
}

// Tests get a clean slate without touching the real file.
function resetCache() { cache = null; }

// Called after every closed trade — updates strategy performance weights
async function updateOnTrade(trade, strategyName, regime) {
  return mutate((w) => {
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
  });
}

// Records the result of a real-data backtest for one strategy and symbol. Each run replaces the previous
// run for the same strategy and symbol, so repeated runs do not double-count.
async function recordBacktest(strategyName, symbol, trades) {
  return mutate((w) => {
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
    return byRegime;
  });
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

module.exports = { WEIGHTS_FILE, updateOnTrade, recordBacktest, getWeight, getPositionMultiplier, getStats, resetCache };