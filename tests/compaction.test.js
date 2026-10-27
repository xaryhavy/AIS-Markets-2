const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-compact-'));
process.env.AIS_DATA_DIR = dir;
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const storage = require('../src/data/storage');
const c = require('../src/governance/compaction');

const NOW = new Date('2026-10-26T12:00:00Z');
const old = (id, extra = {}) => ({ id, timestamp: '2026-09-01T10:00:00Z', symbol: 'EURUSD', decision: 'SKIPPED', state: 'WAIT', reasonCode: 'NOT_QUALIFIED', strategy: 'trend', timeframe: 'M1', ...extra });

const decisions = [
  old('W-compact-1'),                                                       // compactable
  old('W-compact-2', { timestamp: '2026-09-01T10:05:00Z' }),                // compactable, same day group
  old('W-outcome', { reasonCode: 'DATA_QUALITY' }),                         // protected: NO-TRADE outcome depends on it
  old('W-executed', { decision: 'EXECUTED', state: 'TRADE', reasonCode: 'EXECUTED' }), // protected: trade
  old('NT-rule', { decision: 'SKIPPED', state: 'NO_TRADE', reasonCode: 'ML_THRESHOLD' }), // protected: rule decision
  old('W-incident', { symbol: 'GBPUSD', reasonCode: 'DATA_QUALITY' }),      // protected: data-gate incident
  old('W-openpos', { symbol: 'USDJPY' }),                                   // protected: open position on USDJPY
  { ...old('W-recent'), timestamp: '2026-10-25T10:00:00Z' }                 // inside the retention window
];
const outcomes = [{ id: 'OUT-1', decisionId: 'W-outcome', status: 'TARGET_HIT' }];
const trades = [{ id: 'T1', symbol: 'USDJPY', status: 'OPEN', openTime: '2026-08-30T00:00:00Z', source: 'ctrader' }];
const gateBlocks = [{ symbol: 'GBPUSD', startedAt: '2026-08-31T00:00:00Z', endedAt: '2026-09-02T00:00:00Z' }];

async function seed() {
  await storage.save('decisions', decisions);
  await storage.save('no_trade_outcomes', outcomes);
  await storage.save('trades', trades);
  await storage.save('data_gate_blocks', gateBlocks);
  await storage.save(c.ARCHIVE, []);
  await storage.save(c.ROLLUPS, []);
  await storage.save(c.RUNS, []);
}

test('retention is validated: whole days from 1 to 365', () => {
  for (const bad of [0, 366, 1.5, '30', NaN]) assert.throws(() => c.validRetention(bad), /retention must be a whole number/);
  assert.equal(c.validRetention(30), 30);
});

test('the dry run reports what would be compacted and why others are kept, and changes nothing', async () => {
  await seed();
  const p = await c.plan({ retentionDays: 30, now: NOW });
  assert.equal(p.dryRun, true);
  assert.equal(p.compactable, 2);
  assert.deepEqual(p.compactableByReason, { NOT_QUALIFIED: 2 });
  // Only current-format NOT_QUALIFIED WAIT records are candidates now; the open-position one is kept.
  assert.equal(p.protectedInWindow, 1);
  assert.equal(p.protectedByReason['open position'], 1);
  assert.equal(p.rollupGroups, 1, 'the two same-day records share one rollup');
  assert.equal((await storage.load(c.DECISIONS)).length, decisions.length, 'nothing changed');
});

test('apply moves only the compactable records to the archive, keeps everything else, and writes daily rollups', async () => {
  await seed();
  const r = await c.apply({ retentionDays: 30, now: NOW, actor: 'owner' });
  assert.equal(r.compacted, 2);
  const hot = (await storage.load(c.DECISIONS)).map(d => d.id);
  assert.ok(!hot.includes('W-compact-1') && !hot.includes('W-compact-2'));
  for (const id of ['W-outcome', 'W-executed', 'NT-rule', 'W-incident', 'W-openpos', 'W-recent']) assert.ok(hot.includes(id), `${id} kept`);
  const archived = await storage.load(c.ARCHIVE);
  assert.equal(archived.length, 2, 'full records retained in the archive');
  assert.equal(archived[0].runId, r.runId);
  const rollups = await storage.load(c.ROLLUPS);
  assert.equal(rollups.length, 1);
  assert.equal(rollups[0].count, 2);
});

