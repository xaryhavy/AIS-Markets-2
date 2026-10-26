const test = require('node:test');
const assert = require('node:assert/strict');
const b = require('../src/analytics/benchmarks');
const ownerReport = require('../src/reports/ownerReport');

const START = Date.UTC(2026, 0, 1);
const END = Date.UTC(2027, 0, 1);
const HOUR = 3600000;

// Hourly closes across the whole period, optionally with a hole.
function hourly({ from = START, to = END, startClose = 100, endClose = 110, holeFrom = null, holeTo = null } = {}) {
  const bars = [];
  const n = (to - from) / HOUR;
  for (let i = 0; i <= n; i++) {
    const t = from + i * HOUR;
    if (holeFrom !== null && t >= holeFrom && t < holeTo) continue;
    bars.push({ time: t, close: startClose + (endClose - startClose) * (i / n) });
  }
  return bars;
}

test('buy-and-hold is reported from full coverage, as close-to-close return', () => {
  const r = b.buyAndHold({ symbol: 'EURUSD', bars: hourly({ startClose: 100, endClose: 110 }), startMs: START, endMs: END });
  assert.equal(r.status, 'OK');
  assert.equal(r.returnPct, 10);
  assert.ok(r.coverage >= 0.95);
});

test('no history means "benchmark unavailable", never an estimate', () => {
  const r = b.buyAndHold({ symbol: 'EURUSD', bars: [], startMs: START, endMs: END });
  assert.equal(r.status, 'BENCHMARK UNAVAILABLE');
  assert.equal(r.returnPct, undefined);
});

test('history that starts or ends late is unavailable', () => {
  const late = hourly({ from: START + 60 * 24 * HOUR });
  assert.equal(b.buyAndHold({ symbol: 'X', bars: late, startMs: START, endMs: END }).status, 'BENCHMARK UNAVAILABLE');
  const early = hourly({ to: END - 60 * 24 * HOUR });
  assert.equal(b.buyAndHold({ symbol: 'X', bars: early, startMs: START, endMs: END }).status, 'BENCHMARK UNAVAILABLE');
});

test('a hole of more than 5% of the period makes the benchmark unavailable', () => {
  const holed = hourly({ holeFrom: START + 100 * 24 * HOUR, holeTo: START + 160 * 24 * HOUR });
  const r = b.buyAndHold({ symbol: 'X', bars: holed, startMs: START, endMs: END });
  assert.equal(r.status, 'BENCHMARK UNAVAILABLE');
  assert.match(r.reason, /covers/);
});

test('the benchmark section always carries the definition and a flat/cash baseline of 0%', () => {
  const s = b.build({ symbols: ['EURUSD', 'GBPUSD', 'EURUSD'], startMs: START, endMs: END, barsBySymbol: { EURUSD: hourly() } });
  assert.match(s.definition, /Buy-and-hold/);
  assert.match(s.definition, /Flat\/cash: 0% return/);
  assert.equal(s.flatCash.returnPct, 0);
  assert.equal(s.buyAndHold.length, 2, 'one line per traded instrument, no duplicates');
  assert.equal(s.buyAndHold.find(x => x.symbol === 'GBPUSD').status, 'BENCHMARK UNAVAILABLE');
  assert.equal(s.unavailableCount, 1);
});

test('a yearly owner report with no benchmark history says so, and is not estimated', () => {
  const trade = { id: 't1', source: 'ctrader', status: 'CLOSED', pnl: 5, symbol: 'EURUSD', closeTime: '2026-06-01T10:00:00Z' };
  const r = ownerReport.build({ period: 'yearly', now: new Date('2026-10-26T12:00:00Z'), trades: [trade], decisions: [], outcomes: [], intents: [], equity: [], snapshot: {} });
  assert.ok(r.benchmarks, 'the yearly report has a benchmark section');
  assert.equal(r.benchmarks.buyAndHold[0].status, 'BENCHMARK UNAVAILABLE');
  assert.ok(r.missingData.some(m => /Benchmarks: 1 buy-and-hold benchmark\(s\) unavailable/.test(m)));
  const md = ownerReport.toMarkdown(r);
  assert.match(md, /Buy-and-hold EURUSD: benchmark unavailable/);
});

test('the daily report carries no benchmark section', () => {
  const r = ownerReport.build({ period: 'daily', now: new Date('2026-10-26T12:00:00Z'), trades: [], decisions: [], outcomes: [], intents: [], equity: [], snapshot: {} });
  assert.equal(r.benchmarks, undefined);
});
