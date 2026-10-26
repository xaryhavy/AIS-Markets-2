const test = require('node:test');
const assert = require('node:assert/strict');
const { readiness } = require('../src/governance/readiness');

const healthy = { mode: 'DEMO_AUTONOMOUS', allowsOrders: true, tradingEnabled: true, brokerState: 'ACCOUNT_AUTHENTICATED', feedReady: true, unresolved: 0, unmanaged: 0 };

test('a pause shows its actual reason in readiness, not a generic cause', () => {
  const r = readiness({ ...healthy, entriesPaused: true, entriesPausedReason: 'owner shutdown: testing' });
  assert.equal(r.executionState, 'disabled');
  assert.ok(r.reasons.includes('new entries paused: owner shutdown: testing'));
});

test('a pause without a stated reason still says that owner resume is needed', () => {
  const r = readiness({ ...healthy, entriesPaused: true });
  assert.ok(r.reasons.includes('new entries paused (owner resume needed)'));
});
