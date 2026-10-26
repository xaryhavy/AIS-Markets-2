const test = require('node:test');
const assert = require('node:assert/strict');
const { CLASSES, classifyTrade } = require('../src/analytics/evidence');
const ev = require('../src/analytics/evaluation');

const trade = (i, pnl, extra = {}) => ({
  id: 't' + i, source: 'ctrader', status: 'CLOSED', pnl,
  closeTime: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString(), ...extra
});

test('evidence classes: broker results, estimates, fault tests, legacy and hypothetical are kept apart', () => {
  assert.equal(classifyTrade(trade(1, 5)), CLASSES.BROKER_DEMO_EXACT);
  assert.equal(classifyTrade(trade(1, 5, { pnlEstimated: true })), CLASSES.BROKER_DEMO_ESTIMATED);
  assert.equal(classifyTrade(trade(1, 5, { closeReason: 'Fault-injection test close' })), CLASSES.FAULT_TEST);
  assert.equal(classifyTrade({ source: 'paper', pnl: 5 }), CLASSES.SIMULATED_LEGACY);
});

test('evaluation uses exact broker results only, never estimates, fault tests or simulated trades', () => {
  const rows = [trade(1, 10), trade(2, -5), trade(3, 99, { pnlEstimated: true }), trade(4, 99, { closeReason: 'Fault-injection test close' }), { source: 'paper', status: 'CLOSED', pnl: 99, closeTime: trade(5, 0).closeTime }];
  const r = ev.evaluate(rows);
  assert.equal(r.sampleSize, 2);
  assert.equal(r.netPnl, 5);
});

test('a small sample is flagged and no conclusion is drawn', () => {
  const r = ev.evaluate([trade(1, 10), trade(2, 10)]);
  assert.equal(r.sufficientSample, false);
  assert.match(r.flag, /insufficient sample/);
});

test('costs reduce every trade, and the output says which cost was assumed', () => {
  const rows = Array.from({ length: 40 }, (_, i) => trade(i, i % 2 ? 4 : -2));
  const free = ev.evaluate(rows);
  const costly = ev.evaluate(rows, { costPerTrade: 1 });
  assert.equal(costly.expectancy, free.expectancy - 1);
  assert.match(free.costAssumption, /no extra cost modelled/);
  assert.match(costly.costAssumption, /extra cost 1 per trade/);
});

test('expectancy, profit factor, win rate and drawdown are computed from the net sequence', () => {
  const rows = [trade(1, 10), trade(2, -4), trade(3, -4), trade(4, 10)];
  const r = ev.evaluate(rows);
  assert.equal(r.sampleSize, 4);
  assert.equal(r.winRate, 0.5);
  assert.equal(r.expectancy, 3);
  assert.equal(r.profitFactor, 20 / 8);
  assert.equal(r.averageWin, 10);
  assert.equal(r.averageLoss, 4);
  assert.equal(r.maxDrawdown, 8);
});

test('out-of-sample split is chronological: the held-back part is the latest trades', () => {
  const rows = Array.from({ length: 50 }, (_, i) => trade(i, i < 35 ? 3 : -3));
  const r = ev.outOfSample(rows, { trainFraction: 0.7 });
  assert.equal(r.inSample.sampleSize, 35);
  assert.equal(r.outOfSample.sampleSize, 15);
  assert.ok(r.expectancyChange < 0, 'the later period is worse');
  assert.equal(r.split, 'chronological');
});

test('input order does not matter: trades are sorted by close time before splitting', () => {
  const rows = Array.from({ length: 40 }, (_, i) => trade(i, i % 3 ? 2 : -1));
  const a = ev.outOfSample(rows);
  const b = ev.outOfSample([...rows].reverse());
  assert.deepEqual(a.inSample, b.inSample);
  assert.deepEqual(a.outOfSample, b.outOfSample);
});

test('multiple testing: the threshold tightens with the number of strategies tried', () => {
  const rows = Array.from({ length: 60 }, (_, i) => trade(i, i % 4 === 0 ? -1 : 1.5));
  const r = ev.evaluate(rows);
  const one = ev.significanceAfterMultipleTesting(r, 1);
  const many = ev.significanceAfterMultipleTesting(r, 50);
  assert.ok(many.zNeeded > one.zNeeded);
  assert.equal(many.adjustedAlpha, 0.05 / 50);
});

test('a result with too few trades never clears the significance threshold', () => {
  const r = ev.evaluate([trade(1, 10), trade(2, 12)]);
  assert.equal(ev.significanceAfterMultipleTesting(r, 1).clearsThreshold, false);
});
