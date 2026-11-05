const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');

// The backtest writes its trades to disk; point it at a temp file so the real corpus is never touched.
const TMP = path.join(os.tmpdir(), `ais-backtest-depth-${process.pid}.json`);
process.env.AIS_BACKTEST_TRADES_FILE = TMP;

const marketData = require('../src/data/marketdata');
const feed = require('../src/ctrader/marketFeed');
const realBacktest = require('../src/backtest/realBacktest');

const MINUTE = 60000;

// A flat, well-formed M1 series: enough bars to clear the backtest's minimum, no signal in it.
function series(n, startMs) {
  return Array.from({ length: n }, (_, i) => ({
    time: startMs + i * MINUTE,
    open: 1.1, high: 1.1005, low: 1.0995, close: 1.1
  }));
}

test('the backtest asks for the whole M1 buffer, not a fixed slice of it', async () => {
  const asked = [];
  const original = { getHistory: marketData.getHistory, getSymbols: marketData.getSymbols };
  marketData.getSymbols = () => ['EURUSD'];
  marketData.getHistory = (symbol, limit, tf = 'M1') => {
    asked.push({ symbol, limit, tf });
    return series(Math.min(limit, 300), Date.UTC(2026, 10, 2));
  };
  try {
    await realBacktest.runOnLiveHistory({}, { learn: false });
  } finally {
    marketData.getHistory = original.getHistory;
    marketData.getSymbols = original.getSymbols;
  }
  const m1 = asked.find(a => a.tf === 'M1');
  assert.ok(m1, 'the backtest read M1 history');
  assert.equal(m1.limit, marketData.maxBars('M1'),
    'the backtest must read the whole buffer — a smaller number silently caps everything the system learns');
});

test('the feed seeds as deep as the store keeps, so the buffer can actually fill', () => {
  for (const tf of ['M1', 'M5', 'M15', 'H1']) {
    assert.equal(feed.SEED_BARS[tf], marketData.maxBars(tf),
      `${tf}: a seed shallower than the buffer is a silent cap on history`);
  }
});

test('the M1 buffer holds more than a week of trading, so every weekday is represented', () => {
  const days = marketData.maxBars('M1') / (24 * 60);
  assert.ok(days >= 10, `M1 depth is ${days.toFixed(1)} days; the model needs at least two weeks to see every weekday`);
});

test('a deeper buffer produces a deeper backtest, not the same 2,000 bars', async () => {
  const original = { getHistory: marketData.getHistory, getSymbols: marketData.getSymbols };
  marketData.getSymbols = () => ['EURUSD'];
  // Serve 5,000 bars: more than the old fixed 2,000, less than the buffer.
  marketData.getHistory = (symbol, limit, tf = 'M1') => series(Math.min(limit, 5000), Date.UTC(2026, 10, 2));
  let bars = 0;
  try {
    const results = await realBacktest.runOnLiveHistory({}, { learn: false });
    bars = results[0].bars;
  } finally {
    marketData.getHistory = original.getHistory;
    marketData.getSymbols = original.getSymbols;
    await fs.remove(TMP).catch(() => {});
  }
  assert.equal(bars, 5000, 'the backtest used every bar the store held');
});
