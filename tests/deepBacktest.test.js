const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');

// Everything here writes to a temp directory: the real history cache and trade corpus are never touched.
const TMP = path.join(os.tmpdir(), `ais-deep-${process.pid}`);
process.env.AIS_HISTORY_DIR = path.join(TMP, 'history');
process.env.AIS_BACKTEST_TRADES_FILE = path.join(TMP, 'backtest_trades.json');
process.env.AIS_ML_MODEL_FILE = path.join(TMP, 'ml_model.json');

const historyStore = require('../src/data/historyStore');
const deepBacktest = require('../src/backtest/deepBacktest');
const backtest = require('../src/backtest/engine');
const { strategies, listStrategies } = require('../src/intelligence/strategies');

const MINUTE = 60000;

// A broker holding `n` M5 bars ending now, serving 1,000 per request the way cTrader does. The bars are five
// minutes apart, as real M5 bars are: a fake that spaced them one minute apart would let the store's window
// arithmetic look right while paging into history the broker never had.
function fakeBroker(n) {
  const nowMin = Math.floor(Date.now() / MINUTE);
  const have = Array.from({ length: n }, (_, i) => nowMin - i * 5);
  const calls = [];
  return {
    calls,
    getTrendbars: async ({ count, toTimestamp }) => {
      calls.push({ count, toTimestamp });
      const to = Math.floor(toTimestamp / MINUTE);
      return have.filter(m => m <= to && m > to - count * 5).map(m => ({
        utcTimestampInMinutes: m, low: 110000, deltaOpen: 0, deltaHigh: 10, deltaClose: 5
      }));
    }
  };
}

test('five years of M5 is the bar count the store asks for', () => {
  assert.equal(historyStore.barsFor(5, 'M5'), 5 * 365 * 24 * 12);
  assert.equal(historyStore.barsFor(5, 'H1'), 5 * 365 * 24);
});

test('aggregation builds whole higher-timeframe bars from the base series', () => {
  const base = [
    { time: 0, open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: 5 * MINUTE, open: 1.5, high: 3, low: 1, close: 2 },
    { time: 10 * MINUTE, open: 2, high: 2.5, low: 0.2, close: 1 },
    { time: 15 * MINUTE, open: 1, high: 1.2, low: 0.9, close: 1.1 }
  ];
  const m15 = historyStore.aggregate(base, 3, 5);
  assert.equal(m15.length, 2);
  assert.deepEqual(m15[0], { time: 0, open: 1, high: 3, low: 0.2, close: 1 }, 'first open, highest high, lowest low, last close');
  assert.equal(m15[1].time, 15 * MINUTE);
});

test('a cold cache fetches the window once, and a warm one does not fetch again', async () => {
  const broker = fakeBroker(5000);
  const first = await historyStore.load('EURUSD', 'M5', { years: 0.01, client: broker, accountId: 1, symbolId: 1 });
  assert.ok(first.bars.length > 1000, `fetched ${first.bars.length} bars`);
  assert.ok(first.fetched > 0);
  const callsAfterFirst = broker.calls.length;

  const second = await historyStore.load('EURUSD', 'M5', { years: 0.01, client: broker, accountId: 1, symbolId: 1 });
  assert.equal(second.fetched, 0, 'a cache that covers the window is not re-fetched');
  assert.equal(broker.calls.length, callsAfterFirst);
  assert.equal(second.bars.length, first.bars.length);
});

test('a shallow cache is extended backwards, not re-downloaded', async () => {
  const broker = fakeBroker(5000);
  const full = await historyStore.load('EURUSD', 'M5', { years: 0.01, client: broker, accountId: 1, symbolId: 1 });
  // Keep only the newest 100 bars, as if the cache had been written by a shallower run.
  await fs.writeJson(historyStore.fileFor('EURUSD', 'M5'), full.bars.slice(-100));
  const before = broker.calls.length;
  const grown = await historyStore.load('EURUSD', 'M5', { years: 0.01, client: broker, accountId: 1, symbolId: 1 });
  assert.ok(grown.fetched > 0, 'the missing older bars were fetched');
  assert.ok(grown.bars.length > 100, `cache grew to ${grown.bars.length} bars`);
  for (let i = 1; i < grown.bars.length; i++) assert.ok(grown.bars[i].time > grown.bars[i - 1].time, 'sorted, no duplicates');
  assert.ok(broker.calls.length > before);
});

