// Backtests every strategy on the real cTrader bars for each live symbol. Each trade is tagged with the
// situation it opened in (regime, time, patterns and multi-timeframe trends known at entry), the results
// feed the adaptive learner, and the trades are kept for the ML model and pattern mining.
const fs = require('fs-extra');
const path = require('path');
const backtest = require('./engine');
const marketData = require('../data/marketdata');
const regimeDetector = require('../intelligence/regimeDetector');
const candlestickPatterns = require('../intelligence/candlestickPatterns');
const adaptiveLearner = require('../intelligence/adaptiveLearner');
const timeframes = require('../intelligence/timeframes');
const { listStrategies } = require('../intelligence/strategies');

const TRADES_FILE = process.env.AIS_BACKTEST_TRADES_FILE || path.join(__dirname, '../../data/backtest_trades.json'); // env override is for tests
const MIN_BARS = 200;
// The whole M1 buffer, not a fixed slice of it. A hardcoded 2,000 here capped every backtest — and so every
// learned weight and the ML model — at 33 hours of history no matter how much the feed had stored.
const BARS = marketData.maxBars('M1');

async function loadTrades() {
  try { return await fs.readJson(TRADES_FILE); } catch { return {}; }
}

// Features of a backtest trade, measured with only the bars that existed at entry.
// The entry happens when the bar at openBar closes, so higher-frame bars must have ended by then.
// Bars the feature reader looks at. The regime detector needs SMA50 and the pattern reader three bars, so
// 500 is generous; slicing the whole series per trade is what made a multi-year backtest quadratic.
const FEATURE_WINDOW = 500;

function featuresAt(history, openBar, strategy, frames, barMs = 60000) {
  const slice = history.slice(Math.max(0, openBar + 1 - FEATURE_WINDOW), openBar + 1);
  const time = new Date(history[openBar].time);
  // The decision is taken when the entry bar closes, which is one bar after it opened — not always a minute.
  const decisionTime = history[openBar].time + barMs;
  return {
    regime: regimeDetector.classify(slice).regime,
    hourUtc: time.getUTCHours(),
    dayOfWeek: time.getUTCDay(),
    strategy,
    patterns: candlestickPatterns.detectAll(slice).map(p => p.pattern),
    mtf: timeframes.trendsAt(frames, decisionTime)
  };
}

async function runOnLiveHistory(options = {}, { learn = true } = {}) {
  const results = [];
  const stored = await loadTrades();
  for (const symbol of marketData.getSymbols()) {
    const history = marketData.getHistory(symbol, BARS);
    if (history.length < MIN_BARS) {
      results.push({ symbol, error: `Only ${history.length} bars available (need ${MIN_BARS})` });
      continue;
    }
    const frames = {
      M5: marketData.getHistory(symbol, marketData.maxBars('M5'), 'M5'),
      M15: marketData.getHistory(symbol, marketData.maxBars('M15'), 'M15'),
      H1: marketData.getHistory(symbol, marketData.maxBars('H1'), 'H1')
    };
    for (const strategy of listStrategies()) {
      // These are real cTrader bars, and the result says so. Costs and the ambiguity policy come from the caller.
      const r = backtest.runBacktest(strategy, {}, { ...options, history, dataSource: 'CTRADER_BARS', includeTrades: true });
      if (r.error) continue;
      const trades = r.allTrades.map(t => ({
        symbol,
        action: t.action,
        pnl: t.pnl,
        timeframe: 'M1',
        openTime: new Date(history[t.openBar].time).toISOString(),
        features: featuresAt(history, t.openBar, strategy, frames)
      }));
      if (learn) await adaptiveLearner.recordBacktest(strategy, symbol, trades.map(t => ({ pnl: t.pnl, regime: t.features.regime })));
      stored[`${strategy}|${symbol}`] = trades;
      const { allTrades, ...summary } = r;
      results.push({ symbol, bars: history.length, learned: learn, ...summary });
    }
  }
  await fs.ensureDir(path.dirname(TRADES_FILE));
  await fs.writeJson(TRADES_FILE, stored);
  return results;
}

// All stored backtest trades, flattened.
async function storedTrades() {
  return Object.values(await loadTrades()).flat();
}

async function saveTrades(stored) {
  await fs.ensureDir(path.dirname(TRADES_FILE));
  await fs.writeJson(TRADES_FILE, stored);
}

module.exports = { runOnLiveHistory, storedTrades, featuresAt, loadTrades, saveTrades, TRADES_FILE };