test('apply is idempotent: a second run compacts nothing and archives nothing twice', async () => {
  const before = (await storage.load(c.ARCHIVE)).length;
  const r = await c.apply({ retentionDays: 30, now: NOW, actor: 'owner' });
  assert.equal(r.compacted, 0);
  assert.equal((await storage.load(c.ARCHIVE)).length, before);
});

test('a run can be reversed: its records return to the hot log, once', async () => {
  await seed();
  const r = await c.apply({ retentionDays: 30, now: NOW, actor: 'owner' });
  const back = await c.reverse(r.runId, { actor: 'owner', now: new Date('2026-10-27T00:00:00Z') });
  assert.equal(back.restored, 2);
  const hot = (await storage.load(c.DECISIONS)).map(d => d.id);
  assert.ok(hot.includes('W-compact-1') && hot.includes('W-compact-2'));
  assert.equal(hot.length, decisions.length);
  await assert.rejects(c.reverse(r.runId, { now: NOW }), /already reversed/);
});

test('a reversal after the retention cutoff is refused', async () => {
  await seed();
  const r = await c.apply({ retentionDays: 30, now: NOW, actor: 'owner' });
  const late = new Date(NOW.getTime() + 31 * 86400000);
  await assert.rejects(c.reverse(r.runId, { now: late }), /reversal window for this run has closed/);
});

test('an interrupted run is not archived twice on retry', async () => {
  await seed();
  // Simulate an earlier run that archived the records but did not remove them from the hot log.
  await storage.save(c.ARCHIVE, [{ ...decisions[0], runId: 'earlier', compactedAt: NOW.toISOString() }]);
  const r = await c.apply({ retentionDays: 30, now: NOW, actor: 'owner' });
  assert.equal(r.compacted, 2);
  const archivedIds = (await storage.load(c.ARCHIVE)).map(d => d.id);
  assert.equal(archivedIds.filter(id => id === 'W-compact-1').length, 1, 'no duplicate archive entry');
});

test('legacy-format decisions are never compacted, even when old and NOT_QUALIFIED', () => {
  const legacy = { id: 'L-1', timestamp: '2026-09-01T10:00:00Z', symbol: 'EURUSD', decision: { decision: 'SKIPPED', reason: 'Max exposure reached' } };
  const noState = { id: 'L-2', timestamp: '2026-09-01T10:00:00Z', symbol: 'EURUSD', decision: 'SKIPPED', reasonCode: 'NOT_QUALIFIED' };
  assert.equal(c.isCompactable(legacy, '2026-10-01T00:00:00Z'), false);
  assert.equal(c.isCompactable(noState, '2026-10-01T00:00:00Z'), false);
  assert.equal(c.isCompactable(decisions[0], '2026-10-01T00:00:00Z'), true);
});

test('the scheduled dry run logs its plan, records no application, and changes no decision', async () => {
  await seed();
  const before = (await storage.load(c.DECISIONS)).length;
  const p = await c.logDryRun({ retentionDays: 30, now: NOW });
  assert.equal(p.dryRun, true);
  assert.equal((await storage.load(c.DECISIONS)).length, before);
  const log = await storage.load('decision_compaction_dryrun_log');
  assert.equal(log.length, 1);
  assert.equal(log[0].applied, false);
  assert.equal(log[0].compactable, p.compactable);
});

test('guard: a compaction run never compacts, archives or modifies a legacy-format record linked to an outcome', async () => {
  const legacy = { id: 'LEG-1', timestamp: '2026-08-01T10:00:00Z', symbol: 'EURUSD', decision: { decision: 'SKIPPED', reason: 'Max exposure reached' } };
  await storage.save('decisions', [legacy, ...decisions]);
  await storage.save('no_trade_outcomes', [...outcomes, { id: 'OUT-LEG-1', decisionId: 'LEG-1', status: 'NOT_EVALUABLE' }]);
  await storage.save('trades', trades);
  await storage.save('data_gate_blocks', gateBlocks);
  await storage.save(c.ARCHIVE, []);
  await c.apply({ retentionDays: 30, now: NOW, actor: 'owner' });
  const after = (await storage.load(c.DECISIONS)).find(d => d.id === 'LEG-1');
  assert.deepEqual(after, legacy, 'byte-identical');
  assert.equal((await storage.load(c.ARCHIVE)).some(d => d.id === 'LEG-1'), false, 'not archived');
});
