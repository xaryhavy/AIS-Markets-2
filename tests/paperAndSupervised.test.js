const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-modes-'));
process.env.AIS_MODE_FILE = path.join(dir, 'operating_mode.json');
process.env.AIS_DATA_DIR = dir;
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const audit = require('../src/audit/audit');
const mode = require('../src/governance/mode');
const trading = require('../src/ctrader/trading');
const orderManager = require('../src/execution/orderManager');
const marketData = require('../src/data/marketdata');
const evidence = require('../src/analytics/evidence');

const types = () => fs.existsSync(audit.AUDIT_FILE)
  ? fs.readFileSync(audit.AUDIT_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).type) : [];

test('PAPER never allows a broker order, and can be selected without the order confirmation', async () => {
  await mode.init();
  await mode.setMode('PAPER', { source: 'owner' });
  assert.equal(mode.current(), 'PAPER');
  assert.equal(mode.allowsBrokerOrders(), false);
});

test('DEMO_SUPERVISED cannot be selected directly; it needs an enabled session', async () => {
  await assert.rejects(mode.setMode('DEMO_SUPERVISED', { confirm: 'CONFIRM DEMO_SUPERVISED' }), /use enableSupervised/);
});

test('a supervised session needs the exact phrase and a duration from 0.1 to 8 hours', async () => {
  const now = Date.UTC(2026, 9, 26, 12, 0);
  await assert.rejects(mode.enableSupervised({ hours: 1, confirm: 'yes', now }), /CONFIRM DEMO_SUPERVISED/);
  for (const bad of [0, 9, NaN, '1']) {
    await assert.rejects(mode.enableSupervised({ hours: bad, confirm: 'CONFIRM DEMO_SUPERVISED', now }), /hours must be a number/, `rejects ${bad}`);
  }
});

test('a supervised session allows demo orders until it expires, then gives none', async () => {
  const now = Date.UTC(2026, 9, 26, 12, 0);
  const d = await mode.enableSupervised({ hours: 2, confirm: 'CONFIRM DEMO_SUPERVISED', actor: 'owner', now });
  assert.equal(d.mode, 'DEMO_SUPERVISED');
  assert.equal(mode.allowsBrokerOrders(now + 60 * 60000), true, 'inside the session');
  assert.equal(mode.allowsBrokerOrders(now + 3 * 3600000), false, 'after expiry');
  assert.ok(types().includes('SUPERVISED_SESSION_ENABLED'));
});

test('expiry reverts the stored mode to OBSERVATION, once, with an audit record', async () => {
  const now = Date.UTC(2026, 9, 26, 12, 0);
  await mode.enableSupervised({ hours: 1, confirm: 'CONFIRM DEMO_SUPERVISED', actor: 'owner', now });
  const changed = await mode.expireIfDue(now + 2 * 3600000);
  assert.equal(changed, true);
  assert.equal(mode.current(), 'OBSERVATION');
  assert.equal(await mode.expireIfDue(now + 3 * 3600000), false, 'nothing more to do');
  assert.ok(types().includes('SUPERVISED_SESSION_EXPIRED'));
});

test('LIVE stays refused, and nothing reaches it through a supervised session', async () => {
  await assert.rejects(mode.setMode('LIVE', { confirm: 'CONFIRM LIVE' }), /not available/);
  await assert.rejects(mode.enableSupervised({ hours: 1, confirm: 'CONFIRM DEMO_SUPERVISED', now: Date.now() }).then(() => mode.setMode('LIVE', { confirm: 'CONFIRM LIVE' })), /not available/);
});

test('a PAPER fill is a simulated trade: no broker call, its own evidence class, and no order id from the broker', async () => {
  let openMarketCalls = 0;
  const saved = trading.openMarket;
  trading.openMarket = async () => { openMarketCalls++; throw new Error('must not be called in PAPER'); };
  marketData.getPrice = () => 1.1;
  try {
    const t = await orderManager.openPaperPosition({ symbol: 'EURUSD', action: 'BUY', score: 80, features: {} }, 1000, { stopLoss: 1.09, takeProfit: 1.13 });
    assert.equal(openMarketCalls, 0, 'no broker order');
    assert.equal(t.source, 'paper');
    assert.equal(t.evidenceMode, 'PAPER');
    assert.equal(t.environment, 'paper');
    assert.equal(evidence.classifyTrade(t), evidence.CLASSES.SIMULATED_PAPER);
    assert.ok(types().includes('PAPER_FILL'));
  } finally {
    trading.openMarket = saved;
  }
});

test('a PAPER trade closes at its take-profit on the simulated price and is never a strategy-evaluation result', async () => {
  marketData.getPrice = () => 1.14;
  const closed = await orderManager.checkAndClosePositions();
  assert.ok(closed.some(t => t.evidenceMode === 'PAPER' && t.status === 'CLOSED'));
  assert.equal(evidence.classifyTrade(closed.find(t => t.evidenceMode === 'PAPER')), evidence.CLASSES.SIMULATED_PAPER);
});

test('legacy simulated trades keep their own class, separate from PAPER', () => {
  assert.equal(evidence.classifyTrade({ source: 'legacy-paper', pnl: 1 }), evidence.CLASSES.SIMULATED_LEGACY);
});
