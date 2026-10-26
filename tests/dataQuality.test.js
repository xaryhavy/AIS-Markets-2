const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/data/quality');
const marketData = require('../src/data/marketdata');

const NOW = Date.UTC(2026, 9, 25, 10, 0, 30); // 10:00:30 — the 10:00 M1 candle is still forming

// n completed candles of `tf` ending with the last one that closed before NOW.
function series(tf, n, { endAt = NOW, price = 1.1, gapAt = null } = {}) {
  const step = q.PERIOD_MS[tf];
  const last = Math.floor(endAt / step) * step - step; // newest candle whose period ended
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = last - i * step;
    if (gapAt !== null && t === gapAt) continue;
    out.push({ time: t, open: price, high: price + 0.0002, low: price - 0.0002, close: price + 0.0001 });
  }
  return out;
}

test('a well-formed candle is valid', () => {
  assert.equal(q.isValid({ time: 60000, open: 1, high: 1.2, low: 0.9, close: 1.1 }, 60000), true);
});

test('impossible candles are rejected', () => {
  const p = 60000;
  assert.equal(q.isValid({ time: 60000, open: 1, high: 0.9, low: 0.8, close: 0.95 }, p), false, 'high below open');
  assert.equal(q.isValid({ time: 60000, open: 1, high: 1.2, low: 1.1, close: 1.05 }, p), false, 'low above close');
  assert.equal(q.isValid({ time: 60000, open: 1, high: 1.2, low: 0.9, close: NaN }, p), false, 'NaN');
  assert.equal(q.isValid({ time: 60000, open: 0, high: 1.2, low: 0.9, close: 1 }, p), false, 'zero price');
  assert.equal(q.isValid({ time: 60001, open: 1, high: 1.2, low: 0.9, close: 1 }, p), false, 'not on a period boundary');
  assert.equal(q.isValid({ time: 60000, open: '1', high: 1.2, low: 0.9, close: 1 }, p), false, 'string price');
});

test('duplicates keep the first candle and are counted', () => {
  const a = { time: 60000, open: 1, high: 1.2, low: 0.9, close: 1.1 };
  const v = q.validateBars([a, { ...a, close: 1.15 }], 'M1', 10 * 60000);
  assert.equal(v.issues.duplicates, 1);
  assert.equal(v.bars[0].close, 1.1);
});

test('out-of-order candles are sorted', () => {
  const bars = series('M1', 5);
  const v = q.validateBars([...bars].reverse(), 'M1', NOW);
  assert.deepEqual(v.bars.map(b => b.time), bars.map(b => b.time));
});

test('forming and future candles are never used for analysis', () => {
  const forming = { time: Math.floor(NOW / 60000) * 60000, open: 1, high: 1.2, low: 0.9, close: 1.1 }; // 10:00 forming
  const future = { time: forming.time + 60000, open: 1, high: 1.2, low: 0.9, close: 1.1 };
  const v = q.validateBars([...series('M1', 3), forming, future], 'M1', NOW);
  assert.equal(v.issues.incomplete, 1);
  assert.equal(v.issues.future, 1);
  assert.ok(v.bars.every(b => b.time + 60000 <= NOW));
});

test('gaps between completed candles are counted with the missing count', () => {
  const bars = series('M1', 10, { gapAt: null });
  bars.splice(4, 2); // remove two consecutive candles
  const v = q.validateBars(bars, 'M1', NOW);
  assert.equal(v.issues.gaps, 1);
  assert.equal(v.issues.missingBars, 2);
});

test('the fingerprint changes when any used candle changes, and not otherwise', () => {
  const bars = series('M1', 25);
  const a = q.validateBars(bars, 'M1', NOW).fingerprint;
  assert.equal(a, q.validateBars(bars.map(b => ({ ...b })), 'M1', NOW).fingerprint, 'same data, same fingerprint');
  const changed = bars.map((b, i) => (i === bars.length - 1 ? { ...b, close: b.close + 0.0001 } : b));
  assert.notEqual(a, q.validateBars(changed, 'M1', NOW).fingerprint);
});

function loadClean() {
  marketData.setBars('EURUSD', series('M1', 120), 'M1');
  marketData.setBars('EURUSD', series('M5', 120, { endAt: NOW }), 'M5');
  marketData.setBars('EURUSD', series('M15', 120, { endAt: NOW }), 'M15');
  marketData.setBars('EURUSD', series('H1', 120, { endAt: NOW }), 'H1');
}

test('clean, current data is assessed as usable', () => {
  loadClean();
  const a = q.assess('EURUSD', NOW);
  assert.equal(a.ok, true, a.reasons.join('; '));
});

test('stale M1 data blocks analysis', () => {
  marketData.setBars('EURUSD', series('M1', 120, { endAt: NOW - 10 * 60000 }), 'M1');
  const a = q.assess('EURUSD', NOW);
  assert.equal(a.ok, false);
  assert.ok(a.reasons.some(r => /M1: newest completed candle is \d+ min old/.test(r)));
});

test('a gap in the recent M1 candles blocks analysis', () => {
  marketData.setBars('EURUSD', series('M1', 120, { gapAt: Math.floor(NOW / 60000) * 60000 - 5 * 60000 }), 'M1');
  const a = q.assess('EURUSD', NOW);
  assert.equal(a.ok, false);
  assert.ok(a.reasons.some(r => /gap/.test(r)));
});

test('an analysis expires after the time-to-live', () => {
  assert.equal(q.isExpired({ assessedAt: NOW }, NOW + 10000), false);
  assert.equal(q.isExpired({ assessedAt: NOW }, NOW + q.ANALYSIS_TTL_MS + 1), true);
});
