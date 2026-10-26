const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-gate-'));
process.env.AIS_DATA_DIR = dir;
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const storage = require('../src/data/storage');
const sessions = require('../src/data/sessions');
const q = require('../src/data/quality');
const marketData = require('../src/data/marketdata');

const MIN = 60000;
const utc = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h, mi);

// M1 candles from start to end (inclusive of the last completed minute), skipping the given minute stamps.
function m1(start, end, skip = new Set()) {
  const out = [];
  for (let t = start; t <= end; t += MIN) {
    if (skip.has(t)) continue;
    out.push({ time: t, open: 1.1, high: 1.1005, low: 1.0995, close: 1.1 });
  }
  return out;
}

test('the session calendar: FX closed Friday evening to Sunday evening, open on weekdays, BTC around the clock', () => {
  assert.equal(sessions.isOpen('EURUSD', utc(2026, 10, 27, 10, 0)), true, 'Tuesday');
  assert.equal(sessions.isOpen('EURUSD', utc(2026, 10, 23, 21, 0)), true, 'Friday before the close');
  assert.equal(sessions.isOpen('EURUSD', utc(2026, 10, 23, 23, 0)), false, 'Friday evening');
  assert.equal(sessions.isOpen('EURUSD', utc(2026, 10, 24, 12, 0)), false, 'Saturday');
  assert.equal(sessions.isOpen('EURUSD', utc(2026, 10, 25, 21, 0)), false, 'Sunday before the reopen');
  assert.equal(sessions.isOpen('EURUSD', utc(2026, 10, 25, 23, 0)), true, 'Sunday after the reopen');
  assert.equal(sessions.isOpen('BTCUSD', utc(2026, 10, 24, 12, 0)), true, 'BTC on Saturday');
});

test('a gap over the weekend closure is not a missing candle', () => {
  // The reopen minute (Sunday 22:00) is an open minute, so the gap ends at the reopen candle itself.
  const fri = utc(2026, 10, 23, 21, 59), sun = utc(2026, 10, 25, 22, 0);
  assert.equal(sessions.unexplainedMissing('EURUSD', fri, sun, MIN), 0);
});

test('a gap on a weekday is a missing candle, counted per missing minute', () => {
  const a = utc(2026, 10, 27, 10, 0), b = utc(2026, 10, 27, 10, 4);
  assert.equal(sessions.unexplainedMissing('EURUSD', a, b, MIN), 3);
});

test('a gap during a configured closure is excused; a gap on BTC on Saturday is not', () => {
  const a = utc(2026, 10, 27, 10, 0), b = utc(2026, 10, 27, 10, 4);
  sessions.setExtraClosures('GBPUSD', [{ fromMs: a, toMs: b, note: 'broker maintenance' }]);
  assert.equal(sessions.unexplainedMissing('GBPUSD', a, b, MIN), 0);
  assert.equal(sessions.unexplainedMissing('BTCUSD', utc(2026, 10, 24, 12, 0), utc(2026, 10, 24, 12, 3), MIN), 2);
});

test('the tolerance must be a whole number from 0 to 20, and defaults to zero', () => {
  assert.equal(q.getGapTolerance(), 0);
  for (const bad of [-1, 21, 1.5, '1', NaN]) assert.throws(() => q.validTolerance(bad), /gap tolerance must be a whole number/, `rejects ${bad}`);
  assert.equal(q.validTolerance(2), 2);
});

test('one missing candle inside the M1 lookback blocks the symbol at zero tolerance, with a reason code', () => {
  const WEEKDAY = utc(2026, 10, 27, 10, 0);
  const missing = WEEKDAY - 5 * MIN;
  marketData.setBars('EURUSD', m1(WEEKDAY - 120 * MIN, WEEKDAY - MIN, new Set([missing])), 'M1');
  const a = q.assess('EURUSD', WEEKDAY + 30000);
  assert.equal(a.ok, false);
  assert.ok(a.reasonCodes.includes('DATA_GAP'));
  assert.match(a.reasons.find(r => /gap/.test(r)), /tolerance 0/);
});

test('the same gap is allowed when the tolerance is raised to one', async () => {
  const WEEKDAY = utc(2026, 10, 27, 10, 0);
  const missing = WEEKDAY - 5 * MIN;
  marketData.setBars('EURUSD', m1(WEEKDAY - 120 * MIN, WEEKDAY - MIN, new Set([missing])), 'M1');
  await q.setGapTolerance(1, 'owner');
  try {
    const a = q.assess('EURUSD', WEEKDAY + 30000);
    assert.equal(a.reasonCodes.includes('DATA_GAP'), false, 'gap check passes with the tolerance raised');
    assert.equal(q.getGapTolerance(), 1);
  } finally {
    await q.setGapTolerance(0, 'owner');
  }
});

test('a gap over a scheduled closure never blocks, even inside the lookback', () => {
  // Sunday evening reopen: the lookback has no missing candle that is a weekday candle.
  const reopen = utc(2026, 10, 25, 22, 0);
  marketData.setBars('EURUSD', m1(reopen - 40 * MIN, reopen + 20 * MIN), 'M1');
  const a = q.assess('EURUSD', reopen + 25 * MIN);
  assert.equal(a.reasonCodes.includes('DATA_GAP'), false);
});

test('staleness always blocks, including on a closed market (the calendar excuses gaps, never old data)', () => {
  const sun = utc(2026, 10, 25, 12, 0);
  marketData.setBars('EURUSD', m1(sun - 300 * MIN, sun - 200 * MIN), 'M1');
  const a = q.assess('EURUSD', sun);
  assert.equal(a.ok, false);
  assert.ok(a.reasonCodes.includes('DATA_STALE'));
});

test('each block episode is logged once with its codes, and closed with the cycle count when it clears', async () => {
  const t0 = utc(2026, 10, 27, 10, 0);
  const blocked = { symbol: 'USDJPY', ok: false, reasons: ['M1: 1 gap(s)'], reasonCodes: ['DATA_GAP'] };
  await q.recordEpisode(blocked, t0);
  await q.recordEpisode(blocked, t0 + MIN);
  await q.recordEpisode(blocked, t0 + 2 * MIN);
  await q.recordEpisode({ ...blocked, ok: true, reasonCodes: [] }, t0 + 3 * MIN);
  const rows = (await storage.load(q.GATE_BLOCKS)).filter(r => r.symbol === 'USDJPY');
  assert.equal(rows.length, 1, 'one record for the episode, not one per cycle');
  assert.equal(rows[0].codes, 'DATA_GAP');
  assert.equal(rows[0].cycles, 3);
  assert.ok(rows[0].endedAt, 'closed when the symbol cleared');
});
