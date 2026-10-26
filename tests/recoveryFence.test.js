const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The run-state file is read at load time, so point it at a temp folder before requiring the module.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-fence-'));
const STATE = path.join(dir, 'run_state.json');
process.env.AIS_RUN_STATE_FILE = STATE;
const guardrails = require('../src/governance/guardrails');

const writeState = s => fs.writeFileSync(STATE, JSON.stringify(s));
const cleanSlate = () => { if (fs.existsSync(STATE)) fs.unlinkSync(STATE); };

test('first start with no previous run has no fence', async () => {
  cleanSlate();
  assert.equal((await guardrails.init()).fenceActive, false);
});

test('a previous clean shutdown does not fence the next start', async () => {
  writeState({ cleanShutdown: true, fenceActive: false });
  assert.equal((await guardrails.init()).fenceActive, false);
});

test('a previous run that never shut down cleanly (crash, kill, power loss) fences the next start', async () => {
  writeState({ cleanShutdown: false, fenceActive: false });
  assert.equal((await guardrails.init()).fenceActive, true);
});

test('a restart does not clear an unacknowledged fence', async () => {
  // Fence set, then the process dies again before anyone acknowledges it.
  writeState({ cleanShutdown: false, fenceActive: true });
  assert.equal((await guardrails.init()).fenceActive, true);
  assert.equal((await guardrails.init()).fenceActive, true, 'still held after another restart');
});

test('acknowledging the fence releases it, and the release is persisted', async () => {
  writeState({ cleanShutdown: false, fenceActive: true });
  await guardrails.init();
  await guardrails.acknowledgeFence();
  assert.equal(guardrails.fenceStatus().fenceActive, false);
  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.equal(saved.fenceActive, false);
  assert.ok(saved.acknowledgedAt);
});

test('a clean stop writes the marker, so the next start is not fenced', async () => {
  cleanSlate();
  await guardrails.init();
  guardrails.markCleanShutdown();
  assert.equal((await guardrails.init()).fenceActive, false);
});
