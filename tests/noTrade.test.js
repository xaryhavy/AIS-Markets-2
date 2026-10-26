const test = require('node:test');
const assert = require('node:assert/strict');
const nt = require('../src/governance/noTrade');
const rep = require('../src/reports/reportGenerator');

const T0 = '2026-10-26T10:00:30Z';                 // decision made inside the 10:00 candle
const M = t => Date.parse(t);
const candle = (time, o, h, l, c) => ({ time, open: o, high: h, low: l, close: c });
const buy = { timestamp: T0, horizonMinutes: 60, levels: { action: 'BUY', entry: 1.1, stopLoss: 1.097, takeProfit: 1.109 } };
const sell = { timestamp: T0, horizonMinutes: 60, levels: { action: 'SELL', entry: 1.1, stopLoss: 1.103, takeProfit: 1.091 } };
const NOW = M('2026-10-26T12:00:00Z');

// Full coverage of the horizon, flat unless overridden.
function run(dec, overrides = {}, nowMs = NOW) {
  const base = [];
  for (let t = M('2026-10-26T10:01:00Z'); t < M('2026-10-26T11:01:00Z'); t += 60000) base.push(candle(t, 1.1, 1.1001, 1.0999, 1.1));
  const byTime = new Map(base.map(c => [c.time, c]));
  for (const [t, c] of Object.entries(overrides)) byTime.set(Number(t), c);
  return nt.resolveOutcome(dec, [...byTime.values()], nowMs);
}

test('reasons map to stable codes; unknown text is OTHER, not hidden', () => {
  assert.equal(nt.reasonCode('Data quality: M1 gap'), 'DATA_QUALITY');
  assert.equal(nt.reasonCode('Reward to risk 2.00 below 1:3'), 'RR_FLOOR');
  assert.equal(nt.reasonCode('Max 3 positions reached'), 'RISK_ADMISSION');
  assert.equal(nt.reasonCode('Exposure limit: 9999 would exceed 2000'), 'RISK_ADMISSION');
  assert.equal(nt.reasonCode(null, false), 'NOT_QUALIFIED');
  assert.equal(nt.reasonCode('something new entirely'), 'OTHER');
});

test('states: temporary conditions are WAIT; rule rejections are NO_TRADE; executions are TRADE', () => {
  assert.equal(nt.stateFor('EXECUTED', 'EXECUTED'), 'TRADE');
  assert.equal(nt.stateFor('SKIPPED', 'DATA_QUALITY'), 'WAIT');
  assert.equal(nt.stateFor('SKIPPED', 'NOT_QUALIFIED'), 'WAIT');
  assert.equal(nt.stateFor('SKIPPED', 'RR_FLOOR'), 'NO_TRADE');
  assert.equal(nt.stateFor('SKIPPED', 'RISK_ADMISSION'), 'NO_TRADE');
});

test('legacy records (decision stored as an object) are read correctly and flagged, not rewritten', () => {
  const legacy = { id: 'L1', decision: { decision: 'SKIPPED', reason: 'Max 3 positions reached' } };
  const n = nt.normalizeDecision(legacy);
  assert.equal(n.decision, 'SKIPPED');
  assert.equal(n.skipReason, 'Max 3 positions reached');
  assert.equal(n.legacy, true);
  assert.deepEqual(legacy.decision, { decision: 'SKIPPED', reason: 'Max 3 positions reached' }, 'original untouched');
  assert.equal(nt.normalizeDecision({ id: 'N', decision: 'SKIPPED' }).legacy, false);
});

test('a buy that reaches its target is TARGET_HIT at the frozen target price', () => {
  const r = run(buy, { [M('2026-10-26T10:05:00Z')]: candle(M('2026-10-26T10:05:00Z'), 1.1, 1.11, 1.1, 1.109) });
  assert.equal(r.status, 'TARGET_HIT');
  assert.equal(r.exitPrice, 1.109);
});

test('a sell that reaches its stop is STOP_HIT at the frozen stop price', () => {
  const r = run(sell, { [M('2026-10-26T10:03:00Z')]: candle(M('2026-10-26T10:03:00Z'), 1.1, 1.104, 1.1, 1.103) });
  assert.equal(r.status, 'STOP_HIT');
  assert.equal(r.exitPrice, 1.103);
});

test('a candle touching both stop and target is AMBIGUOUS and never guessed', () => {
  const r = run(buy, { [M('2026-10-26T10:04:00Z')]: candle(M('2026-10-26T10:04:00Z'), 1.1, 1.12, 1.09, 1.1) });
  assert.equal(r.status, 'AMBIGUOUS');
  assert.equal(r.exitPrice, undefined);
});

