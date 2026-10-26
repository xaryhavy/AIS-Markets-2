const test = require('node:test');
const assert = require('node:assert/strict');
// Fake-broker events must never reach the real audit trail: point it at a temporary file first.
process.env.AIS_AUDIT_FILE = require('node:path').join(require('node:os').tmpdir(), `ais-exec-audit-${process.pid}.log`);
const trading = require('../src/ctrader/trading');
const marketFeed = require('../src/ctrader/marketFeed');
const safety = require('../src/execution/safety');
const limits = require('../src/risk/limits');
const TEST_CTX = { cfg: limits.active(), balance: 10000, price: 1.1, bid: 1.09999, ask: 1.10001, openPositions: [], emergency: false, consecutiveLosses: 0, drawdownPct: 0, nowMs: Date.now() };

// Symbol metadata and rounding without a live feed.
marketFeed.getInfo = () => ({ symbolId: 1, name: 'EURUSD', digits: 5, minVolume: 1000, maxVolume: 1e9, stepVolume: 1000 });
marketFeed.unitsToVolume = () => 100000;
marketFeed.roundPrice = (s, p) => Number(p.toFixed(5));

function memStore() {
  const data = {};
  return {
    data,
    async load(c) { return (data[c] || []).map(x => ({ ...x })); },
    async append(c, item) { (data[c] ||= []).push({ ...item }); return item; },
    async update(c, id, patch) {
      const arr = data[c] || [];
      const i = arr.findIndex(x => x.id === id);
      if (i >= 0) arr[i] = { ...arr[i], ...patch };
      return arr[i];
    }
  };
}

function fakeClient({ newOrder, amend, close }) {
  const calls = [];
  return {
    calls,
    async newMarketOrder(req) { calls.push(['new', req]); return newOrder(req); },
    async amendSltp(req) { calls.push(['amend', req]); return amend ? amend(req) : {}; },
    async closePosition(req) { calls.push(['close', req]); return close ? close(req) : {}; }
  };
}

const filled = () => ({
  position: { positionId: 101, tradeData: { volume: 100000 } },
  deal: { executionPrice: 1.1 },
  order: { orderId: 5 }
});
const params = { symbol: 'EURUSD', action: 'BUY', units: 1000, stopLoss: 1.097, takeProfit: 1.109 };

test('a filled order is recorded as FILLED with protection verified', async () => {
  const store = memStore();
  const client = fakeClient({ newOrder: async () => filled() });
  const r = await trading.openWith({ client, accountId: 1, store }, params, TEST_CTX);
  assert.equal(r.positionId, 101);
  const intent = store.data[trading.INTENTS][0];
  assert.equal(intent.status, 'FILLED');
  assert.equal(client.calls.filter(c => c[0] === 'amend').length, 1);
});

test('a timed-out order is UNKNOWN, not a failure, and the error says so', async () => {
  const store = memStore();
  const client = fakeClient({ newOrder: async () => { throw new Error('cTrader request timed out: ProtoOANewOrderReq'); } });
  await assert.rejects(trading.openWith({ client, accountId: 1, store }, params, TEST_CTX), trading.UnknownOutcomeError);
  assert.equal(store.data[trading.INTENTS][0].status, 'UNKNOWN');
  assert.equal(client.calls.some(c => c[0] === 'close'), false, 'must not close what it cannot see');
});

test('a broker refusal is REJECTED and nothing is left open', async () => {
  const store = memStore();
  const client = fakeClient({ newOrder: async () => { throw new Error('Order rejected: NOT_ENOUGH_MONEY'); } });
  await assert.rejects(trading.openWith({ client, accountId: 1, store }, params, TEST_CTX), e => !(e instanceof trading.UnknownOutcomeError));
  assert.equal(store.data[trading.INTENTS][0].status, 'REJECTED');
});

test('if protection fails and the close works, the position is emergency-closed', async () => {
  const store = memStore();
  const client = fakeClient({
    newOrder: async () => filled(),
    amend: async () => { throw new Error('cTrader request timed out: ProtoOAAmendPositionSLTPReq'); }
  });
  await assert.rejects(trading.openWith({ client, accountId: 1, store }, params, TEST_CTX), /could not be attached/);
  assert.equal(store.data[trading.INTENTS][0].status, 'CLOSED_EMERGENCY');
});

test('if protection fails and the close also fails, the intent is PROTECTION_FAILED (blocks entries)', async () => {
  const store = memStore();
  const client = fakeClient({
    newOrder: async () => filled(),
    amend: async () => { throw new Error('amend timed out'); },
    close: async () => { throw new Error('close timed out'); }
  });
  await assert.rejects(trading.openWith({ client, accountId: 1, store }, params, TEST_CTX));
  assert.equal(store.data[trading.INTENTS][0].status, 'PROTECTION_FAILED');
});

