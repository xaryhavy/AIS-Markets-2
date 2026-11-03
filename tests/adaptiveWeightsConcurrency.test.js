const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A weights file of its own: these tests write versions of it and must never touch the data directory.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-weights-'));
process.env.AIS_WEIGHTS_FILE = path.join(dir, 'adaptive_weights.json');
const learner = require('../src/intelligence/adaptiveLearner');

const FILE = process.env.AIS_WEIGHTS_FILE;
const read = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

// The defect this covers: the file was rewritten in place with fs.writeJson, so a read landing inside a
// write saw a truncated file and threw "Unexpected end of JSON input". Three cycles died on 2026-11-02 and
// the entry pause latched; a live backtest reproduced it on 2026-11-03. Writes are now temp-then-rename and
// read-modify-write cycles are serialised, so neither can happen.

test('concurrent trade updates all land, and the file stays valid JSON', async () => {
  await Promise.all(Array.from({ length: 40 }, (_, i) =>
    learner.updateOnTrade({ pnl: i % 2 ? 10 : -10 }, 'smaCrossover', 'RANGING')));

  assert.doesNotThrow(() => read(), 'the file must always be parseable');
  assert.equal(read().totalTrades, 40, 'no update is lost to an interleaved write');
  assert.equal(read().perStrategy.smaCrossover.RANGING.trades, 40);
});

test('reads taken while writes are in flight return weights, never a parse error', async () => {
  const reads = Array.from({ length: 50 }, () => learner.getWeight('smaCrossover', 'RANGING'));
  const writes = Array.from({ length: 12 }, (_, i) =>
    learner.recordBacktest('macdCrossover', `SYM${i}`, [{ pnl: 5, regime: 'RANGING' }]));

  const results = await Promise.all([...reads, ...writes]);
  for (const value of results.slice(0, reads.length)) {
    assert.equal(typeof value, 'number', 'a read during a write must produce a weight');
    assert.ok(Number.isFinite(value));
  }
  assert.equal(Object.keys(read().backtest).length, 12);
});

test('a backtest run replaces its own pair rather than double-counting it', async () => {
  await learner.recordBacktest('macdCrossover', 'SYM0', [{ pnl: 5, regime: 'RANGING' }]);
  const entry = read().backtest['macdCrossover|SYM0'];
  assert.equal(entry.byRegime.RANGING.trades, 1);
});

test('no temp file is left behind by a completed write', () => {
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('an unreadable file is reported, not silently replaced with neutral weights', async () => {
  // 1.0 is a different position size from a learned 0.2, so falling back silently would change sizing
  // without the owner asking. The error is raised with the file named, so it reaches the alert.
  learner.resetCache();
  fs.writeFileSync(FILE, ''); // a file cut off before anything was written: the shape the real failure had

  await assert.rejects(
    () => learner.getWeight('smaCrossover', 'RANGING'),
    /adaptive weights unreadable.*Unexpected end of JSON input/
  );
});
