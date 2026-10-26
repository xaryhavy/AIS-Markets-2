const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-faultrep-'));
const reports = require('../src/reports/reportGenerator');

test('a fault-injection trade closed in the period is included in the figures and disclosed', () => {
  const trades = [{
    id: 'ctrader-1', source: 'ctrader', status: 'CLOSED', pnl: 0.07, closeTime: '2026-10-26T01:00:00Z',
    closeReason: 'Fault-injection test close'
  }];
  const r = reports.buildReport('daily', { trades, decisions: [], outcomes: [] }, new Date('2026-10-26T12:00:00Z'));
  assert.equal(r.summary.closedDemoTrades, 1, 'the trade is counted, as a real demo execution');
  assert.equal(r.summary.realisedPnlExact, 0.07);
  const note = r.dataNotes.find(n => /fault-injection tests/.test(n));
  assert.ok(note, 'the disclosure is present');
  assert.match(note, /1 closed trade\(s\) in this period/);
});

test('an ordinary trade produces no fault-injection disclosure', () => {
  const trades = [{ id: 'ctrader-2', source: 'ctrader', status: 'CLOSED', pnl: 3, closeTime: '2026-10-26T01:00:00Z' }];
  const r = reports.buildReport('daily', { trades, decisions: [], outcomes: [] }, new Date('2026-10-26T12:00:00Z'));
  assert.equal(r.dataNotes.some(n => /fault-injection tests/.test(n)), false);
});