test('reconciliation adopts the broker position that matches an unknown order and protects it', async () => {
  const store = memStore();
  const createdAt = new Date('2026-10-25T10:00:00Z').toISOString();
  store.data[trading.INTENTS] = [{ id: 'INT-1', status: 'UNKNOWN', symbol: 'EURUSD', symbolId: 1, action: 'BUY', volume: 100000, stopLoss: 1.097, takeProfit: 1.109, createdAt }];
  const client = fakeClient({});
  const brokerPositions = [{ positionId: 202, price: 1.1, tradeData: { symbolId: 1, volume: 100000, tradeSide: 'BUY', openTimestamp: Date.parse(createdAt) + 1000 } }];
  const r = await trading.resolveIntents({ client, accountId: 1, store, knownPositionIds: new Set(), brokerPositions, nowMs: Date.parse(createdAt) + 5000 });
  assert.equal(r.adopted.length, 1);
  assert.equal(store.data[trading.INTENTS][0].status, 'FILLED');
  const amend = client.calls.find(c => c[0] === 'amend')[1];
  assert.equal(amend.positionId, 202);
  assert.equal(amend.stopLoss, 1.097);
  assert.equal(amend.takeProfit, 1.109);
});

test('a position AIS already tracks is never adopted twice', async () => {
  const store = memStore();
  const createdAt = new Date('2026-10-25T10:00:00Z').toISOString();
  store.data[trading.INTENTS] = [{ id: 'INT-1', status: 'UNKNOWN', symbol: 'EURUSD', symbolId: 1, action: 'BUY', volume: 100000, stopLoss: 1.097, takeProfit: 1.109, createdAt }];
  const brokerPositions = [{ positionId: 202, price: 1.1, tradeData: { symbolId: 1, volume: 100000, tradeSide: 'BUY', openTimestamp: Date.parse(createdAt) } }];
  const r = await trading.resolveIntents({ client: fakeClient({}), accountId: 1, store, knownPositionIds: new Set([202]), brokerPositions, nowMs: Date.parse(createdAt) + 5000 });
  assert.equal(r.adopted.length, 0);
});

test('an unknown order stays unresolved inside the grace period and is NOT_FILLED after it', async () => {
  const createdAt = new Date('2026-10-25T10:00:00Z').toISOString();
  const base = { id: 'INT-1', status: 'UNKNOWN', symbol: 'EURUSD', symbolId: 1, action: 'BUY', volume: 100000, stopLoss: 1.097, takeProfit: 1.109, createdAt };
  const inside = memStore(); inside.data[trading.INTENTS] = [{ ...base }];
  const r1 = await trading.resolveIntents({ client: fakeClient({}), accountId: 1, store: inside, knownPositionIds: new Set(), brokerPositions: [], nowMs: Date.parse(createdAt) + 10000 });
  assert.equal(r1.remaining.length, 1);
  assert.equal(inside.data[trading.INTENTS][0].status, 'UNKNOWN');

  const after = memStore(); after.data[trading.INTENTS] = [{ ...base }];
  await trading.resolveIntents({ client: fakeClient({}), accountId: 1, store: after, knownPositionIds: new Set(), brokerPositions: [], nowMs: Date.parse(createdAt) + 200000 });
  assert.equal(after.data[trading.INTENTS][0].status, 'NOT_FILLED');
});

test('a submission left hanging by a crash is also resolved, so it cannot block entries forever', async () => {
  const createdAt = new Date('2026-10-25T10:00:00Z').toISOString();
  const store = memStore();
  store.data[trading.INTENTS] = [{ id: 'INT-2', status: 'SUBMITTING', symbol: 'EURUSD', symbolId: 1, action: 'BUY', volume: 100000, stopLoss: 1.097, takeProfit: 1.109, createdAt }];
  await trading.resolveIntents({ client: fakeClient({}), accountId: 1, store, knownPositionIds: new Set(), brokerPositions: [], nowMs: Date.parse(createdAt) + 200000 });
  assert.equal(store.data[trading.INTENTS][0].status, 'NOT_FILLED');
});

test('entries are blocked by stale quotes, unresolved orders, unmanaged positions, or a dead feed', () => {
  assert.deepEqual(safety.entryBlockers({ feedReady: true, quoteAgeMs: 1000 }), []);
  assert.match(safety.entryBlockers({ feedReady: true, quoteAgeMs: 60000 })[0], /stale/);
  assert.match(safety.entryBlockers({ feedReady: true, quoteAgeMs: NaN })[0], /unknown/);
  assert.match(safety.entryBlockers({ feedReady: true, quoteAgeMs: 0, unresolvedIntents: [{}] })[0], /not yet confirmed/);
  assert.match(safety.entryBlockers({ feedReady: true, quoteAgeMs: 0, unmanagedPositions: [{}] })[0], /no local record/);
  assert.match(safety.entryBlockers({ feedReady: false, quoteAgeMs: 0 })[0], /feed/);
});
