const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-pause-cause-'));
process.env.AIS_DATA_DIR = dir;
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const audit = require('../src/audit/audit');
const pause = require('../src/engine/entryPause');

const auditEntries = () => fs.readFileSync(audit.AUDIT_FILE, 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));

const CAUSE = 'adaptive weights unreadable (Unexpected end of JSON input)';

test('the pause records why the cycles failed, not only how many failed', async () => {
  await pause.init();
  assert.equal(await pause.tripOnFailures(3, CAUSE), true);

  assert.equal(pause.status().active, true);
  assert.match(pause.status().reason, /3 consecutive engine cycles failed/);
  assert.equal(pause.status().cause, CAUSE, 'the cause is kept on the record the owner reads');
});

test('the cause is written to the audit ledger with the pause', async () => {
  const paused = auditEntries().filter((e) => e.type === 'ENTRIES_PAUSED').pop();
  assert.ok(paused, 'the pause must be audited');
  assert.equal(paused.fields.cause, CAUSE);
});

test('the stored reason no longer repeats the status the surfaces already show', () => {
  // Readiness prefixes "new entries paused: " — a reason ending in the same phrase printed it twice.
  assert.equal(/new entries paused/i.test(pause.status().reason), false);
});

test('resuming clears the cause, so a stale error is not shown against a live run', async () => {
  await pause.resume({ reconcileOk: true, actor: 'owner' });
  assert.equal(pause.status().active, false);
  assert.equal(pause.status().cause, null);
});

test('a record written before the fix is reduced to its cause when it loads', async () => {
  fs.writeFileSync(path.join(dir, 'entry_pause.json'), JSON.stringify([{
    active: true,
    reason: '3 consecutive engine cycles failed; new entries paused',
    since: new Date().toISOString(),
    threshold: 3,
    resumedAt: null
  }]));

  delete require.cache[require.resolve('../src/engine/entryPause')];
  const fresh = require('../src/engine/entryPause');
  await fresh.init();

  assert.equal(fresh.status().reason, '3 consecutive engine cycles failed');
  assert.equal(fresh.status().cause, null, 'an old record has no cause to show');
});
