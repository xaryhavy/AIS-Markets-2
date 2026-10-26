const test = require('node:test');
const assert = require('node:assert/strict');
const rep = require('../src/reports/reportGenerator');

const now = new Date('2026-10-22T18:00:00Z'); // Thursday
const demo = (id, closeTime, pnl, extra = {}) => ({ id, source: 'ctrader', status: 'CLOSED', symbol: 'EURUSD', action: 'BUY', closeTime, pnl, ...extra });
const trades = [
  demo('a', '2026-10-01T10:00:00Z', 100),                       // first of the month
  demo('b', '2026-10-19T10:00:00Z', -5),                        // Monday of this week
  demo('c', '2026-10-22T09:00:00Z', 10),                        // today
  demo('e', '2026-10-22T12:00:00Z', -2, { pnlEstimated: true }), // closed outside AIS: estimate
  { id: 'sim', status: 'CLOSED', closeTime: '2026-10-22T08:00:00Z', pnl: 999 }, // simulated legacy record
  { id: 'open', source: 'ctrader', status: 'OPEN', symbol: 'USDJPY', action: 'SELL' }
];
const decisions = [
  { timestamp: '2026-10-22T07:00:00Z', decision: 'EXECUTED' },
  { timestamp: '2026-10-22T08:00:00Z', decision: 'SKIPPED' },
  { timestamp: '2026-10-10T08:00:00Z', decision: 'SKIPPED' }
];

test('period starts are calendar-correct in UTC', () => {
  assert.equal(rep.periodStart('daily', now).toISOString(), '2026-10-22T00:00:00.000Z');
  assert.equal(rep.periodStart('weekly', now).toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(rep.periodStart('monthly', now).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(rep.periodStart('yearly', now).toISOString(), '2026-01-01T00:00:00.000Z');
});

test('the daily report covers only today, not all-time totals', () => {
  const r = rep.buildReport('daily', { trades, decisions }, now);
  assert.equal(r.summary.closedDemoTrades, 2, 'one exact and one estimated trade closed today');
  assert.equal(r.summary.realisedPnlExact, 10);
  assert.equal(r.summary.realisedPnlEstimated, -2);
});

test('the weekly and monthly reports widen the window correctly', () => {
  assert.equal(rep.buildReport('weekly', { trades, decisions }, now).summary.realisedPnlExact, 5);
  assert.equal(rep.buildReport('monthly', { trades, decisions }, now).summary.realisedPnlExact, 105);
});

test('simulated records never count as performance', () => {
  for (const p of ['daily', 'weekly', 'monthly', 'yearly']) {
    const r = rep.buildReport(p, { trades, decisions }, now);
    assert.ok(r.summary.realisedPnlExact < 999, `${p} included simulated P&L`);
  }
  const notes = rep.buildReport('daily', { trades, decisions }, now).dataNotes.join(' ');
  assert.match(notes, /simulated\/legacy record\(s\) excluded/);
});

test('estimated P&L is kept apart from exact P&L and flagged', () => {
  const r = rep.buildReport('daily', { trades, decisions }, now);
  assert.equal(r.summary.realisedPnlExact, 10);
  assert.match(r.dataNotes.join(' '), /estimated P&L/);
});

test('open positions are reported as not marked to market', () => {
  const r = rep.buildReport('daily', { trades, decisions }, now);
  assert.equal(r.summary.openDemoTrades, 1);
  assert.match(r.summary.openTradesFloatingPnl, /not computed/);
});

test('decision counts respect the period and state the sources', () => {
  const r = rep.buildReport('daily', { trades, decisions }, now);
  assert.equal(r.summary.decisionsInPeriod, 2);
  assert.equal(r.summary.executedInPeriod, 1);
  assert.equal(r.summary.skippedInPeriod, 1);
  assert.ok(r.dataSources.length >= 2);
  assert.equal(r.generatedAt, now.toISOString());
});
