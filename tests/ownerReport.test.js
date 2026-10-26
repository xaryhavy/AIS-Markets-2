const test = require('node:test');
const assert = require('node:assert/strict');
const orp = require('../src/reports/ownerReport');

const NOW = new Date('2026-10-26T18:00:00Z'); // Monday
const demo = (id, closeTime, pnl, extra = {}) => ({
  id, source: 'ctrader', status: 'CLOSED', symbol: 'EURUSD', action: 'BUY', closeTime, pnl,
  features: { strategy: 'macdCrossover', regime: 'RANGING' }, ...extra
});

test('period starts are calendar-correct in UTC', () => {
  assert.equal(orp.periodStart('daily', NOW).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(orp.periodStart('weekly', NOW).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(orp.periodStart('weekly', new Date('2026-10-28T10:00:00Z')).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(orp.periodStart('monthly', NOW).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(orp.periodStart('yearly', NOW).toISOString(), '2026-01-01T00:00:00.000Z');
});

test('a trade closed before the period is never counted in it', () => {
  const trades = [demo('yesterday', '2026-10-25T23:59:00Z', 50), demo('today', '2026-10-26T01:00:00Z', 10)];
  const r = orp.build({ period: 'daily', now: NOW, trades });
  assert.equal(r.performance.realisedPnlExact, 10);
  assert.equal(r.trades.closedInPeriod, 1);
});

test('performance: exact totals, expectancy, profit factor and win rate are computed from exact results only', () => {
  const trades = [demo('a', '2026-10-26T01:00:00Z', 30), demo('b', '2026-10-26T02:00:00Z', -10), demo('c', '2026-10-26T03:00:00Z', 20)];
  const p = orp.build({ period: 'daily', now: NOW, trades }).performance;
  assert.equal(p.realisedPnlExact, 40);
  assert.equal(p.expectancyPerTrade, 13.33);
  assert.equal(p.profitFactor, 5);            // 50 gross win / 10 gross loss
  assert.equal(p.winRatePct, 66.7);
  assert.equal(p.wins, 2);
  assert.equal(p.losses, 1);
});

test('estimated P&L is shown separately and never mixed into exact results', () => {
  const trades = [demo('a', '2026-10-26T01:00:00Z', 30), demo('e', '2026-10-26T02:00:00Z', -7, { pnlEstimated: true })];
  const r = orp.build({ period: 'daily', now: NOW, trades });
  assert.equal(r.performance.realisedPnlExact, 30);
  assert.equal(r.performance.realisedPnlEstimated, -7);
  assert.equal(r.trades.estimatedResults, 1);
});

test('samples below the minimum are labelled insufficient, not presented as evidence', () => {
  const trades = [demo('a', '2026-10-26T01:00:00Z', 30)];
  const r = orp.build({ period: 'daily', now: NOW, trades });
  assert.match(r.performance.sample, /insufficient/);
});

test('simulated (non-broker) records are excluded from every performance figure', () => {
  const trades = [demo('a', '2026-10-26T01:00:00Z', 30), { id: 'sim', status: 'CLOSED', closeTime: '2026-10-26T02:00:00Z', pnl: 999 }];
  assert.equal(orp.build({ period: 'daily', now: NOW, trades }).performance.realisedPnlExact, 30);
});

test('hypothetical NO-TRADE outcomes never change realised performance', () => {
  const trades = [demo('a', '2026-10-26T01:00:00Z', 30)];
  const outcomes = [{ status: 'TARGET_HIT', producedAt: '2026-10-26T04:00:00Z' }, { status: 'STOP_HIT', producedAt: '2026-10-26T05:00:00Z' }];
  const without = orp.build({ period: 'daily', now: NOW, trades });
  const withOut = orp.build({ period: 'daily', now: NOW, trades, outcomes });
  assert.equal(withOut.performance.realisedPnlExact, without.performance.realisedPnlExact);
  assert.equal(withOut.hypothetical.outcomes.TARGET_HIT, 1);
  assert.match(withOut.hypothetical.label, /HYPOTHETICAL/);
});

test('maximum drawdown inside the period comes from balance samples', () => {
  const t0 = Date.parse('2026-10-26T00:00:00Z');
  const equity = [{ t: t0 + 1000, balance: 100 }, { t: t0 + 2000, balance: 120 }, { t: t0 + 3000, balance: 108 }];
  const r = orp.build({ period: 'daily', now: NOW, trades: [], equity });
  assert.equal(r.performance.maxDrawdownPct, 10);
});

test('drawdown is reported as not available when there are no samples', () => {
  assert.equal(orp.build({ period: 'daily', now: NOW, trades: [] }).performance.maxDrawdownPct, null);
});

test('decisions from before structured logging are read with derived states and flagged', () => {
  const decisions = [
    { timestamp: '2026-10-26T01:00:00Z', decision: { decision: 'SKIPPED', reason: 'Max 3 positions reached' } },
    { timestamp: '2026-10-26T02:00:00Z', decision: 'EXECUTED' }
  ];
  const r = orp.build({ period: 'daily', now: NOW, decisions });
  assert.equal(r.opportunities.states.NO_TRADE, 1);
  assert.equal(r.opportunities.states.TRADE, 1);
  assert.ok(r.missingData.some(m => /before structured logging/.test(m)));
});

test('unresolved orders and failed protection are critical, and always flagged', () => {
  const intents = [{ status: 'PROTECTION_FAILED', createdAt: '2026-10-26T01:00:00Z' }];
  const r = orp.build({ period: 'daily', now: NOW, intents, snapshot: { unresolvedIntents: [{}] } });
  const sev = r.attention.map(a => a.severity);
  assert.ok(sev.filter(s => s === 'critical').length >= 2);
  assert.ok(r.recommendations.some(x => /Investigate now/.test(x)));
});

test('risk admission refusing most decisions is raised for owner decision, not changed automatically', () => {
  const decisions = Array.from({ length: 10 }, (_, i) => ({ timestamp: `2026-10-26T0${i % 9}:30:00Z`, decision: { decision: 'SKIPPED', reason: 'Max 3 positions reached' } }));
  const r = orp.build({ period: 'daily', now: NOW, decisions });
  assert.ok(r.attention.some(a => a.severity === 'medium'));
  assert.ok(r.recommendations.some(x => /Owner decision/.test(x)));
});

test('every report states what it does not have', () => {
  const r = orp.build({ period: 'daily', now: NOW, trades: [] });
  assert.ok(r.missingData.some(m => /Broker account statement/.test(m)));
  assert.ok(r.missingData.some(m => /Benchmark/.test(m)));
  assert.ok(r.header.sources.length >= 4);
  assert.equal(r.header.generatedAt, NOW.toISOString());
});

test('the monthly report breaks results down by week, the yearly report by month', () => {
  const trades = [
    demo('w1', '2026-10-05T10:00:00Z', 10), demo('w1b', '2026-10-07T10:00:00Z', 5), demo('w2', '2026-10-13T10:00:00Z', -4)
  ];
  const monthlyR = orp.build({ period: 'monthly', now: NOW, trades });
  assert.equal(monthlyR.weeklyBreakdown.weeks.length, 2);
  assert.equal(monthlyR.weeklyBreakdown.profitableWeeks, 1);
  const yearR = orp.build({ period: 'yearly', now: NOW, trades });
  assert.deepEqual(yearR.monthlyBreakdown.map(m => m.month), ['2026-10']);
});

test('the Markdown owner report carries the same figures and the missing-data list', () => {
  const trades = [demo('a', '2026-10-26T01:00:00Z', 30)];
  const r = orp.build({ period: 'daily', now: NOW, trades });
  const md = orp.toMarkdown(r);
  assert.match(md, /Realised P&L \(exact\): 30/);
  assert.match(md, /Missing or incomplete data/);
  assert.match(md, /HYPOTHETICAL|Hypothetical/);
});
