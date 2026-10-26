const test = require('node:test');
const assert = require('node:assert/strict');
const ml = require('../src/intelligence/mlModel');

// Deterministic trades. Buying in a rising regime wins; everything else loses.
function samples(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const regime = i % 2 === 0 ? 'TRENDING_UP' : 'RANGING';
    const action = i % 3 === 0 ? 'SELL' : 'BUY';
    const win = regime === 'TRENDING_UP' && action === 'BUY';
    out.push({
      symbol: 'EURUSD', action,
      features: { regime, hourUtc: i % 24, dayOfWeek: i % 7, strategy: 'smaCrossover', patterns: [], mtf: { M5: 'UP', M15: 'UP', H1: 'UP' } },
      pnl: win ? 30 : -10,
      openTime: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString()
    });
  }
  return out;
}

test('the feature vector has a fixed length for every trade', () => {
  const a = ml.vectorOf(samples(1)[0]);
  const b = ml.vectorOf({ symbol: 'BTCUSD', action: 'SELL', features: {} });
  assert.equal(a.length, b.length);
  assert.equal(a.length, ml.featureNames().length);
});

test('logistic regression learns a separable rule', () => {
  const data = samples(400);
  const w = ml.train(data.map(ml.vectorOf), data.map(t => (t.pnl > 0 ? 1 : 0)));
  const winner = data.find(t => t.pnl > 0);
  const loser = data.find(t => t.pnl < 0);
  assert.ok(ml.sigmoid(w.reduce((s, wi, j) => s + wi * ml.vectorOf(winner)[j], 0)) > 0.8);
  assert.ok(ml.sigmoid(w.reduce((s, wi, j) => s + wi * ml.vectorOf(loser)[j], 0)) < 0.2);
});

test('a model that picks out a real edge on held-back trades is activated', () => {
  const report = ml.validate(samples(600));
  assert.equal(report.active, true);
  assert.ok(report.selected.n >= 20);
  assert.ok(report.selected.avgPnl > report.testAll.avgPnl);
});

test('unusable trades are dropped before training', () => {
  const usable = ml.usable([{ pnl: 5, openTime: '2026-01-01T00:00:00Z', symbol: 'EURUSD', action: 'BUY' }, ...samples(3)]);
  assert.equal(usable.length, 3);
});
