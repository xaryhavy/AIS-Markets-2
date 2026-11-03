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

test('the cause of the failed cycles travels with the pause into readiness', () => {
  const r = readiness({
    ...healthy,
    entriesPaused: true,
    entriesPausedReason: '3 consecutive engine cycles failed',
    entriesPausedCause: 'adaptive weights unreadable (Unexpected end of JSON input)'
  });
  assert.ok(r.reasons.includes(
    'new entries paused: 3 consecutive engine cycles failed — last cycle error: adaptive weights unreadable (Unexpected end of JSON input)'
  ));
});

test('the pause reads as one sentence, not the status said twice', () => {
  const r = readiness({ ...healthy, entriesPaused: true, entriesPausedReason: '3 consecutive engine cycles failed' });
  const line = r.reasons.find((x) => x.startsWith('new entries paused'));
  assert.equal((line.match(/new entries paused/gi) || []).length, 1);
});
