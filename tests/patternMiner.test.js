const test = require('node:test');
const assert = require('node:assert/strict');
const miner = require('../src/intelligence/patternMiner');

// Deterministic pseudo-random numbers so the test data never changes between runs.
function rng(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function trades(n, plant) {
  const r = rng(42);
  const out = [];
  for (let i = 0; i < n; i++) {
    const inEarly = i < n * 0.7;
    const pattern = i % 3 === 0 ? 'Bullish Engulfing' : 'Doji';
    const regime = i % 2 === 0 ? 'RANGING' : 'TRENDING_UP';
    const features = { regime, hourUtc: i % 24, dayOfWeek: i % 7, strategy: 'rsi', patterns: [pattern] };
    const planted = plant(i, inEarly, pattern, regime);
    const win = planted !== null ? planted : r() < 0.45;
    out.push({
      symbol: 'EURUSD', action: 'BUY', features,
      pnl: win ? 10 : -10,
      openTime: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString()
    });
  }
  return out;
}

test('a rule that holds early and late is proposed', () => {
  // Bullish Engulfing in RANGING wins 80% of the time, both early and late.
  const data = trades(600, (i, early, pattern, regime) => (pattern === 'Bullish Engulfing' && regime === 'RANGING') ? (i % 5) !== 0 : null);
  const rules = miner.findRules(data);
  assert.ok(rules.some(r => r.key.includes('pattern=Bullish Engulfing')), 'expected an engulfing rule');
});

test('a rule that only holds early is not proposed', () => {
  // Engulfing wins early and loses late: the out-of-sample check must reject it.
  const data = trades(600, (i, early, pattern) => pattern === 'Bullish Engulfing' ? early : null);
  const rules = miner.findRules(data);
  assert.equal(rules.some(r => r.tokens.includes('pattern=Bullish Engulfing') && r.tokens.length === 1), false);
});

test('trades without features or pnl are ignored', () => {
  const junk = [{ symbol: 'EURUSD', action: 'BUY', pnl: 5, openTime: '2026-01-01T00:00:00Z' }, { symbol: 'EURUSD', action: 'BUY', features: {}, openTime: '2026-01-01T00:00:00Z' }];
  assert.deepEqual(miner.findRules(junk), []);
});

test('situation tokens describe the trade', () => {
  const tokens = miner.tokensOf({ symbol: 'USDJPY', action: 'SELL', features: { regime: 'RANGING', hourUtc: 14, dayOfWeek: 2, strategy: 'macd', patterns: ['Doji'] } });
  for (const t of ['regime=RANGING', 'hour=14', 'day=2', 'strategy=macd', 'pattern=Doji', 'symbol=USDJPY', 'action=SELL']) {
    assert.ok(tokens.includes(t), `missing ${t}`);
  }
});