test('the context frames are derived from the backtest series, so they line up with it', () => {
  const bars = Array.from({ length: 120 }, (_, i) => ({ time: i * 5 * MINUTE, open: 1, high: 1, low: 1, close: 1 }));
  const frames = deepBacktest.framesFor(bars, 'M5');
  assert.equal(frames.M5.length, 120, 'the base frame is the series itself');
  assert.equal(frames.M15.length, 40);
  assert.equal(frames.H1.length, 10);
});

// The engine hands each strategy a bounded window instead of the whole series. That is what makes a
// multi-year run possible, and it is only safe if no strategy's decision depends on bars older than it.
test('a 500-bar window gives every strategy the same decision as the whole history', () => {
  const history = Array.from({ length: 5000 }, (_, i) => {
    const price = 1.1 + Math.sin(i / 40) * 0.004 + Math.sin(i / 7) * 0.0008;
    return { time: i * MINUTE, open: price, high: price * 1.0004, low: price * 0.9996, close: price };
  });
  for (const name of listStrategies()) {
    const p = strategies[name].defaultParams || {};
    const full = strategies[name].generate(history, p);
    const windowed = strategies[name].generate(history.slice(-500), p);
    assert.equal(windowed.action, full.action, `${name}: same action`);
    assert.equal(windowed.reason, full.reason, `${name}: same reason`);
    assert.equal(windowed.score, full.score, `${name}: same score`);
  }
});

test('a long series backtests in linear time, not quadratic', () => {
  const history = Array.from({ length: 20000 }, (_, i) => {
    const price = 1.1 + Math.sin(i / 40) * 0.004;
    return { time: i * MINUTE, open: price, high: price * 1.0004, low: price * 0.9996, close: price };
  });
  const started = Date.now();
  const r = backtest.runBacktest('smaCrossover', {}, { history, dataSource: 'CTRADER_BARS' });
  const ms = Date.now() - started;
  assert.ok(!r.error, r.error);
  assert.ok(ms < 10000, `20,000 bars took ${ms}ms — the per-bar slice is no longer bounded`);
});

test('the model is told which timeframe a trade came from', () => {
  const ml = require('../src/intelligence/mlModel');
  const names = ml.featureNames();
  const i1 = names.indexOf('tf=M1'), i5 = names.indexOf('tf=M5');
  assert.ok(i1 >= 0 && i5 >= 0, 'both timeframes have a slot');
  const m1 = ml.vectorOf({ symbol: 'EURUSD', action: 'BUY', timeframe: 'M1', features: {} });
  const m5 = ml.vectorOf({ symbol: 'EURUSD', action: 'BUY', timeframe: 'M5', features: {} });
  assert.deepEqual([m1[i1], m1[i5]], [1, 0]);
  assert.deepEqual([m5[i1], m5[i5]], [0, 1]);
  // A live trade carries no timeframe because it is always M1.
  const live = ml.vectorOf({ symbol: 'EURUSD', action: 'BUY', features: {} });
  assert.equal(live[i1], 1);
});

test('a saved model trained on a different feature set is discarded, not used', async () => {
  const ml = require('../src/intelligence/mlModel');
  await fs.ensureDir(path.dirname(process.env.AIS_ML_MODEL_FILE));
  await fs.writeJson(process.env.AIS_ML_MODEL_FILE, {
    weights: [1, 2, 3], featureNames: ['old_a', 'old_b', 'old_c'], report: { active: true }
  });
  await ml.init();
  assert.equal(ml.status().active, false, 'a model whose features no longer match must not gate trades');
});

test.after(async () => { await fs.remove(TMP).catch(() => {}); });