test('no look-ahead: the candle the decision was made in is never used', () => {
  // A spike inside the 10:00 candle (the decision candle) must not resolve the decision.
  const r = run(buy, { [M('2026-10-26T10:00:00Z')]: candle(M('2026-10-26T10:00:00Z'), 1.1, 1.12, 1.09, 1.1) });
  assert.notEqual(r.status, 'TARGET_HIT');
  assert.notEqual(r.status, 'AMBIGUOUS');
});

test('incomplete candles are ignored: a forming candle cannot resolve a decision', () => {
  // Candle 10:20 would close at 10:21; evaluated at 10:20:30 it is still forming.
  const forming = candle(M('2026-10-26T10:20:00Z'), 1.1, 1.2, 1.0, 1.1);
  const r = nt.resolveOutcome(buy, [forming], M('2026-10-26T10:20:30Z'));
  assert.equal(r.status, 'UNRESOLVED');
});

test('expiry: after the horizon with full coverage and no hit, the outcome is EXPIRED', () => {
  assert.equal(run(buy).status, 'EXPIRED');
});

test('before the horizon ends with no hit, the outcome stays UNRESOLVED', () => {
  assert.equal(run(buy, {}, M('2026-10-26T10:30:00Z')).status, 'UNRESOLVED');
});

test('missing candles block a resolution rather than being assumed', () => {
  const gapped = [];
  for (let t = M('2026-10-26T10:01:00Z'); t < M('2026-10-26T11:01:00Z'); t += 60000) {
    if (t === M('2026-10-26T10:10:00Z')) continue;
    gapped.push(candle(t, 1.1, 1.1001, 1.0999, 1.1));
  }
  assert.equal(nt.resolveOutcome(buy, gapped, NOW).status, 'MISSING_DATA');
});

test('a decision without frozen levels is NOT_EVALUABLE and nothing is invented', () => {
  assert.equal(nt.resolveOutcome({ timestamp: T0, levels: null }, [], NOW).status, 'NOT_EVALUABLE');
});

test('frozen levels are never changed by resolution', () => {
  const before = JSON.stringify(buy);
  run(buy, { [M('2026-10-26T10:05:00Z')]: candle(M('2026-10-26T10:05:00Z'), 1.1, 1.11, 1.1, 1.109) });
  assert.equal(JSON.stringify(buy), before);
});

test('Wilson intervals are honest about small samples', () => {
  assert.equal(nt.wilson(0, 0).rate, null);
  const w = nt.wilson(30, 40);
  assert.ok(w.low < 0.75 && w.high > 0.75 && w.low > 0.55);
  assert.ok(nt.wilson(1, 2).low < 0.2);
});

test('analytics flag review only on a clear difference, and never change a rule', () => {
  const many = (status, n) => Array.from({ length: n }, () => ({ reasonCode: 'RR_FLOOR', status }));
  assert.match(nt.summarise(many('TARGET_HIT', 40), 'reasonCode').RR_FLOOR.flag, /review/);
  assert.match(nt.summarise(many('STOP_HIT', 40), 'reasonCode').RR_FLOOR.flag, /protective/);
  assert.equal(nt.summarise(many('TARGET_HIT', 5), 'reasonCode').RR_FLOOR.flag, 'insufficient sample');
  assert.equal(nt.summarise(many('TARGET_HIT', 40), 'reasonCode').RR_FLOOR.label, 'HYPOTHETICAL');
});

test('hypothetical outcomes never change executed trades, profit or loss in a report', () => {
  const now = new Date('2026-10-26T18:00:00Z');
  const trades = [{ id: 'a', source: 'ctrader', status: 'CLOSED', closeTime: '2026-10-26T09:00:00Z', pnl: 12 }];
  const outcomes = [{ status: 'TARGET_HIT', reasonCode: 'RR_FLOOR', producedAt: '2026-10-26T10:00:00Z' }];
  const without = rep.buildReport('daily', { trades, decisions: [] }, now);
  const withOut = rep.buildReport('daily', { trades, decisions: [], outcomes }, now);
  assert.equal(withOut.summary.realisedPnlExact, without.summary.realisedPnlExact);
  assert.equal(withOut.summary.closedDemoTrades, without.summary.closedDemoTrades);
  assert.equal(withOut.hypothetical.targetHit, 1);
  assert.match(withOut.hypothetical.label, /HYPOTHETICAL/);
});

test('the report counts executed and skipped from normalised decisions (legacy included)', () => {
  const now = new Date('2026-10-26T18:00:00Z');
  const decisions = [
    { timestamp: '2026-10-26T09:00:00Z', decision: 'EXECUTED' },
    { timestamp: '2026-10-26T09:30:00Z', decision: { decision: 'SKIPPED', reason: 'Max 3 positions reached' } }
  ];
  const r = rep.buildReport('daily', { trades: [], decisions }, now);
  assert.equal(r.summary.executedInPeriod, 1);
  assert.equal(r.summary.skippedInPeriod, 1);
});
