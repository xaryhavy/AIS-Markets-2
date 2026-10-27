const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-level-'));
process.env.AIS_DATA_DIR = dir;
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const storage = require('../src/data/storage');
const marketData = require('../src/data/marketdata');
const shadowTracker = require('../src/governance/shadowTracker');
const nt = require('../src/governance/noTrade');
const levelEntry = require('../src/governance/levelEntry');

const stopsFrom = (symbol, price, action) => ({ stopLoss: action === 'BUY' ? price - 0.0015 : price + 0.0015, takeProfit: action === 'BUY' ? price + 0.0045 : price - 0.0045 });
const signal = ec => ({ symbol: 'EURUSD', action: 'BUY', qualified: true, score: 60, entryCondition: ec });

test('a signal without an entry condition is market-style: nothing level-style is frozen', () => {
  assert.deepEqual(levelEntry.freeze({ symbol: 'EURUSD', action: 'BUY' }, { calculateStops: stopsFrom }), {});
});

test('a defined entry level freezes entry, invalidation, stop, target, window and expiry at decision time', () => {
  const f = levelEntry.freeze(signal({ type: 'LIMIT', level: 1.098, invalidation: 1.094, expiresAt: '2026-10-27T11:00:00Z' }), { calculateStops: stopsFrom, atr: 0.0005 });
  assert.equal(f.entryType, 'LEVEL');
  assert.equal(f.entryCondition.type, 'LIMIT');
  assert.equal(f.entryLevel, 1.098);
  assert.equal(f.invalidationLevel, 1.094);
  assert.equal(f.levels.entry, 1.098);
  assert.equal(f.levels.stopLoss, 1.098 - 0.0015, 'stop from the system rule at the entry level');
  assert.equal(f.levels.takeProfit, 1.098 + 0.0045);
  assert.equal(f.entryWindowCandles, 12, 'default window');
  assert.equal(f.evidenceExpiresAt, '2026-10-27T11:00:00.000Z');
});

test('the strategy\'s own stop, target and window are used when it defines them', () => {
  const f = levelEntry.freeze(signal({ type: 'RETEST', level: 1.1, invalidation: 1.096, stopLoss: 1.095, takeProfit: 1.115, windowCandles: 5 }), { calculateStops: stopsFrom });
  assert.equal(f.levels.stopLoss, 1.095);
  assert.equal(f.levels.takeProfit, 1.115);
  assert.equal(f.entryWindowCandles, 5);
});

test('no defined entry level is not evaluable, and no level is invented', () => {
  const f = levelEntry.freeze(signal({ type: 'LIMIT', invalidation: 1.09 }), { calculateStops: stopsFrom });
  assert.equal(f.entryType, 'LEVEL');
  assert.equal(f.entryLevel, null);
  assert.equal(f.levels, null);
  assert.match(f.notEvaluableReason, /no defined entry level/);
});

test('an unknown entry type, or an invalidation level missing or on the wrong side, is not evaluable', () => {
  assert.match(levelEntry.freeze(signal({ type: 'MARKET', level: 1.1, invalidation: 1.09 }), { calculateStops: stopsFrom }).notEvaluableReason, /LIMIT, STOP or RETEST/);
  assert.match(levelEntry.freeze(signal({ type: 'STOP', level: 1.1 }), { calculateStops: stopsFrom }).notEvaluableReason, /invalidation/);
  assert.match(levelEntry.freeze(signal({ type: 'STOP', level: 1.1, invalidation: 1.11 }), { calculateStops: stopsFrom }).notEvaluableReason, /wrong side/);
});

test('the frozen values do not change when the signal is changed afterwards', () => {
  const s = signal({ type: 'LIMIT', level: 1.098, invalidation: 1.094 });
  const f = levelEntry.freeze(s, { calculateStops: stopsFrom });
  s.entryCondition.level = 1.2;
  s.entryCondition.invalidation = 1.0;
  assert.equal(f.entryLevel, 1.098);
  assert.equal(f.invalidationLevel, 1.094);
  assert.equal(f.levels.entry, 1.098);
});

test('the decision record stores the frozen level-style fields, and level-style repeats are never collapsed', async () => {
  await storage.save('decisions', []);
  await storage.save('no_trade_outcomes', []);
  marketData.getPrice = () => 1.1;
  const s = signal({ type: 'LIMIT', level: 1.098, invalidation: 1.094 });
  Object.assign(s, levelEntry.freeze(s, { calculateStops: stopsFrom }));
  await shadowTracker.recordDecision(s, { decision: 'SKIPPED', reason: 'Data quality: gap' });
  await shadowTracker.recordDecision(s, { decision: 'SKIPPED', reason: 'Data quality: gap' });
  const rows = await storage.load('decisions');
  assert.equal(rows.length, 2, 'each level-style opportunity keeps its own record');
  assert.equal(rows[0].entryType, 'LEVEL');
  assert.equal(rows[0].entryLevel, 1.098);
  assert.equal(rows[0].invalidationLevel, 1.094);
  assert.equal(rows[0].entryCondition.type, 'LIMIT');
  assert.equal(rows[0].entryWindowCandles, 12);
  assert.equal((await storage.load('no_trade_outcomes')).length, 0, 'no collapsed pending record');
});

test('a level-style decision with no defined level is resolved as NOT_EVALUABLE by the monitor, with the reason', async () => {
  const s = signal({ type: 'LIMIT', invalidation: 1.09 });
  Object.assign(s, levelEntry.freeze(s, { calculateStops: stopsFrom }));
  await storage.save('decisions', []);
  await storage.save('no_trade_outcomes', []);
  await shadowTracker.recordDecision(s, { decision: 'SKIPPED', reason: 'Data quality: gap' });
  marketData.getHistory = () => [];
  await nt.runMonitor(Date.now());
  const out = await storage.load('no_trade_outcomes');
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'NOT_EVALUABLE');
});

test('the resolver refuses a level-style record without an invalidation level', () => {
  const r = nt.resolveOutcome({ timestamp: new Date().toISOString(), entryType: 'LEVEL', entryLevel: 1.1, levels: { action: 'BUY', entry: 1.1, stopLoss: 1.09, takeProfit: 1.13 } }, [], Date.now());
  assert.equal(r.status, 'NOT_EVALUABLE');
});
