const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-gate-'));
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
process.env.AIS_DATA_DIR = dir;
process.env.AIS_REGISTRY_FILE = path.join(dir, 'registry.json');

const engine = require('../src/engine/tradingEngine');
const signalEngine = require('../src/intelligence/signalEngine');
const registry = require('../src/strategy/registry');
const baseline = require('../src/strategy/baseline');
const mtmCaps = require('../src/risk/mtmCaps');
const trading = require('../src/ctrader/trading');
const orderManager = require('../src/execution/orderManager');
const governance = require('../src/governance');
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
const regimeDetector = require('../src/intelligence/regimeDetector');
const candlestickPatterns = require('../src/intelligence/candlestickPatterns');

function withStubs(pairs, fn) {
  const saved = pairs.map(([o, k]) => [o, k, o[k]]);
  for (const [o, k, v] of pairs) o[k] = v;
  return Promise.resolve()
    .then(fn)
    .finally(() => { for (const [o, k, v] of saved) o[k] = v; });
}

const bars = Array.from({ length: 60 }, (_, i) => ({
  time: i * 60000, open: 1.1, high: 1.102, low: 1.098, close: 1.1 + (i % 2) * 0.0005
}));

// The engine cycle, with everything outside the gate stubbed. `runnable` is what the gate reports.
function cycle(runnable) {
  const calls = { openMarket: 0, decisions: [] };
  return withStubs([
    [trading, 'reconcile', async () => ({ adopted: [], emergencyClosed: [], unmanaged: [], unresolved: [] })],
    [trading, 'isReady', () => true],
    [trading, 'openMarket', async () => { calls.openMarket++; return {}; }],
    [mtmCaps, 'equitySnapshot', async () => 1000],
    [orderManager, 'syncWithBroker', async () => []],
    [orderManager, 'checkAndClosePositions', async () => []],
    [governance, 'allowTrade', async () => ({ allow: true })],
    [signalEngine, 'runnableStrategies', async () => runnable],
    [signalEngine, 'scanAll', async () => [{ symbol: 'EURUSD', action: 'BUY', qualified: true, score: 80, regime: 'RANGING', indicators: {} }]],
    [marketData, 'getSymbols', () => ['EURUSD']],
    [marketData, 'getPrice', () => 1.1],
    [riskManager, 'calculatePositionSize', async () => 0],
    [dataQuality, 'completedBars', () => bars],
    [dataQuality, 'assess', () => ({ ok: true, reasons: [], frames: { M1: { fingerprint: 'fp' } } })],
    [dataQuality, 'recordEpisode', async () => {}],
    [marketData, 'quoteAgeMs', () => 100],
    [timeframes, 'analyzeLive', () => ({ H1: 'UP', M15: 'UP' })],
    [timeframes, 'allows', () => true],
    [adaptiveLearner, 'getPositionMultiplier', async () => 1],
    [mlModel, 'maybeRetrain', async () => {}],
    [patternMiner, 'approvalScore', () => 0],
    [mode, 'allowsBrokerOrders', () => true],
    [mode, 'current', () => 'DEMO_AUTONOMOUS'],
    [guardrails, 'fenceStatus', () => ({ fenceActive: false })],
    [alerts, 'sync', async () => {}],
    [shadowTracker, 'recordDecision', async (s, d) => { calls.decisions.push(d); }],
    [storage, 'load', async () => []],
    [storage, 'append', async (c, item) => item],
    [storage, 'save', async () => {}],
  ], async () => {
    await engine.runCycle();
    return calls;
  });
}

test('with nothing deployed the engine opens nothing and says why', async () => {
  const calls = await cycle(new Set());
  assert.equal(calls.openMarket, 0);
  assert.match(engine.getStats().lastBlockReason, /No strategy is deployed/);
});

test('a deployed strategy lets the cycle past the gate', async () => {
  const calls = await cycle(new Set(['smaCrossover']));
  // It reaches a later gate (position size is forced to zero here), which the empty registry never would.
  assert.ok(calls.decisions.some((d) => d.decision === 'SKIPPED'));
  assert.equal(engine.getStats().lastBlockReason, null);
});

test('only deployed versions vote in the ensemble; the rest are named', async () => {
  fs.rmSync(process.env.AIS_REGISTRY_FILE, { force: true });
  registry.resetCache();
  signalEngine.resetBaseline();

  // Adopt nothing, then deploy exactly one built-in. The others stay unregistered.
  await registry.adoptBaseline([]);
  const descriptor = baseline.descriptors().find((d) => d.strategy === 'smaCrossover');
  await registry.register(descriptor.strategy, descriptor.rules);
  await registry.approve(descriptor.strategy, 1, registry.hashRules(descriptor.rules), {
    reason: 'reviewed the rules and the backtest evidence'
  });
  await registry.deploy(descriptor.strategy, 1, { reason: 'arming it for the demo account' });

  const result = await withStubs([
    [dataQuality, 'completedBars', () => bars],
    [regimeDetector, 'classify', () => ({ regime: 'RANGING', confidence: 0.6 })],
    [adaptiveLearner, 'getWeight', async () => 1],
    [candlestickPatterns, 'detectAll', () => []],
  ], () => signalEngine.evaluateSymbol('EURUSD'));

  assert.equal(result.strategiesRun, 1);
  assert.deepEqual(
    (await registry.runnableNames()),
    ['smaCrossover']
  );
  assert.ok(result.strategiesBlocked.includes('rsiMeanReversion'));
  assert.ok(!result.strategiesBlocked.includes('smaCrossover'));
});

test('retiring the only deployed strategy stops the ensemble voting', async () => {
  await registry.retire('smaCrossover', 1, { reason: 'the edge did not survive the out-of-sample split' });

  const result = await withStubs([
    [dataQuality, 'completedBars', () => bars],
    [regimeDetector, 'classify', () => ({ regime: 'RANGING', confidence: 0.6 })],
    [adaptiveLearner, 'getWeight', async () => 1],
    [candlestickPatterns, 'detectAll', () => []],
  ], () => signalEngine.evaluateSymbol('EURUSD'));

  assert.equal(result.strategiesRun, 0);
  assert.equal(result.action, 'HOLD');
  assert.match(result.reason, /No strategy is deployed/);
});
