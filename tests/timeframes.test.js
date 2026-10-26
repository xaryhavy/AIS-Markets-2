const test = require('node:test');
const assert = require('node:assert/strict');
const tf = require('../src/intelligence/timeframes');

const series = (n, step) => Array.from({ length: n }, (_, i) => ({ time: i * 60000, open: 1, high: 1, low: 1, close: 1 + i * step }));

test('a steadily rising series is an UP trend', () => {
  assert.equal(tf.trendOf(series(120, 0.001)), 'UP');
});

test('a steadily falling series is a DOWN trend', () => {
  assert.equal(tf.trendOf(series(120, -0.001)), 'DOWN');
});

test('a flat series is FLAT', () => {
  assert.equal(tf.trendOf(series(120, 0)), 'FLAT');
});

test('too little history gives no trend rather than a guess', () => {
  assert.equal(tf.trendOf(series(30, 0.001)), null);
});

test('a bar that has not closed yet is excluded', () => {
  const bars = [{ time: 0 }, { time: 60000 }, { time: 120000 }];
  // At 150s, the bar starting at 120s (1 minute long) has not ended.
  const done = tf.completedBars(bars, 1, 150000);
  assert.deepEqual(done.map(b => b.time), [0, 60000]);
});

test('trades are allowed only when the higher frames confirm and do not oppose', () => {
  assert.equal(tf.allows({ M5: 'UP', M15: 'UP', H1: 'UP' }, 'BUY'), true);
  assert.equal(tf.allows({ M5: 'DOWN', M15: 'UP', H1: 'FLAT' }, 'BUY'), true);
  assert.equal(tf.allows({ M5: 'UP', M15: 'DOWN', H1: 'UP' }, 'BUY'), false, 'M15 opposes');
  assert.equal(tf.allows({ M5: 'UP', M15: 'FLAT', H1: 'DOWN' }, 'BUY'), false, 'H1 opposes');
  assert.equal(tf.allows({ M5: 'UP', M15: 'FLAT', H1: 'FLAT' }, 'BUY'), false, 'nothing confirms');
  assert.equal(tf.allows({ M5: 'DOWN', M15: 'DOWN', H1: 'DOWN' }, 'SELL'), true);
  assert.equal(tf.allows({ M5: 'UP', M15: 'UP', H1: null }, 'BUY'), false, 'unknown H1');
});

test('agreement is signed per frame', () => {
  assert.deepEqual(tf.signedAgreement({ M5: 'UP', M15: 'DOWN', H1: 'FLAT' }, 'BUY'), { M5: 1, M15: -1, H1: 0 });
});
