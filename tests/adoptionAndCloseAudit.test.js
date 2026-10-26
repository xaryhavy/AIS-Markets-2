const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep the audit file, intents and trades in temp folders. Nothing here reaches the real data folder.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-adopt-'));
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
process.env.AIS_DATA_DIR = dir;
const audit = require('../src/audit/audit');
const storage = require('../src/data/storage');
const connectionManager = require('../src/ctrader/connectionManager');
const marketFeed = require('../src/ctrader/marketFeed');
const auth = require('../src/ctrader/auth');
const trading = require('../src/ctrader/trading');
const orderManager = require('../src/execution/orderManager');

// Broker connection stubbed as ready, with a fake client that answers closes and protection amendments.
const client = {
  closePosition: async () => ({ deal: { executionPrice: 1.1 } }),
  amendSltp: async () => ({})
};
connectionManager.getStatus = () => ({ state: 'ACCOUNT_AUTHENTICATED' });
connectionManager.getClient = () => client;
marketFeed.isReady = () => true;
auth.getConfig = () => ({ environment: 'demo', accountId: 1 });

const auditTypes = () => fs.readFileSync(audit.AUDIT_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const INTENT = { id: 'INT-A', status: 'UNKNOWN', symbol: 'EURUSD', symbolId: 1, action: 'BUY', volume: 100000, stopLoss: 1.09, takeProfit: 1.13, createdAt: new Date().toISOString() };
const brokerPosition = { positionId: 555, price: 1.1, tradeData: { symbolId: 1, volume: 100000, tradeSide: 'BUY', openTimestamp: Date.now() } };

test('an adopted position is audited once, with the intent and position identifiers', async () => {
  await storage.save('order_intents', [{ ...INTENT }]);
  const r = await trading.resolveIntents({ client, accountId: 1, knownPositionIds: new Set(), brokerPositions: [brokerPosition] });
  assert.equal(r.adopted.length, 1);
  const adopted = auditTypes().filter(e => e.type === 'POSITION_ADOPTED');
  assert.equal(adopted.length, 1, 'exactly one adoption record');
  assert.deepEqual(adopted[0].fields, { intentId: 'INT-A', positionId: 555, symbol: 'EURUSD' });
});

test('a confirmed close is audited and the filled intent for that position becomes CLOSED', async () => {
  await storage.save('order_intents', [{ ...INTENT, id: 'INT-B', status: 'FILLED', positionId: 777 }]);
  const out = await trading.closeMarket({ positionId: 777, volume: 100000 });
  assert.equal(out.exitPrice, 1.1);
  const closed = auditTypes().filter(e => e.type === 'POSITION_CLOSED' && e.fields.positionId === 777);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].fields.volume, 100000);
  const intents = await storage.load('order_intents');
  assert.equal(intents.find(i => i.id === 'INT-B').status, 'CLOSED');
});

test('a close of a position with no filled intent still succeeds and is audited', async () => {
  await storage.save('order_intents', []);
  await trading.closeMarket({ positionId: 888, volume: 100000 });
  assert.ok(auditTypes().some(e => e.type === 'POSITION_CLOSED' && e.fields.positionId === 888));
});

test('an adopted position gets a trade record that the close path updates to CLOSED', async () => {
  await storage.save('trades', []);
  const trade = await orderManager.recordAdopted({ ...INTENT, id: 'INT-C' }, { ...brokerPosition, positionId: 999 });
  assert.equal(trade.status, 'OPEN');
  const closed = await orderManager.closeTrade(trade, 'Fault-injection test close');
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.closeReason, 'Fault-injection test close');
  assert.equal(closed.exitPrice, 1.1);
  const stored = (await storage.load('trades')).find(t => t.id === trade.id);
  assert.equal(stored.status, 'CLOSED');
  assert.equal(stored.adopted, true);
  assert.equal(stored.source, 'ctrader');
});
