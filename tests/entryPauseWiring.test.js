const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The engine cycle with entries paused: exits still run, nothing new is opened, and the decision is still recorded.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-pausewire-'));
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
process.env.AIS_DATA_DIR = dir;
const engine = require('../src/engine/tradingEngine');
const pause = require('../src/engine/entryPause');
const trading = require('../src/ctrader/trading');
const orderManager = require('../src/execution/orderManager');
const governance = require('../src/governance');
const signalEngine = require('../src/intelligence/signalEngine');
const marketData = require('../src/data/marketdata');
const dataQuality = require('../src/data/quality');
const timeframes = require('../src/intelligence/timeframes');
const alerts = require('../src/ops/alerts');
const storage = require('../src/data/storage');
const adaptiveLearner = require('../src/intelligence/adaptiveLearner');
const mlModel = require('../src/intelligence/mlModel');
const patternMiner = require('../src/intelligence/patternMiner');
const mode = require('../src/governance/mode');
const guardrails = require('../src/governance/guardrails');
const riskManager = require('../src/risk/riskManager');

test('with entries paused, exits run and no order is sent', async () => {
  const calls = { openMarket: 0, checkAndClose: 0, syncWithBroker: 0 };
  const saved = [];
  const pairs = [
    [trading, 'reconcile', async () => ({ adopted: [], emergencyClosed: [], unmanaged: [], unresolved: [] })],
    [trading, 'isReady', () => true],
    [trading, 'openMarket', async () => { calls.openMarket++; return {}; }],
    [orderManager, 'syncWithBroker', async () => { calls.syncWithBroker++; return []; }],
    [orderManager, 'checkAndClosePositions', async () => { calls.checkAndClose++; return []; }],
    [governance, 'allowTrade', async () => ({ allow: true })],
    [signalEngine, 'scanAll', async () => [{ symbol: 'EURUSD', action: 'BUY', qualified: true, score: 80, regime: 'RANGING', indicators: {} }]],
    [marketData, 'getSymbols', () => ['EURUSD']],
    [marketData, 'getPrice', () => 1.1],
    [marketData, 'quoteAgeMs', () => 100],
    [dataQuality, 'assess', () => ({ ok: true, reasons: [], frames: { M1: { fingerprint: 'fp' } } })],
    [dataQuality, 'completedBars', () => Array.from({ length: 60 }, (_, i) => ({ time: i * 60000, open: 1.1, high: 1.102, low: 1.098, close: 1.1 }))],
    [timeframes, 'analyzeLive', () => ({ H1: 'UP', M15: 'UP' })],
    [timeframes, 'allows', () => true],
    [adaptiveLearner, 'getPositionMultiplier', async () => 1],
    [adaptiveLearner, 'updateOnTrade', async () => {}],
    [mlModel, 'maybeRetrain', async () => {}],
    [patternMiner, 'approvalScore', () => 0],
    [mode, 'allowsBrokerOrders', () => true],
    [mode, 'current', () => 'DEMO_AUTONOMOUS'],
    [guardrails, 'fenceStatus', () => ({ fenceActive: false })],
    [riskManager, 'calculatePositionSize', async () => 0],
    [alerts, 'sync', async () => {}],
    [storage, 'load', async () => []],
    [storage, 'append', async () => ({})],
    [storage, 'save', async () => {}],
  ];
  for (const [o, k, v] of pairs) { saved.push([o, k, o[k]]); o[k] = v; }
  try {
    await pause.init();
    await pause.tripOnFailures(3);
    await engine.runCycle();
    assert.equal(calls.checkAndClose, 1, 'exit checks still run');
    assert.equal(calls.syncWithBroker, 1, 'broker sync still runs');
    assert.equal(calls.openMarket, 0, 'no new entry');
    assert.match(engine.getStats().lastBlockReason, /consecutive engine cycles failed/);
  } finally {
    for (const [o, k, v] of saved) o[k] = v;
  }
});
