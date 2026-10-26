const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-unmanaged-'));
process.env.AIS_DATA_DIR = dir;
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const audit = require('../src/audit/audit');
const storage = require('../src/data/storage');
const um = require('../src/execution/unmanaged');

const broker = (id, extra = {}) => ({
  positionId: id, price: 1.1, stopLoss: 1.09, takeProfit: 1.13,
  tradeData: { symbolId: 1, volume: 100000, tradeSide: 'BUY', openTimestamp: Date.UTC(2026, 9, 26, 9) },
  ...extra
});
const symbolFor = () => 'EURUSD';
const auditTypes = () => fs.existsSync(audit.AUDIT_FILE)
  ? fs.readFileSync(audit.AUDIT_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).type) : [];

test('protection status is read from the broker stop and target', () => {
  assert.equal(um.protectionStatus(broker(1)), 'PROTECTED');
  assert.equal(um.protectionStatus(broker(1, { takeProfit: null })), 'PARTIAL: stop-loss only');
  assert.equal(um.protectionStatus(broker(1, { stopLoss: null, takeProfit: null })), 'UNPROTECTED');
});

test('the read-only description carries the symbol, side, volume, levels and protection', () => {
  const d = um.describe(broker(42), symbolFor);
  assert.equal(d.positionId, 42);
  assert.equal(d.symbol, 'EURUSD');
  assert.equal(d.side, 'BUY');
  assert.equal(d.volume, 100000);
  assert.equal(d.protection, 'PROTECTED');
});

test('nothing is resolved without an action from the allowed set', async () => {
  await assert.rejects(um.resolve({ positionId: 1, action: 'FORCE_CLOSE', reason: 'some reason', current: [broker(1)], deps: {} }), /action must be one of ADOPT, CLOSE, IGNORE/);
});

test('a position that is not currently unmanaged cannot be resolved', async () => {
  await assert.rejects(um.resolve({ positionId: 99, action: 'IGNORE', reason: 'some reason here', current: [broker(1)], deps: {} }), /not currently unmanaged/);
});

test('every resolution needs a recorded reason of at least ten characters', async () => {
  await assert.rejects(um.resolve({ positionId: 1, action: 'IGNORE', reason: 'short', current: [broker(1)], deps: {} }), /at least 10 characters/);
  await assert.rejects(um.resolve({ positionId: 1, action: 'IGNORE', current: [broker(1)], deps: {} }), /at least 10 characters/);
});

test('ignore records the reason, is audited, and stops blocking entries for that position', async () => {
  await um.resolve({ positionId: 7, action: 'IGNORE', reason: 'manual hedge placed on purpose', actor: 'owner', current: [broker(7)], deps: { symbolFor } });
  const ids = await um.ignoredIds();
  assert.ok(ids.has('7'));
  const row = (await storage.load(um.COLLECTION)).find(r => r.positionId === 7);
  assert.equal(row.action, 'IGNORE');
  assert.equal(row.reason, 'manual hedge placed on purpose');
  assert.equal(row.actor, 'owner');
  assert.ok(auditTypes().includes('OWNER_UNMANAGED_RESOLVED'));
});

test('adopt records the position as an AIS trade through the supplied recorder, keeping its protection', async () => {
  let recorded = null;
  const deps = { symbolFor, recordAdopted: async (intent, pos) => { recorded = { intent, pos }; return { id: 'ctrader-' + pos.positionId }; } };
  const r = await um.resolve({ positionId: 8, action: 'ADOPT', reason: 'owner confirms this trade', actor: 'owner', current: [broker(8)], deps });
  assert.equal(recorded.intent.stopLoss, 1.09);
  assert.equal(recorded.intent.takeProfit, 1.13);
  assert.equal(recorded.intent.symbol, 'EURUSD');
  assert.equal(r.trade.id, 'ctrader-8');
});

test('close goes through the broker close path with the position volume, and records the result', async () => {
  let closed = null;
  const deps = { symbolFor, closeMarket: async args => { closed = args; return { exitPrice: 1.12, pnl: 2.5 }; } };
  const r = await um.resolve({ positionId: 9, action: 'CLOSE', reason: 'owner closes after review', actor: 'owner', current: [broker(9)], deps });
  assert.deepEqual(closed, { positionId: 9, volume: 100000 });
  assert.equal(r.close.pnl, 2.5);
  const row = (await storage.load(um.COLLECTION)).find(x => x.positionId === 9);
  assert.equal(row.pnl, 2.5);
});

test('an unprotected position is shown as such, and the resolution keeps that status on record', async () => {
  const deps = { symbolFor, recordAdopted: async () => ({ id: 'x' }) };
  const r = await um.resolve({ positionId: 10, action: 'ADOPT', reason: 'adopting without protection', actor: 'owner', current: [broker(10, { stopLoss: null, takeProfit: null })], deps });
  assert.equal(r.protection, 'UNPROTECTED');
});
