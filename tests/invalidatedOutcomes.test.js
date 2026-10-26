const test = require('node:test');
const assert = require('node:assert/strict');
const nt = require('../src/governance/noTrade');
const es = require('../src/governance/entryStates');

const T0 = Date.UTC(2026, 9, 27, 10, 0); // a weekday decision minute
const MIN = 60000;
const iso = ms => new Date(ms).toISOString();
// Decision at 10:00:30, so the first candle that may be used starts at 10:01.
const base = { symbol: 'EURUSD', timestamp: iso(T0 + 30000), horizonMinutes: 60 };
const market = extra => ({ ...base, entryType: 'MARKET', levels: { action: 'BUY', entry: 1.1, stopLoss: 1.09, takeProfit: 1.13 }, ...extra });
const level = extra => ({ ...base, entryType: 'LEVEL', levels: { action: 'BUY', entry: 1.1, stopLoss: 1.09, takeProfit: 1.13 }, entryLevel: 1.1, invalidationLevel: 1.095, ...extra });
// Completed candle at minute m after T0 (m = 1 is the first usable candle).
const c = (m, low, high) => ({ time: T0 + m * MIN, open: 1.1, high, low, close: 1.1 });
const NOW_LATE = T0 + 200 * MIN;

test('market-style fill is the frozen quote plus the modelled half-spread, against the trader', () => {
  const buy = es.marketFill('BUY', 1.1, 'EURUSD');
  assert.equal(buy.fill, 1.1 + 0.00005);
  assert.equal(buy.costModel.halfSpread, 0.00005);
  const sell = es.marketFill('SELL', 1.1, 'EURUSD');
  assert.equal(sell.fill, 1.1 - 0.00005);
  const unknown = es.marketFill('BUY', 5, 'NOSUCH');
  assert.equal(unknown.fill, 5);
  assert.match(unknown.costModel.spreadSource, /none modelled/);
});

test('a market-style opportunity has no pending state: it goes straight to target, stop or expiry', () => {
  const r = nt.resolveOutcome(market({}), [c(1, 1.095, 1.105), c(2, 1.095, 1.135)], NOW_LATE);
  assert.equal(r.status, 'TARGET_HIT');
  assert.equal(nt.resolveOutcome(market({}), [c(1, 1.095, 1.105)], T0 + 10 * MIN).status, 'UNRESOLVED');
});

test('a level-style opportunity is PENDING_ENTRY while its entry window is open', () => {
  const r = nt.resolveOutcome(level({}), [c(1, 1.105, 1.11)], T0 + 5 * MIN);
  assert.equal(r.status, 'PENDING_ENTRY');
});

test('ENTERED: a completed candle trades through the entry level; then the trade resolves normally, with the rule and time', () => {
  const r = nt.resolveOutcome(level({}), [c(1, 1.105, 1.11), c(2, 1.099, 1.101), c(3, 1.12, 1.135)], NOW_LATE);
  assert.equal(r.status, 'TARGET_HIT');
  assert.equal(r.entryRule, 'ENTRY_LEVEL_TOUCHED');
  assert.equal(r.entryAt, iso(T0 + 2 * MIN));
  assert.ok(Number.isFinite(r.entryFill));
});

test('INVALIDATED by a breach before entry: the breach rule and the close time of the breaching candle are stored', () => {
  // Candle 1 stays clear of the entry (high 1.099 < 1.10) and of the invalidation level; candle 2 breaches it.
  const r = nt.resolveOutcome(level({}), [c(1, 1.097, 1.099), c(2, 1.09, 1.099)], NOW_LATE);
  assert.equal(r.status, 'INVALIDATED');
  assert.equal(r.rule, 'INVALIDATION_BREACHED_BEFORE_ENTRY');
  assert.equal(r.at, iso(T0 + 3 * MIN), 'stored at the close of the breaching candle');
});

test('INVALIDATED by evidence expiry before entry: the expiry time is stored', () => {
  const expiry = iso(T0 + 3 * MIN);
  const r = nt.resolveOutcome(level({ evidenceExpiresAt: expiry }), [c(1, 1.105, 1.11), c(2, 1.105, 1.11), c(3, 1.105, 1.11)], NOW_LATE);
  assert.equal(r.status, 'INVALIDATED');
  assert.equal(r.rule, 'EVIDENCE_EXPIRED_BEFORE_ENTRY');
  assert.equal(r.at, expiry);
});

