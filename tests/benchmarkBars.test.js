const test = require('node:test');
const assert = require('node:assert/strict');
const bars = require('../src/analytics/benchmarkBars');
const benchmarks = require('../src/analytics/benchmarks');

const HOUR = 3600000;
// The loader asks the broker up to the real clock, so the test clock is the real current hour.
const NOW = Math.floor(Date.now() / 3600000) * 3600000;
const PRICE_SCALE = 100000;

// Broker encoding: minutes since epoch, low and deltas in 1/100000 price units.
function brokerBar(tMs, close) {
  const low = Math.round(close * PRICE_SCALE) - 50;
  return { utcTimestampInMinutes: Math.floor(tMs / 60000), low, deltaOpen: 0, deltaHigh: 100, deltaClose: 50 };
}

// A fake broker holding hourly bars from `from` to `to`, serving requests the way the broker does.
function fakeClient(from, to, closeAt = t => 1 + (t - from) / (to - from) * 0.1) {
  const all = [];
  for (let t = from; t <= to; t += HOUR) all.push({ t, close: closeAt(t) });
  return {
    getTrendbars: async ({ count, toTimestamp }) => {
      return all.filter(b => b.t <= toTimestamp).slice(-count).map(b => brokerBar(b.t, b.close));
    }
  };
}

test('hourly bars are loaded and only completed bars are kept', async () => {
  const from = NOW - 48 * HOUR;
  const client = fakeClient(from, NOW);
  const out = await bars.loadHourly({ client, accountId: 1, symbolId: 1, hours: 48, now: NOW });
  assert.ok(out.length >= 40, `got ${out.length} bars`);
  for (const b of out) {
    assert.ok(b.time + HOUR <= NOW, 'every bar is completed');
    assert.ok(Number.isFinite(b.close));
  }
});

test('a broker failure gives no bars, which the benchmark reports as unavailable, never an estimate', async () => {
  const client = { getTrendbars: async () => { throw new Error('timeout'); } };
  const out = await bars.loadHourly({ client, accountId: 1, symbolId: 1, hours: 48, now: NOW });
  assert.deepEqual(out, []);
  const r = benchmarks.buyAndHold({ symbol: 'EURUSD', bars: out, startMs: NOW - 48 * HOUR, endMs: NOW });
  assert.equal(r.status, 'BENCHMARK UNAVAILABLE');
});

test('a symbol the broker does not offer is unavailable, not guessed', async () => {
  const out = await bars.loadForSymbols({ client: fakeClient(NOW - 48 * HOUR, NOW), accountId: 1, symbols: ['NOSUCH'], hours: 48, now: NOW, getInfo: () => null });
  assert.deepEqual(out.NOSUCH, []);
});

test('a loaded two-day history gives a buy-and-hold only for the period it covers; a year is unavailable', async () => {
  const from = NOW - 48 * HOUR;
  const client = fakeClient(from, NOW);
  const twoDays = await bars.loadHourly({ client, accountId: 1, symbolId: 1, hours: 48, now: NOW });
  const twoDayReturn = benchmarks.buyAndHold({ symbol: 'EURUSD', bars: twoDays, startMs: from, endMs: NOW });
  assert.equal(twoDayReturn.status, 'OK');
  const year = benchmarks.buyAndHold({ symbol: 'EURUSD', bars: twoDays, startMs: NOW - 365 * 24 * HOUR, endMs: NOW });
  assert.equal(year.status, 'BENCHMARK UNAVAILABLE', 'two days of history do not cover a year');
});
