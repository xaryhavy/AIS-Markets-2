const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-pause-'));
process.env.AIS_DATA_DIR = dir;
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const audit = require('../src/audit/audit');
const pause = require('../src/engine/entryPause');

const auditTypes = () => fs.existsSync(audit.AUDIT_FILE)
  ? fs.readFileSync(audit.AUDIT_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).type) : [];

test('the pause does not trip below the threshold', async () => {
  await pause.init();
  assert.equal(await pause.tripOnFailures(2), false);
  assert.equal(pause.status().active, false);
});

test('three consecutive failures trip the pause once, with a reason and an audit record', async () => {
  assert.equal(await pause.tripOnFailures(3), true);
  assert.equal(pause.status().active, true);
  assert.match(pause.status().reason, /3 consecutive engine cycles failed/);
  assert.equal(await pause.tripOnFailures(4), false, 'already paused: no second trip');
  assert.equal(auditTypes().filter(t => t === 'ENTRIES_PAUSED').length, 1);
});

test('resume is refused without a successful broker reconciliation', async () => {
  const r = await pause.resume({ reconcileOk: false });
  assert.equal(r.resumed, false);
  assert.match(r.reason, /successful broker reconciliation/);
  assert.equal(pause.status().active, true);
});

test('resume succeeds with a successful reconciliation, and is audited with the actor', async () => {
  const r = await pause.resume({ reconcileOk: true, actor: 'owner' });
  assert.equal(r.resumed, true);
  assert.equal(pause.status().active, false);
  assert.ok(pause.status().resumedAt);
  assert.ok(auditTypes().includes('ENTRIES_RESUMED'));
});

test('resume when not paused is a no-op', async () => {
  assert.deepEqual(await pause.resume({ reconcileOk: true }), { resumed: false, reason: 'entries are not paused' });
});

test('the pause survives a restart (state is reloaded from storage)', async () => {
  await pause.tripOnFailures(5);
  delete require.cache[require.resolve('../src/engine/entryPause')];
  const fresh = require('../src/engine/entryPause');
  await fresh.init();
  assert.equal(fresh.status().active, true);
  assert.match(fresh.status().reason, /5 consecutive/);
});

test('threshold must be a whole number from 1 to 20', async () => {
  for (const bad of [0, 21, 2.5, '3', NaN]) {
    await assert.rejects(pause.setThreshold(bad), /threshold must be a whole number/, `rejects ${bad}`);
  }
  const s = await pause.setThreshold(5);
  assert.equal(s.threshold, 5);
});
