const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Never touch the real data folder: storage is pointed at a temp folder before it is loaded.
process.env.AIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-dedupe-'));
const storage = require('../src/data/storage');
const marketData = require('../src/data/marketdata');
const shadowTracker = require('../src/governance/shadowTracker');
const noTrade = require('../src/governance/noTrade');

// In-memory store patched onto the storage module, so the real data folder is never touched.
const real = { load: storage.load, save: storage.save, append: storage.append, update: storage.update, mutate: storage.mutate };
const realHistory = marketData.getHistory;
let store;
function useMemory(candles = []) {
  store = { decisions: [], no_trade_outcomes: [] };
  storage.load = async c => JSON.parse(JSON.stringify(store[c] || []));
  storage.save = async (c, d) => { store[c] = JSON.parse(JSON.stringify(d)); };
  storage.append = async (c, item) => { (store[c] ||= []).push(item); return item; };
  storage.update = async () => {};
  storage.mutate = async (c, fn) => {
    const next = await fn(JSON.parse(JSON.stringify(store[c] || [])));
    if (next !== undefined) store[c] = JSON.parse(JSON.stringify(next));
    return next;
  };
  marketData.getHistory = () => candles;
}
function restore() {
  Object.assign(storage, real);
  marketData.getHistory = realHistory;
}

const levels = { action: 'BUY', entry: 1.1, stopLoss: 1.09, takeProfit: 1.11 };
const waitSignal = (symbol = 'EURUSD') => ({ symbol, action: 'BUY', qualified: true, levels });

test('a repeated WAIT for the same symbol and reason is not logged again as a decision', async () => {
  useMemory();
  try {
    const info = { decision: 'SKIPPED', reason: 'Data quality: M1: 5 gap(s) in the last 30 candles' };
    await shadowTracker.recordDecision(waitSignal(), info);
    await shadowTracker.recordDecision(waitSignal(), info);
    await shadowTracker.recordDecision(waitSignal(), info);
    assert.equal(store.decisions.length, 1, 'one decision kept for the streak');
    assert.equal(store.no_trade_outcomes.length, 2, 'each repeat keeps its frozen levels');
    for (const o of store.no_trade_outcomes) {
      assert.equal(o.status, 'PENDING');
      assert.deepEqual(o.levels, levels);
      assert.equal(o.collapsedInto, store.decisions[0].id);
    }
  } finally { restore(); }
});

test('a different reason starts a new logged decision', async () => {
  useMemory();
  try {
    await shadowTracker.recordDecision(waitSignal(), { decision: 'SKIPPED', reason: 'Data quality: gap' });
    await shadowTracker.recordDecision(waitSignal(), { decision: 'SKIPPED', reason: 'Cooling down after a failed order' });
    assert.equal(store.decisions.length, 2);
    assert.equal(store.no_trade_outcomes.length, 0);
  } finally { restore(); }
});

test('an executed trade in between ends the streak, so the next WAIT is logged', async () => {
  useMemory();
  try {
    const info = { decision: 'SKIPPED', reason: 'Data quality: gap' };
    await shadowTracker.recordDecision(waitSignal(), info);
    await shadowTracker.recordDecision(waitSignal(), { decision: 'EXECUTED' });
    await shadowTracker.recordDecision(waitSignal(), info);
    assert.equal(store.decisions.length, 3);
  } finally { restore(); }
});

test('streaks are tracked per symbol', async () => {
  useMemory();
  try {
    const info = { decision: 'SKIPPED', reason: 'Data quality: gap' };
    await shadowTracker.recordDecision(waitSignal('EURUSD'), info);
    await shadowTracker.recordDecision(waitSignal('GBPUSD'), info);
    await shadowTracker.recordDecision(waitSignal('EURUSD'), info);
    assert.equal(store.decisions.length, 2, 'EURUSD repeat collapsed, GBPUSD logged once');
    assert.equal(store.no_trade_outcomes.length, 1);
  } finally { restore(); }
});

test('a WAIT without frozen levels is never collapsed', async () => {
  useMemory();
  try {
    const info = { decision: 'SKIPPED', reason: 'Data quality: gap' };
    const noLevels = { symbol: 'EURUSD', action: 'BUY', qualified: true };
    await shadowTracker.recordDecision(noLevels, info);
    await shadowTracker.recordDecision(noLevels, info);
    assert.equal(store.decisions.length, 2);
    assert.equal(store.no_trade_outcomes.length, 0);
  } finally { restore(); }
});

test('the monitor resolves a collapsed repeat from its own frozen levels', async () => {
  const base = Date.parse('2026-10-25T10:00:00Z');
  // Completed M1 candles after the decision minute: the second one reaches the target.
  const candles = [
    { time: base + 60000, open: 1.1, high: 1.1005, low: 1.0995, close: 1.1 },
    { time: base + 120000, open: 1.1, high: 1.112, low: 1.0998, close: 1.111 }
  ];
  useMemory(candles);
  try {
    const info = { decision: 'SKIPPED', reason: 'Data quality: gap' };
    await shadowTracker.recordDecision(waitSignal(), info);
    await shadowTracker.recordDecision(waitSignal(), info);
    store.decisions[0].timestamp = new Date(base + 30000).toISOString();
    store.no_trade_outcomes[0].timestamp = new Date(base + 30000).toISOString();
    await noTrade.runMonitor(base + 2 * 3600000);
    const pending = store.no_trade_outcomes.find(o => o.decisionId);
    assert.equal(pending.status, 'TARGET_HIT');
    assert.deepEqual(pending.levels, levels, 'frozen levels are kept on the outcome');
    assert.equal(pending.exitPrice, 1.11);
  } finally { restore(); }
});
