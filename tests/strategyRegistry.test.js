const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A registry file of its own: these tests write versions and must never touch the data directory.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-registry-'));
process.env.AIS_REGISTRY_FILE = path.join(dir, 'registry.json');

const registry = require('../src/strategy/registry');

// Each test starts from an empty registry file, so version numbers and adoption flags are predictable.
function fresh() {
  fs.rmSync(process.env.AIS_REGISTRY_FILE, { force: true });
  registry.resetCache();
}

const RULES = { name: 'SMA Crossover', params: { fast: 10, slow: 30 }, source: 'function generate() {}' };
const REASON = 'reviewed the rules and the backtest evidence';

test('the hash covers the rules, not the order they were written in', () => {
  const a = registry.hashRules({ name: 'X', params: { fast: 10, slow: 30 } });
  const b = registry.hashRules({ params: { slow: 30, fast: 10 }, name: 'X' });
  assert.equal(a, b);
});

test('any material change produces a different hash', () => {
  const base = registry.hashRules(RULES);
  assert.notEqual(base, registry.hashRules({ ...RULES, params: { fast: 12, slow: 30 } }));
  // A change to the strategy's own code is material too, even with identical parameters.
  assert.notEqual(base, registry.hashRules({ ...RULES, source: 'function generate() { /* changed */ }' }));
});

test('registering the same rules twice keeps one version', async () => {
  fresh();
  const first = await registry.register('smaCrossover', RULES);
  const second = await registry.register('smaCrossover', RULES);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.record.version, 1);
  assert.equal((await registry.all()).length, 1);
});

test('changed rules create a new version, which starts as DRAFT', async () => {
  fresh();
  await registry.register('smaCrossover', RULES);
  await registry.approve('smaCrossover', 1, registry.hashRules(RULES), { reason: REASON });
  await registry.deploy('smaCrossover', 1, { reason: REASON });

  const { record, created } = await registry.register('smaCrossover', { ...RULES, params: { fast: 12, slow: 30 } });
  assert.equal(created, true);
  assert.equal(record.version, 2);
  assert.equal(record.state, 'DRAFT');
});

test('a version that is not deployed is refused by the gate, and the reason names its state', async () => {
  fresh();
  await registry.register('smaCrossover', RULES);
  const gate = await registry.gate('smaCrossover');
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /DRAFT, not DEPLOYED/);
  assert.deepEqual(await registry.runnableNames(), []);
});

test('a strategy that was never registered is refused', async () => {
  fresh();
  const gate = await registry.gate('nothingHere');
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /not registered/);
});

test('a version cannot jump straight from DRAFT to DEPLOYED', async () => {
  fresh();
  await registry.register('smaCrossover', RULES);
  await assert.rejects(
    () => registry.deploy('smaCrossover', 1, { reason: REASON }),
    /Cannot move smaCrossover@1 from DRAFT to DEPLOYED/
  );
});

test('approval binds to the hash, so changed rules cannot be approved by version number alone', async () => {
  fresh();
  await registry.register('smaCrossover', RULES);
  await assert.rejects(
    () => registry.approve('smaCrossover', 1, registry.hashRules({ ...RULES, params: { fast: 1 } }), { reason: REASON }),
    /Approval hash does not match/
  );
  // Approving with the real hash succeeds, so the refusal was about the hash and nothing else.
  const record = await registry.approve('smaCrossover', 1, registry.hashRules(RULES), { reason: REASON });
  assert.equal(record.state, 'APPROVED');
});

test('every transition records a reason of substance', async () => {
  fresh();
  await registry.register('smaCrossover', RULES);
  await assert.rejects(() => registry.approve('smaCrossover', 1, registry.hashRules(RULES), { reason: 'ok' }), /at least 10 characters/);
  await assert.rejects(() => registry.transition('smaCrossover', 1, 'APPROVED', {}), /at least 10 characters/);
});

test('approved and deployed is what the engine may run', async () => {
  fresh();
  await registry.register('smaCrossover', RULES);
  await registry.approve('smaCrossover', 1, registry.hashRules(RULES), { reason: REASON });
  assert.equal(await registry.isRunnable('smaCrossover'), false, 'approval alone does not arm it');
  await registry.deploy('smaCrossover', 1, { reason: REASON });
  assert.equal(await registry.isRunnable('smaCrossover'), true);
  assert.deepEqual(await registry.runnableNames(), ['smaCrossover']);
});

test('the approval history is kept, so the decision can be read back later', async () => {
  fresh();
  await registry.register('smaCrossover', RULES);
  const approved = await registry.approve('smaCrossover', 1, registry.hashRules(RULES), { reason: REASON });
  assert.deepEqual(approved.history.map((h) => h.state), ['DRAFT', 'APPROVED']);
  assert.equal(approved.history[1].reason, REASON);
});

test('retiring stops the strategy running, and it cannot be re-deployed without a new approval', async () => {
  fresh();
  await registry.register('smaCrossover', RULES);
  await registry.approve('smaCrossover', 1, registry.hashRules(RULES), { reason: REASON });
  await registry.deploy('smaCrossover', 1, { reason: REASON });
  await registry.retire('smaCrossover', 1, { reason: 'the edge did not survive the out-of-sample split' });

  assert.equal(await registry.isRunnable('smaCrossover'), false);
  await assert.rejects(() => registry.deploy('smaCrossover', 1, { reason: REASON }), /Cannot move .* from RETIRED to DEPLOYED/);
});

test('a newer DRAFT sitting above a deployed version does not stop the deployed one running, but says so', async () => {
  fresh();
  await registry.register('smaCrossover', RULES);
  await registry.approve('smaCrossover', 1, registry.hashRules(RULES), { reason: REASON });
  await registry.deploy('smaCrossover', 1, { reason: REASON });
  await registry.register('smaCrossover', { ...RULES, params: { fast: 12, slow: 30 } });

  const gate = await registry.gate('smaCrossover');
  assert.equal(gate.allowed, true);
  assert.equal(gate.version, 1);
  assert.match(gate.reason, /@1 is deployed; 2 is DRAFT and not in use/);
});

test('the baseline is adopted once, as deployed, and only once', async () => {
  fresh();
  const descriptors = [{ strategy: 'smaCrossover', rules: RULES }];
  const first = await registry.adoptBaseline(descriptors);
  assert.equal(first.adopted, true);
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0].state, 'DEPLOYED');
  assert.deepEqual(await registry.runnableNames(), ['smaCrossover']);

  // A later start must not re-adopt: that would silently approve anything registered since.
  const second = await registry.adoptBaseline([]);
  assert.equal(second.adopted, false);
  registry.resetCache();
  assert.equal((await registry.adoptBaseline([])).adopted, false, 'the flag survives a reload from disk');
});

test('the adoption is labelled a migration, not an owner approval', async () => {
  fresh();
  const { records } = await registry.adoptBaseline([{ strategy: 'smaCrossover', rules: RULES }]);
  assert.ok(records[0].history.every((h) => h.actor === 'system-migration'));
});

test('the registry file is the source of truth, so a restart keeps the versions', async () => {
  fresh();
  await registry.register('smaCrossover', RULES);
  registry.resetCache();
  const fromDisk = await registry.latest('smaCrossover');
  assert.equal(fromDisk.version, 1);
  assert.equal(fromDisk.hash, registry.hashRules(RULES));
});
