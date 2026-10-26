const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-monstate-'));
process.env.AIS_DATA_DIR = dir;
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const storage = require('../src/data/storage');
const marketData = require('../src/data/marketdata');
const nt = require('../src/governance/noTrade');

const T0 = Date.UTC(2026, 9, 27, 10, 0);
const MIN = 60000;
const c = (m, low, high) => ({ time: T0 + m * MIN, open: 1.1, high, low, close: 1.1 });
let candles = [];
marketData.getHistory = () => candles;

const decision = {
  id: 'DEC-LVL-1', timestamp: new Date(T0 + 30000).toISOString(), symbol: 'EURUSD', decision: 'SKIPPED', reasonCode: 'NOT_QUALIFIED',
  state: 'WAIT', regime: 'RANGING', strategy: 'x', horizonMinutes: 60,
  levels: { action: 'BUY', entry: 1.1, stopLoss: 1.09, takeProfit: 1.13 },
  entryType: 'LEVEL', entryLevel: 1.1, invalidationLevel: 1.095
};

test('a level opportunity is stored as PENDING_ENTRY while open, and updated in place when it resolves', async () => {
  await storage.save('decisions', [decision]);
  await storage.save('no_trade_outcomes', []);
  // Decision minute 10:00; at 10:05 no candle has touched the level yet.
  candles = [c(1, 1.105, 1.11), c(2, 1.105, 1.11)];
  await nt.runMonitor(T0 + 5 * MIN);
  let rows = await storage.load('no_trade_outcomes');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'PENDING_ENTRY');
  assert.equal(rows[0].entryType, 'LEVEL');

  // Later: candle 3 trades through 1.10, and candle 4 reaches the target. The same record is updated.
  candles = [c(1, 1.105, 1.11), c(2, 1.105, 1.11), c(3, 1.099, 1.101), c(4, 1.12, 1.135)];
  await nt.runMonitor(T0 + 10 * MIN);
  rows = await storage.load('no_trade_outcomes');
  assert.equal(rows.length, 1, 'updated in place, not duplicated');
  assert.equal(rows[0].status, 'TARGET_HIT');
  assert.equal(rows[0].entryRule, 'ENTRY_LEVEL_TOUCHED');
  assert.ok(Number.isFinite(rows[0].entryFill));
});

test('a market-style record gets a modelled fill and cost model, and no pending state', async () => {
  const mkt = { ...decision, id: 'DEC-MKT-1', entryType: undefined, entryLevel: undefined, invalidationLevel: undefined };
  await storage.save('decisions', [mkt]);
  await storage.save('no_trade_outcomes', []);
  candles = [c(1, 1.095, 1.105), c(2, 1.095, 1.135)];
  await nt.runMonitor(T0 + 10 * MIN);
  const rows = await storage.load('no_trade_outcomes');
  assert.equal(rows[0].status, 'TARGET_HIT');
  assert.equal(rows[0].entryFill, 1.1 + 0.00005);
  assert.equal(rows[0].costModel.halfSpread, 0.00005);
  assert.equal(rows[0].entryType, 'MARKET');
});

test('a level opportunity that is invalidated is stored once with its rule and time, and not repeated', async () => {
  const lvl = { ...decision, id: 'DEC-LVL-2' };
  await storage.save('decisions', [lvl]);
  await storage.save('no_trade_outcomes', []);
  candles = [c(1, 1.097, 1.099), c(2, 1.09, 1.099)];
  await nt.runMonitor(T0 + 10 * MIN);
  await nt.runMonitor(T0 + 11 * MIN);
  const rows = (await storage.load('no_trade_outcomes')).filter(r => r.decisionId === 'DEC-LVL-2');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'INVALIDATED');
  assert.equal(rows[0].rule, 'INVALIDATION_BREACHED_BEFORE_ENTRY');
  assert.equal(rows[0].at, new Date(T0 + 3 * MIN).toISOString());
});
