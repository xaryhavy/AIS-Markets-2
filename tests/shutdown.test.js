const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Everything written here goes to temp files: data, audit, emergency flag.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-shutdown-'));
process.env.AIS_DATA_DIR = dir;
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
process.env.AIS_EMERGENCY_FILE = path.join(dir, 'emergency_stop.json');
const audit = require('../src/audit/audit');
const storage = require('../src/data/storage');
const limits = require('../src/risk/limits');
const trading = require('../src/ctrader/trading');
const shutdown = require('../src/governance/shutdown');
const entryPause = require('../src/engine/entryPause');

const auditTypes = () => fs.existsSync(audit.AUDIT_FILE)
  ? fs.readFileSync(audit.AUDIT_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).type) : [];

let closeCalls = 0;
trading.closeMarket = async () => { closeCalls++; throw new Error('must never be called by a shutdown'); };

test('a shutdown needs a reason of at least five characters', async () => {
  await assert.rejects(shutdown.request({ reason: 'stop' }), /at least 5 characters/);
  await assert.rejects(shutdown.request({}), /at least 5 characters/);
  assert.equal(await shutdown.current(), null);
});

test('a shutdown disables new entries at once and records who, when, why and the state', async () => {
  const r = await shutdown.request({ actor: 'owner', reason: 'testing the stop route', snapshot: { brokerState: 'ACCOUNT_AUTHENTICATED' } });
  assert.equal(r.alreadyActive, false);
  assert.equal(r.record.status, 'ACTIVE');
  assert.equal(r.record.actor, 'owner');
  assert.equal(r.record.reason, 'testing the stop route');
  assert.ok(r.record.requestedAt);
  assert.equal(r.record.snapshot.brokerState, 'ACCOUNT_AUTHENTICATED');
  assert.equal((await limits.emergencyState()).on, true);
  assert.equal(entryPause.status().active, true);
  assert.match(entryPause.status().reason, /owner shutdown/);
  assert.equal(auditTypes().filter(t => t === 'OWNER_SHUTDOWN_REQUESTED').length, 1);
});

test('a repeat request while a shutdown is active is idempotent: same record, no new audit entry', async () => {
  const first = await shutdown.current();
  const again = await shutdown.request({ actor: 'owner', reason: 'pressed again' });
  assert.equal(again.alreadyActive, true);
  assert.equal(again.record.id, first.id);
  assert.equal((await storage.load(shutdown.COLLECTION)).length, 1);
  assert.equal(auditTypes().filter(t => t === 'OWNER_SHUTDOWN_REQUESTED').length, 1);
});

test('overlapping requests create exactly one shutdown record', async () => {
  await shutdown.resume({ reconcileOk: true });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => shutdown.request({ actor: 'owner', reason: `request ${i} from a burst` })));
  assert.equal(results.filter(r => r.alreadyActive === false).length, 1, 'exactly one creates the shutdown');
  assert.equal((await storage.load(shutdown.COLLECTION)).filter(r => r.status === 'ACTIVE').length, 1);
});

test('a shutdown does not close any position', async () => {
  assert.equal(closeCalls, 0);
});

test('a restart mid-shutdown keeps the shutdown in force', async () => {
  for (const m of ['../src/governance/shutdown', '../src/engine/entryPause', '../src/risk/limits']) {
    delete require.cache[require.resolve(m)];
  }
  const freshShutdown = require('../src/governance/shutdown');
  const freshPause = require('../src/engine/entryPause');
  const freshLimits = require('../src/risk/limits');
  await freshPause.init();
  const active = await freshShutdown.current();
  assert.ok(active, 'the shutdown record survived the restart');
  assert.equal((await freshLimits.emergencyState()).on, true, 'emergency stop still on');
  assert.equal(freshPause.status().active, true, 'entries still paused');
});

test('resume is refused without a successful broker reconciliation', async () => {
  const r = await shutdown.resume({ reconcileOk: false });
  assert.equal(r.resumed, false);
  assert.match(r.reason, /successful broker reconciliation/);
  assert.ok(await shutdown.current(), 'still active');
});

test('resume with a successful reconciliation clears the stop and the pause, and is audited', async () => {
  const r = await shutdown.resume({ actor: 'owner', reconcileOk: true });
  assert.equal(r.resumed, true);
  assert.equal(await shutdown.current(), null);
  assert.equal((await limits.emergencyState()).on, false);
  assert.equal(entryPause.status().active, false);
  assert.ok(auditTypes().includes('OWNER_SHUTDOWN_RESUMED'));
  const again = await shutdown.resume({ reconcileOk: true });
  assert.equal(again.resumed, false, 'resuming when nothing is active is a no-op');
});

test('a new shutdown can be requested after a resume', async () => {
  const r = await shutdown.request({ actor: 'owner', reason: 'second stop after resume' });
  assert.equal(r.alreadyActive, false);
  assert.equal((await storage.load(shutdown.COLLECTION)).length, 3, 'history keeps every record: first, burst, and this one');
});
