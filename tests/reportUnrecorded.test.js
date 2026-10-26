const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep any report side effects out of the real data folder.
process.env.AIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-report-'));
const reports = require('../src/reports/reportGenerator');

const empty = { trades: [], decisions: [], outcomes: [] };

test('a daily report covering the test closes discloses them and keeps them out of the totals', () => {
  const r = reports.buildReport('daily', empty, new Date('2026-10-25T23:59:00Z'));
  assert.equal(r.summary.unrecordedBrokerCloses.count, 3);
  assert.equal(r.summary.unrecordedBrokerCloses.pnlExcludedFromTotals, 0.22);
  assert.equal(r.summary.realisedPnlExact, 0, 'the disclosed P&L is not in the realised total');
  assert.equal(r.summary.closedDemoTrades, 0);
  const note = r.dataNotes.find(n => /no AIS trade record/.test(n));
  assert.ok(note, 'the note is present');
  assert.match(note, /reported P&L 0.22 is excluded from all totals above/);
  assert.match(note, /fault-injection test: lost order reply/);
});

test('the disclosure follows the period: a later day does not repeat it', () => {
  const r = reports.buildReport('daily', empty, new Date('2026-10-26T12:00:00Z'));
  assert.equal(r.summary.unrecordedBrokerCloses.count, 0);
  assert.equal(r.dataNotes.some(n => /no AIS trade record/.test(n)), false);
});

test('a monthly report containing the closes lists all three', () => {
  const r = reports.buildReport('monthly', empty, new Date('2026-10-26T12:00:00Z'));
  assert.equal(r.summary.unrecordedBrokerCloses.count, 3);
});

test('the disclosed list is exported with the three position identifiers', () => {
  const ids = reports.UNRECORDED_BROKER_CLOSES.map(c => c.positionId);
  assert.deepEqual(ids, [252276705, 252276925, 252277165]);
});
