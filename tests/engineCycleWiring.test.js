const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Runs the real runCycle with its external dependencies stubbed: no broker, no storage writes, no alerts.
process.env.AIS_AUDIT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ais-wire-')), 'audit.log');
const engine = require('../src/engine/tradingEngine');
const trading = require('../src/ctrader/trading');
const orderManager = require('../src/execution/orderManager');
const governance = require('../src/governance');
const signalEngine = require('../src/intelligence/signalEngine');
const marketData = require('../src/data/marketdata');
const dataQuality = require('../src/data/quality');
const timeframes = require('../src/intelligence/timeframes');
const storage = require('../src/data/storage');
const alerts = require('../src/ops/alerts');
const adaptiveLearner = require('../src/intelligence/adaptiveLearner');
const mlModel = require('../src/intelligence/mlModel');
const shadowTracker = require('../src/governance/shadowTracker');
const patternMiner = require('../src/intelligence/patternMiner');
const mode = require('../src/governance/mode');
const guardrails = require('../src/governance/guardrails');
const riskManager = require('../src/risk/riskManager');

const originals = {};
function stub(obj, name, fn) { originals[`${obj === trading ? 'trading' : name}`] = originals[name] || obj[name]; obj[name] = fn; }
function setup({ reconcileThrows = false, allow = true, closed = [], price = undefined } = {}) {
  const calls = { openMarket: 0, syncWithBroker: 0, checkAndClose: 0, decisions: [] };
  const saved = [];
  const pairs = [
    [trading, 'reconcile', async () => { if (reconcileThrows) throw new Error('broker timeout'); return { adopted: [], emergencyClosed: [], unmanaged: [], unresolved: [] }; }],
    [trading, 'isReady', () => true],
    [trading, 'openMarket', async () => { calls.openMarket++; return {}; }],
    [orderManager, 'syncWithBroker', async () => { calls.syncWithBroker++; return []; }],
    [orderManager, 'checkAndClosePositions', async () => { calls.checkAndClose++; return closed; }],
    [governance, 'allowTrade', async () => (allow ? { allow: true } : { allow: false, reason: 'owner switch off' })],
    [signalEngine, 'scanAll', async () => [{ symbol: 'EURUSD', action: 'BUY', qualified: true, score: 80, regime: 'RANGING', indicators: {} }]],
    [marketData, 'getSymbols', () => ['EURUSD']],
    [marketData, 'getPrice', () => price],
    [riskManager, 'calculatePositionSize', async () => 0],
    [dataQuality, 'completedBars', () => Array.from({ length: 60 }, (_, i) => ({ time: i * 60000, open: 1.1, high: 1.102, low: 1.098, close: 1.1 + (i % 2) * 0.0005 }))],
    [marketData, 'quoteAgeMs', () => 100],
    [dataQuality, 'assess', () => ({ ok: true, reasons: [], frames: { M1: { fingerprint: 'fp' } } })],
    [timeframes, 'analyzeLive', () => ({ H1: 'UP', M15: 'UP' })],
    [timeframes, 'allows', () => true],
    [adaptiveLearner, 'getPositionMultiplier', async () => 1],
    [adaptiveLearner, 'updateOnTrade', async () => {}],
    [mlModel, 'maybeRetrain', async () => {}],
    [patternMiner, 'approvalScore', () => 0],
    [mode, 'allowsBrokerOrders', () => true],
    [mode, 'current', () => 'DEMO_AUTONOMOUS'],
    [guardrails, 'fenceStatus', () => ({ fenceActive: false })],
    [alerts, 'sync', async () => {}],
    [storage, 'load', async () => []],
    [storage, 'append', async (c, item) => { if (c === 'decisions') calls.decisions.push(item); return item; }],
    [storage, 'save', async () => {}],
  ];
  for (const [o, k, v] of pairs) { saved.push([o, k, o[k]]); o[k] = v; }
  return { calls, restore: () => saved.forEach(([o, k, v]) => { o[k] = v; }) };
}

test('an entry is blocked when reconciliation fails, and no order is sent', async () => {
  const s = setup({ reconcileThrows: true });
  try {
    await engine.runCycle();
    assert.equal(s.calls.openMarket, 0, 'no broker order');
    const d = s.calls.decisions.find(x => x.decision === 'SKIPPED');
    assert.ok(d, 'the rejected signal is recorded');
    assert.match(d.skipReason, /Entries paused/);
    // The reason names the blocking condition. A failed reconciliation is recorded as unconfirmed outcomes.
    assert.match(d.skipReason, /not yet confirmed by the broker/);
  } finally { s.restore(); }
});

test('exits still run when new entries are switched off by the owner', async () => {
  const closed = [{ symbol: 'EURUSD', action: 'BUY', pnl: 12, closeReason: 'take profit', features: {} }];
  const s = setup({ allow: false, closed });
  try {
    await engine.runCycle();
    assert.equal(s.calls.syncWithBroker, 1, 'broker sync runs');
    assert.equal(s.calls.checkAndClose, 1, 'exit checks run');
    assert.equal(s.calls.openMarket, 0, 'no new entry');
    assert.equal(s.calls.decisions.length, 0, 'no entry decision is evaluated while switched off');
  } finally { s.restore(); }
});

test('with reconciliation healthy and entries allowed, the signal reaches the order path', async () => {
  const s = setup({ price: 1.1 });
  try {
    await engine.runCycle();
    // With a price and healthy reconciliation the signal passes the entry blockers and stops at position size (forced to 0).
    const d = s.calls.decisions.find(x => x.decision === 'SKIPPED');
    assert.ok(d, 'the signal reaches a later gate');
    assert.equal(d.skipReason, 'Zero position size');
    assert.equal(s.calls.openMarket, 0);
  } finally { s.restore(); }
});
