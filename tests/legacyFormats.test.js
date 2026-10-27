const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-formats-'));
process.env.AIS_DATA_DIR = dir;
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const lf = require('../src/governance/legacyFormats');

const current = { id: 'C-1', timestamp: '2026-10-25T10:00:00Z', symbol: 'EURUSD', decision: 'SKIPPED', state: 'WAIT', reasonCode: 'NOT_QUALIFIED' };
const objectFmt = { id: 'O-1', timestamp: '2026-09-01T10:00:00Z', symbol: 'EURUSD', decision: { decision: 'SKIPPED', reason: 'Max exposure reached' } };
const noState = { id: 'S-1', timestamp: '2026-09-02T10:00:00Z', symbol: 'GBPUSD', decision: 'SKIPPED', reasonCode: 'NOT_QUALIFIED' };
const noCode = { id: 'R-1', timestamp: '2026-09-03T10:00:00Z', symbol: 'USDJPY', decision: 'SKIPPED', state: 'WAIT' };
const all = [current, objectFmt, noState, noCode];

test('each record is classified into exactly one format', () => {
  assert.equal(lf.classify(current), 'CURRENT');
  assert.equal(lf.classify(objectFmt), 'LEGACY_OBJECT_DECISION');
  assert.equal(lf.classify(noState), 'LEGACY_NO_STATE');
  assert.equal(lf.classify(noCode), 'LEGACY_NO_REASON_CODE');
  assert.equal(lf.classify({ decision: 42 }), 'OTHER');
  assert.equal(lf.classify(null), 'OTHER');
});

test('the inventory counts by format with date range and links to outcomes', () => {
  const outcomes = [{ id: 'OUT-C-1', decisionId: 'C-1' }, { id: 'OUT-S-1', decisionId: 'S-1' }];
  const inv = lf.inventory(all, outcomes);
  assert.equal(inv.total, 4);
  assert.equal(inv.byFormat.CURRENT.count, 1);
  assert.equal(inv.byFormat.CURRENT.linkedToOutcomes, 1);
  assert.equal(inv.byFormat.LEGACY_NO_STATE.linkedToOutcomes, 1);
  assert.equal(inv.byFormat.LEGACY_OBJECT_DECISION.first, '2026-09-01T10:00:00Z');
  assert.equal(inv.byFormat.LEGACY_OBJECT_DECISION.last, '2026-09-01T10:00:00Z');
});

test('the format module is read-only: it exposes no function that writes', () => {
  assert.deepEqual(Object.keys(lf).sort(), ['classify', 'inventory']);
});

test('inventory and classification never change the records they read', () => {
  const copy = JSON.parse(JSON.stringify(all));
  lf.inventory(all, []);
  all.forEach(lf.classify);
  assert.deepEqual(all, copy);
});
