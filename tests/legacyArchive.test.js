const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-legacy-'));
process.env.AIS_DATA_DIR = dir;
process.env.AIS_ARCHIVE_DIR = path.join(dir, 'archive');
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const storage = require('../src/data/storage');
const legacy = require('../src/data/legacyArchive');
const perf = require('../src/analytics/performance');

const original = [
  { id: 'L1', source: 'paper', status: 'CLOSED', pnl: 40, closeTime: '2026-09-01T10:00:00Z', strategy: 'x', features: {} },
  { id: 'L2', source: 'paper', status: 'OPEN', pnl: null, openTime: '2026-09-02T10:00:00Z' },
  { id: 'L3', source: 'paper', status: 'CLOSED', pnl: -10, closeTime: '2026-09-03T10:00:00Z' },
  { id: 'C1', source: 'ctrader', status: 'CLOSED', pnl: 2.5, closeTime: '2026-10-25T10:00:00Z', environment: 'demo' },
  { id: 'P1', source: 'ctrader', evidenceMode: 'PAPER', status: 'CLOSED', pnl: 1, closeTime: '2026-10-25T11:00:00Z' }
];

test('the dry run lists the legacy records and changes nothing', async () => {
  await storage.save('trades', original);
  const p = await legacy.plan();
  assert.equal(p.dryRun, true);
  assert.equal(p.legacyCount, 3);
  assert.deepEqual(p.byStatus, { CLOSED: 2, OPEN: 1 });
  assert.equal(p.alreadyApplied, false);
  assert.deepEqual(await storage.load('trades'), original, 'untouched');
});

test('apply tags exactly the legacy records, keeps every original field, and writes a full backup first', async () => {
  const r = await legacy.apply({ actor: 'owner' });
  assert.equal(r.count, 3);
  assert.ok(fs.existsSync(r.backup), 'backup written');
  assert.deepEqual(JSON.parse(fs.readFileSync(r.backup, 'utf8')), original, 'the backup is the exact prior state');
  const now = await storage.load('trades');
  const l1 = now.find(t => t.id === 'L1');
  assert.equal(l1.evidenceStatus, 'legacy/unverified');
  assert.equal(l1.legacyProvenance.source, 'paper');
  assert.equal(l1.legacyProvenance.originalStatus, 'CLOSED');
  assert.equal(l1.pnl, 40, 'original values unchanged');
  assert.equal(l1.strategy, 'x', 'original fields kept');
  for (const id of ['C1', 'P1']) assert.equal(now.find(t => t.id === id).evidenceStatus, undefined, `${id} not tagged`);
  assert.equal(now.length, original.length, 'nothing deleted');
});

test('a second apply is refused until the archive is rolled back', async () => {
  await assert.rejects(legacy.apply({}), /already applied/);
});

test('archived legacy records are excluded from owner performance', async () => {
  const s = await perf.summary();
  assert.equal(s.totalTrades, 1, 'only the broker trade counts');
  assert.equal(s.totalPnl, 2.5, 'the broker trade P&L only (start balance 10000)');
});

test('rollback removes only the tags this step added; trades recorded after the archive are kept', async () => {
  await storage.append('trades', { id: 'C2', source: 'ctrader', status: 'OPEN', openTime: '2026-10-26T09:00:00Z' });
  const r = await legacy.rollback({ actor: 'owner' });
  assert.equal(r.removed, 3);
  const now = await storage.load('trades');
  assert.equal(now.find(t => t.id === 'L1').evidenceStatus, undefined);
  assert.equal(now.find(t => t.id === 'L1').legacyProvenance, undefined);
  assert.ok(now.find(t => t.id === 'C2'), 'the trade recorded after the archive is kept');
  assert.equal((await legacy.state()).applied, false);
});

test('after a rollback the archive can be applied again', async () => {
  const r = await legacy.apply({ actor: 'owner' });
  assert.equal(r.count, 3);
});

test('rollback is refused when nothing is applied', async () => {
  await legacy.rollback({});
  await assert.rejects(legacy.rollback({}), /no legacy archive is applied/);
});
