const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A full engine cycle in PAPER mode, with the broker stubbed to fail if it is called.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-paperwire-'));
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
process.env.AIS_DATA_DIR = dir;
const engine = require('../src/engine/tradingEngine');
const mtmCaps = require('../src/risk/mtmCaps');
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

test('in PAPER mode a full cycle fills on paper and never reaches the broker order call', async () => {
  const calls = { openMarket: 0, openPosition: 0, openPaperPosition: 0 };
  const saved = [];
  const pairs = [
    [mode, 'current', () => 'PAPER'],
    [mode, 'allowsBrokerOrders', () => false],
    [mode, 'expireIfDue', async () => false],
    [trading, 'reconcile', async () => ({ adopted: [], emergencyClosed: [], unmanaged: [], unresolved: [] })],
    [trading, 'isReady', () => true],
    [trading, 'openMarket', async () => { calls.openMarket++; throw new Error('a broker order was attempted in PAPER mode'); }],
    [orderManager, 'openPosition', async () => { calls.openPosition++; throw new Error('the broker path was used in PAPER mode'); }],
    [orderManager, 'openPaperPosition', async () => { calls.openPaperPosition++; return { id: 'paper-x', evidenceMode: 'PAPER' }; }],
    [orderManager, 'syncWithBroker', async () => []],
    [orderManager, 'checkAndClosePositions', async () => []],
    [mtmCaps, 'equitySnapshot', async () => 1000],
    [governance, 'allowTrade', async () => ({ allow: true })],
    [signalEngine, 'scanAll', async () => [{ symbol: 'EURUSD', action: 'BUY', qualified: true, score: 80, regime: 'RANGING', indicators: {} }]],
    [marketData, 'getSymbols', () => ['EURUSD']],
    [marketData, 'getPrice', () => 1.1],
    [marketData, 'quoteAgeMs', () => 100],
    [dataQuality, 'assess', () => ({ ok: true, reasons: [], reasonCodes: [], frames: { M1: { fingerprint: 'fp' } } })],
    [dataQuality, 'recordEpisode', async () => {}],
    [dataQuality, 'completedBars', () => Array.from({ length: 60 }, (_, i) => ({ time: i * 60000, open: 1.1, high: 1.102, low: 1.098, close: 1.1 }))],
    [timeframes, 'analyzeLive', () => ({ H1: 'UP', M15: 'UP' })],
    [timeframes, 'allows', () => true],
    [adaptiveLearner, 'getPositionMultiplier', async () => 1],
    [adaptiveLearner, 'updateOnTrade', async () => {}],
    [mlModel, 'maybeRetrain', async () => {}],
    [patternMiner, 'approvalScore', () => 0],
    [guardrails, 'fenceStatus', () => ({ fenceActive: false })],
    [riskManager, 'calculatePositionSize', async () => 1000],
    [riskManager, 'checkRisk', async () => ({ allow: true })],
    [alerts, 'sync', async () => {}],
    [storage, 'load', async () => []],
    [storage, 'append', async () => ({})],
    [storage, 'save', async () => {}],
  ];
  for (const [o, k, v] of pairs) { saved.push([o, k, o[k]]); o[k] = v; }
  try {
    await engine.runCycle();
    assert.equal(calls.openMarket, 0, 'no broker order');
    assert.equal(calls.openPosition, 0, 'no broker position path');
    assert.equal(calls.openPaperPosition, 1, 'the entry was filled on paper');
  } finally {
    for (const [o, k, v] of saved) o[k] = v;
  }
});
