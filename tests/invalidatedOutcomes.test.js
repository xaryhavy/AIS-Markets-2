const test = require('node:test');
const assert = require('node:assert/strict');
const nt = require('../src/governance/noTrade');

const T0 = Date.UTC(2026, 9, 27, 10, 0); // a weekday decision minute
const MIN = 60000;
const dec = extra => ({
  timestamp: new Date(T0 + 30000).toISOString(),
  levels: { action: 'BUY', entry: 1.1, stopLoss: 1.09, takeProfit: 1.13 },
  horizonMinutes: 60,
  ...extra
});
const c = (m, low, high) => ({ time: T0 + m * MIN, open: 1.1, high, low, close: 1.1 });

test('an opportunity with no pending entry is never invalidated (behaviour unchanged)', () => {
  const r = nt.resolveOutcome(dec({}), [c(1, 1.095, 1.105), c(2, 1.095, 1.135)], T0 + 90 * MIN);
  assert.equal(r.status, 'TARGET_HIT');
});

test('price breaching the invalidation level before the entry triggers invalidates the opportunity, with its rule and time', () => {
  const d = dec({ entryTrigger: 1.1, invalidationLevel: 1.095 });
  // Minute 1 breaches 1.095 without touching the entry at 1.10.
  const r = nt.resolveOutcome(d, [c(1, 1.094, 1.099), c(2, 1.09, 1.12)], T0 + 90 * MIN);
  assert.equal(r.status, 'INVALIDATED');
  assert.equal(r.rule, 'PRICE_BREACHED_BEFORE_ENTRY');
  assert.equal(r.invalidatedAt, new Date(T0 + 2 * MIN).toISOString());
});

test('a breach after the entry has triggered does not invalidate; the trade is resolved normally', () => {
  const d = dec({ entryTrigger: 1.1, invalidationLevel: 1.095 });
  // Minute 1 touches the entry; minute 2 later breaches the invalidation level, but the target comes first.
  const r = nt.resolveOutcome(d, [c(1, 1.099, 1.101), c(2, 1.12, 1.135)], T0 + 90 * MIN);
  assert.equal(r.status, 'TARGET_HIT');
});

test('evidence expiring before the entry triggers invalidates the opportunity, with its rule', () => {
  const expiry = new Date(T0 + 3 * MIN).toISOString();
  const d = dec({ entryTrigger: 1.1, invalidationLevel: 1.0, evidenceExpiresAt: expiry });
  const r = nt.resolveOutcome(d, [c(1, 1.105, 1.11), c(2, 1.105, 1.11), c(3, 1.105, 1.11)], T0 + 90 * MIN);
  assert.equal(r.status, 'INVALIDATED');
  assert.equal(r.rule, 'EVIDENCE_EXPIRED_BEFORE_ENTRY');
  assert.equal(r.invalidatedAt, expiry);
});

test('a candle that both breaches and touches the entry is recorded under the conservative SAME_CANDLE rule', () => {
  const d = dec({ entryTrigger: 1.1, invalidationLevel: 1.095 });
  const r = nt.resolveOutcome(d, [c(1, 1.09, 1.11)], T0 + 90 * MIN);
  assert.equal(r.status, 'INVALIDATED');
  assert.match(r.rule, /SAME_CANDLE/);
});

test('a pending entry that has not triggered is unresolved while the horizon runs, and expires with no entry after it', () => {
  const d = dec({ entryTrigger: 1.0, invalidationLevel: 0.9 });
  assert.equal(nt.resolveOutcome(d, [c(1, 1.05, 1.06)], T0 + 10 * MIN).status, 'UNRESOLVED');
  assert.equal(nt.resolveOutcome(d, [c(1, 1.05, 1.06)], T0 + 90 * MIN).status, 'EXPIRED');
});

test('summaries count INVALIDATED and report its rate, but it never enters the win or loss counts', () => {
  const outs = [
    { status: 'TARGET_HIT', reasonCode: 'RR_FLOOR' },
    { status: 'STOP_HIT', reasonCode: 'RR_FLOOR' },
    { status: 'INVALIDATED', reasonCode: 'RR_FLOOR' },
    { status: 'INVALIDATED', reasonCode: 'RR_FLOOR' }
  ];
  const g = nt.summarise(outs, 'reasonCode').RR_FLOOR;
  assert.equal(g.n, 4);
  assert.equal(g.INVALIDATED, 2);
  assert.equal(g.invalidatedRate, 0.5);
  assert.equal(g.decisive, 2, 'only target and stop are decisive');
  assert.equal(g.targetRate, 0.5);
});

test('the exact rule and timestamp that invalidated an opportunity are the only values stored for it', () => {
  const d = dec({ entryTrigger: 1.1, invalidationLevel: 1.095 });
  const r = nt.resolveOutcome(d, [c(1, 1.09, 1.099)], T0 + 90 * MIN);
  assert.deepEqual(Object.keys(r).sort(), ['invalidatedAt', 'rule', 'status']);
});
