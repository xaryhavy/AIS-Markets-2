const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/security/auth');

test('the address locks after the maximum number of failures', () => {
  const t0 = 1_000_000;
  for (let i = 1; i < auth.MAX_FAILURES; i++) {
    assert.equal(auth.recordFailure('10.0.0.1', t0).lockedUntil, 0, `not locked after ${i}`);
  }
  const last = auth.recordFailure('10.0.0.1', t0);
  assert.equal(last.count, auth.MAX_FAILURES);
  assert.equal(last.lockedUntil, t0 + auth.LOCK_MS);
  assert.equal(auth.lockedFor('10.0.0.1', t0 + 1000), auth.LOCK_MS - 1000);
});

test('the lock expires after its duration', () => {
  const t0 = 2_000_000;
  for (let i = 0; i < auth.MAX_FAILURES; i++) auth.recordFailure('10.0.0.2', t0);
  assert.equal(auth.lockedFor('10.0.0.2', t0 + auth.LOCK_MS - 1), 1);
  assert.equal(auth.lockedFor('10.0.0.2', t0 + auth.LOCK_MS), 0);
});

test('failures spread outside the window do not accumulate', () => {
  const t0 = 3_000_000;
  for (let i = 0; i < auth.MAX_FAILURES - 1; i++) auth.recordFailure('10.0.0.3', t0 + i);
  const later = auth.recordFailure('10.0.0.3', t0 + 16 * 60000);
  assert.equal(later.count, 1, 'a new window starts after 15 minutes');
  assert.equal(auth.lockedFor('10.0.0.3', t0 + 16 * 60000), 0);
});

test('a successful clear resets the count and an unrelated address is unaffected', () => {
  const t0 = 4_000_000;
  for (let i = 0; i < auth.MAX_FAILURES - 1; i++) auth.recordFailure('10.0.0.4', t0);
  auth.clearFailures('10.0.0.4');
  assert.equal(auth.recordFailure('10.0.0.4', t0).count, 1);
  for (let i = 0; i < auth.MAX_FAILURES; i++) auth.recordFailure('10.0.0.5', t0);
  assert.equal(auth.lockedFor('10.0.0.6', t0), 0);
});
