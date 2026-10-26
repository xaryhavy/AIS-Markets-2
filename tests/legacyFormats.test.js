const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-formats-'));
process.env.AIS_DATA_DIR = dir;
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const storage = require('../src/data/storage');
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

test('tagging is a dry run first, tags only legacy formats, and is reversible without touching other fields', async () => {
  await storage.save('decisions', all);
  const p = lf.tagPlan(all);
  assert.equal(p.wouldTag, 3);
  assert.equal(p.dryRun, true);
  assert.deepEqual(await storage.load('decisions'), all, 'the dry run changed nothing');

  const r = await lf.tagApply({ actor: 'owner' });
  assert.equal(r.tagged, 3);
  const rows = await storage.load('decisions');
  assert.equal(rows.find(d => d.id === 'C-1').evidenceStatus, undefined, 'current records are not tagged');
  const o = rows.find(d => d.id === 'O-1');
  assert.equal(o.evidenceStatus, 'legacy/unverified');
  assert.equal(o.legacyProvenance.format, 'LEGACY_OBJECT_DECISION');
  assert.deepEqual(o.decision, { decision: 'SKIPPED', reason: 'Max exposure reached' }, 'the original value is untouched');

  const back = await lf.tagRollback({ actor: 'owner' });
  assert.equal(back.removed, 3);
  assert.deepEqual(await storage.load('decisions'), all, 'rollback restores the exact prior records');
});

test('tagging twice does not tag again', async () => {
  await storage.save('decisions', all);
  await lf.tagApply({});
  const second = await lf.tagApply({});
  assert.equal(second.tagged, 0);
  await lf.tagRollback({});
});
