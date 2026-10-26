const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../src/governance/guardrails');

const limits = { dailyLossPct: 3, weeklyLossPct: 6, monthlyLossPct: 10 };
const thursday = new Date('2026-10-22T15:00:00Z');
const closed = (pnl, closeTime) => ({ source: 'ctrader', status: 'CLOSED', pnl, closeTime });

test('no closed trades: trading is not blocked', () => {
  assert.equal(g.lossCapBreach([], 10000, limits, thursday).breached, false);
});

test('a daily loss above the daily limit blocks trading', () => {
  // Lost 350 today; balance 9650 means the day started at 10000; 3% limit is 300.
  const r = g.lossCapBreach([closed(-350, '2026-10-22T09:00:00Z')], 9650, limits, thursday);
  assert.equal(r.breached, true);
  assert.match(r.reason, /daily/);
});

test('a loss from earlier this week counts for the weekly limit only', () => {
  // Lost 350 on Wednesday: outside today's daily window, inside the week (6% of 10000 = 600).
  const trades = [closed(-350, '2026-10-21T10:00:00Z')];
  assert.equal(g.lossCapBreach(trades, 9650, limits, thursday).breached, false);
  const r = g.lossCapBreach([closed(-700, '2026-10-21T10:00:00Z')], 9300, limits, thursday);
  assert.equal(r.breached, true);
  assert.match(r.reason, /weekly/);
});

test('a loss from last month does not count this month', () => {
  const r = g.lossCapBreach([closed(-2000, '2026-09-28T10:00:00Z')], 8000, limits, thursday);
  assert.equal(r.breached, false);
});

test('gains never block trading', () => {
  assert.equal(g.lossCapBreach([closed(500, '2026-10-22T09:00:00Z')], 10500, limits, thursday).breached, false);
});

test('an unknown account balance blocks trading', () => {
  assert.equal(g.lossCapBreach([], null, limits, thursday).breached, true);
});

test('simulated (paper) trades are ignored by the loss caps', () => {
  const paper = { status: 'CLOSED', pnl: -5000, closeTime: '2026-10-22T09:00:00Z' };
  assert.equal(g.lossCapBreach([paper], 5000, limits, thursday).breached, false);
});

test('period starts are computed in UTC', () => {
  assert.equal(g.periodStart('daily', thursday).toISOString(), '2026-10-22T00:00:00.000Z');
  assert.equal(g.periodStart('weekly', thursday).toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(g.periodStart('monthly', thursday).toISOString(), '2026-10-01T00:00:00.000Z');
});