test('EXPIRED_UNFILLED: the window ends with no entry and no invalidation', () => {
  const r = nt.resolveOutcome(level({}), [c(1, 1.105, 1.11), c(2, 1.105, 1.11)], NOW_LATE);
  assert.equal(r.status, 'EXPIRED_UNFILLED');
  assert.equal(r.rule, 'ENTRY_WINDOW_ENDED_NO_TOUCH');
});

test('the entry window is 12 candles by default and configurable; a touch after the window does not enter', () => {
  const late = [c(13, 1.09, 1.11)]; // touches the entry after 12 candles
  assert.equal(nt.resolveOutcome(level({}), late, NOW_LATE).status, 'EXPIRED_UNFILLED');
  const shortWindow = level({ entryWindowCandles: 3 });
  assert.equal(nt.resolveOutcome(shortWindow, [c(4, 1.1, 1.11)], NOW_LATE).status, 'EXPIRED_UNFILLED');
  // With a 5-candle window, a touch at candle 4 is inside the window: the opportunity enters.
  const inWindow = nt.resolveOutcome(level({ entryWindowCandles: 5 }), [c(4, 1.1, 1.11)], NOW_LATE);
  assert.equal(inWindow.entryRule, 'ENTRY_LEVEL_TOUCHED');
});

test('AMBIGUOUS_ENTRY: one candle touches both the entry level and the invalidation level', () => {
  const r = nt.resolveOutcome(level({}), [c(1, 1.09, 1.11)], NOW_LATE);
  assert.equal(r.status, 'AMBIGUOUS_ENTRY');
  assert.equal(r.rule, 'ENTRY_AND_INVALIDATION_SAME_CANDLE');
});

test('AMBIGUOUS_OUTCOME: the entry candle also touches the target, so the order is unknown and not counted', () => {
  // Low 1.10 touches the entry but does not breach the invalidation level (1.095); high 1.135 touches the target.
  const r = nt.resolveOutcome(level({}), [c(1, 1.1, 1.135)], NOW_LATE);
  assert.equal(r.status, 'AMBIGUOUS_OUTCOME');
  assert.equal(r.rule, 'ENTRY_CANDLE_TOUCHED_STOP_OR_TARGET');
});

test('no look-ahead: the candle the decision was made in is never used, even if it touches the entry', () => {
  const sameMinute = { time: T0, open: 1.1, high: 1.12, low: 1.09, close: 1.1 };
  const r = nt.resolveOutcome(level({}), [sameMinute], T0 + 5 * MIN);
  assert.equal(r.status, 'PENDING_ENTRY');
});

test('no look-ahead: incomplete candles are ignored', () => {
  const forming = c(1, 1.09, 1.11);
  assert.equal(nt.resolveOutcome(level({}), [forming], T0 + MIN + 10000).status, 'PENDING_ENTRY');
});

test('a level opportunity without a defined entry level is not evaluable, not invented', () => {
  const r = nt.resolveOutcome({ ...base, entryType: 'LEVEL', levels: { action: 'BUY', entry: 1.1, stopLoss: 1.09, takeProfit: 1.13 } }, [], NOW_LATE);
  assert.equal(r.status, 'NOT_EVALUABLE');
});

test('summaries: PENDING_ENTRY, INVALIDATED and EXPIRED_UNFILLED are counted with rates and never enter win or loss', () => {
  const outs = [
    { status: 'TARGET_HIT', reasonCode: 'X' }, { status: 'STOP_HIT', reasonCode: 'X' },
    { status: 'INVALIDATED', reasonCode: 'X' }, { status: 'EXPIRED_UNFILLED', reasonCode: 'X' },
    { status: 'PENDING_ENTRY', reasonCode: 'X' }, { status: 'AMBIGUOUS_ENTRY', reasonCode: 'X' }
  ];
  const g = nt.summarise(outs, 'reasonCode').X;
  assert.equal(g.n, 6);
  assert.equal(g.INVALIDATED, 1);
  assert.equal(g.EXPIRED_UNFILLED, 1);
  assert.equal(g.PENDING_ENTRY, 1);
  assert.equal(g.invalidatedRate, 0.167);
  assert.equal(g.expiredUnfilledRate, 0.167);
  assert.equal(g.pendingEntryRate, 0.167);
  assert.equal(g.decisive, 2, 'only target and stop are decisive');
  assert.equal(g.targetRate, 0.5);
});

test('every state change stores the exact rule and timestamp', () => {
  const r = nt.resolveOutcome(level({}), [c(1, 1.097, 1.099), c(2, 1.09, 1.099)], NOW_LATE);
  assert.equal(r.status, 'INVALIDATED');
  assert.deepEqual(Object.keys(r).sort(), ['at', 'rule', 'status']);
});
