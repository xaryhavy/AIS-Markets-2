const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep audit and alert writes out of the real data folder.
process.env.AIS_AUDIT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ais-eng-')), 'audit.log');
const engine = require('../src/engine/tradingEngine');

test('no alert while cycles are succeeding or fail only once or twice', () => {
  assert.equal(engine.cycleFailureCondition(0), null);
  assert.equal(engine.cycleFailureCondition(engine.CYCLE_FAILURE_ALERT - 1), null);
});

test('three consecutive failed cycles raise a high-severity CYCLE_FAILING alert', () => {
  const c = engine.cycleFailureCondition(engine.CYCLE_FAILURE_ALERT);
  assert.equal(c.code, 'CYCLE_FAILING');
  assert.equal(c.severity, 'high');
  assert.match(c.message, /3 consecutive engine cycles failed/);
});

test('the alert stays raised as the failure run grows', () => {
  assert.equal(engine.cycleFailureCondition(10).code, 'CYCLE_FAILING');
});
