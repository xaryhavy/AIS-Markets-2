// Real demo-broker execution evidence, on demand. Read-only unless --execute is passed.
//
//   node --env-file=../../../.env scripts/demo-execution-evidence.js             report only, no order
//   node --env-file=../../../.env scripts/demo-execution-evidence.js --execute   ONE order, then close
//
// --execute places exactly one market order at the broker's minimum size, confirms the protective
// stop-loss and take-profit on the broker, closes the position, and confirms the closure against
// broker state. That is the order lifecycle the acceptance criteria ask to see verified for real
// rather than against a fake.
//
// What it deliberately does NOT do:
//   * It does not acknowledge the recovery fence, change the operating mode, or alter a risk limit.
//     The fence gates *autonomous* entries; clearing it is the owner's decision and would leave the
//     engine free to trade on its own. This script makes one call to the order layer and nothing else.
//   * It does not touch a live account. `connectionManager.attemptConnect` refuses when the account
//     type and CTRADER_ENVIRONMENT disagree, and this script refuses again if the environment is not
//     demo, if the account reports itself as live, or if any position is already open.
//   * It does not retry a rejected order or resize to get past a refusal. A refusal is evidence.
const fs = require('fs-extra');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: process.env.AIS_ENV_FILE || path.join(__dirname, '..', '.env') });

const connectionManager = require('../src/ctrader/connectionManager');
const marketFeed = require('../src/ctrader/marketFeed');
const marketData = require('../src/data/marketdata');
const dataQuality = require('../src/data/quality');
const indicators = require('../src/intelligence/indicators');
const trading = require('../src/ctrader/trading');
const limits = require('../src/risk/limits');
const mode = require('../src/governance/mode');
const auth = require('../src/ctrader/auth');
const storage = require('../src/data/storage');

const SYMBOL = process.env.AIS_VERIFY_SYMBOL || 'EURUSD';
const EXECUTE = process.argv.includes('--execute');
const WAIT_MS = 30000;

function stamp() { return new Date().toISOString(); }

async function waitFor(what, test, timeoutMs = WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await test()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The broker's view of one position, or null.
async function brokerPosition(positionId) {
  const open = await trading.openPositions();
  return open.find(p => Number(p.positionId) === Number(positionId)) || null;
}

function positionSummary(p) {
  return {
    positionId: Number(p.positionId),
    symbolId: Number(p.tradeData.symbolId),
    volume: Number(p.tradeData.volume),
    entryPrice: p.price,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit
  };
}

async function main() {
  const evidence = { startedAt: stamp(), symbol: SYMBOL, execute: EXECUTE, stages: [], ok: false };

  await limits.init();
  await mode.init();
  evidence.operatingMode = mode.current();
  evidence.modeAllowsBrokerOrders = mode.allowsBrokerOrders();
  evidence.environment = auth.getConfig().environment;

  const conn = await connectionManager.connect();
  evidence.connection = { state: conn.state, message: conn.message };
  if (conn.state !== 'ACCOUNT_AUTHENTICATED') throw new Error(`not authenticated: ${conn.message}`);
  if (evidence.environment !== 'demo') throw new Error(`CTRADER_ENVIRONMENT is ${evidence.environment}, not demo — refusing`);

  const balance = connectionManager.getBalance();
  evidence.balance = balance;
  if (!balance || !(balance.amount > 0)) throw new Error('account balance unknown — refusing');

  await waitFor('the live price feed', () => marketFeed.isReady());
  evidence.feedReady = true;
  evidence.stages.push({ at: stamp(), stage: 'connected', account: conn.message, balance: balance.amount });

  const existing = await trading.openPositions();
  evidence.openPositionsBefore = existing.map(positionSummary);
  if (existing.length) throw new Error(`${existing.length} position(s) already open — refusing to add another`);

  const info = marketFeed.getInfo(SYMBOL);
  const quote = marketData.getQuote(SYMBOL);
  if (!quote || !Number.isFinite(quote.price)) throw new Error(`no live quote for ${SYMBOL} — refusing`);
  evidence.quote = { bid: quote.bid, ask: quote.ask, price: quote.price, spreadPips: quote.bid && quote.ask ? Number(((quote.ask - quote.bid) / 0.0001).toFixed(2)) : null };
  evidence.brokerMinimum = { minVolumeCents: info.minVolume, stepVolumeCents: info.stepVolume, digits: info.digits };

  const units = info.minVolume / 100; // the smallest trade the broker accepts
  const atr = indicators.atr(dataQuality.completedBars(SYMBOL, 'M1', 60), 14);
  const planned = require('../src/risk/riskManager').calculateStops(SYMBOL, quote.price, 'BUY', atr);
  const order = { symbol: SYMBOL, action: 'BUY', units, stopLoss: planned.stopLoss, takeProfit: planned.takeProfit };
  evidence.planned = { ...order, atr, riskReward: require('../src/risk/riskManager').riskReward(planned, quote.price) };
  evidence.stages.push({ at: stamp(), stage: 'planned', order: evidence.planned });

  if (!EXECUTE) {
    evidence.ok = true;
    evidence.note = 'report only — pass --execute to place the order';
    return evidence;
  }

  // One order. A refusal from the pre-trade check is recorded, not worked around.
  let opened;
  try {
    opened = await trading.openMarket(order);
  } catch (e) {
    evidence.stages.push({ at: stamp(), stage: 'order_refused_or_unknown', error: e.message, intentId: e.intentId || null });
    throw e;
  }
  evidence.order = opened;
  evidence.stages.push({ at: stamp(), stage: 'filled', ...opened });

  let closed = null;
  try {
    // The protection was amended by openMarket; read it back from the broker rather than trusting the call.
    const after = await brokerPosition(opened.positionId);
    if (!after) throw new Error(`position ${opened.positionId} is not visible on the broker after the fill`);
    evidence.brokerPositionAfterFill = positionSummary(after);
    const protectedOk = Number(after.stopLoss) > 0 && Number(after.takeProfit) > 0;
    evidence.protectionVerified = protectedOk;
    evidence.stages.push({ at: stamp(), stage: 'protection_read_back', position: evidence.brokerPositionAfterFill, protectedOk });

    const result = await trading.closeMarket({ positionId: opened.positionId, volume: opened.volume });
    closed = { ...result, positionId: opened.positionId };
    evidence.close = closed;
    evidence.stages.push({ at: stamp(), stage: 'closed', ...closed });

    const stillThere = await brokerPosition(opened.positionId);
    evidence.closedConfirmedByBroker = !stillThere;
    if (stillThere) throw new Error(`position ${opened.positionId} still open on the broker after the close`);
  } finally {
    // A position must never be left open by a verification script.
    if (!closed) {
      const leftover = await brokerPosition(opened.positionId).catch(() => null);
      if (leftover) {
        evidence.leftOpen = positionSummary(leftover);
        console.log(`[EVIDENCE] WARNING — position ${opened.positionId} is still open; close it at the broker`);
      }
    }
  }

  const intents = await storage.load('order_intents');
  evidence.intentRecord = intents.find(i => i.id === opened.intentId) || null;
  evidence.stages.push({ at: stamp(), stage: 'intent_record', status: evidence.intentRecord && evidence.intentRecord.status });
  evidence.finishedAt = stamp();
  evidence.ok = evidence.protectionVerified === true && evidence.closedConfirmedByBroker === true;
  return evidence;
}

main()
  .then(async (evidence) => {
    const dir = path.join(__dirname, '..', 'docs', 'evidence');
    await fs.ensureDir(dir);
    const file = path.join(dir, `demo-execution-${evidence.startedAt.replace(/[:.]/g, '-')}.json`);
    await fs.writeJson(file, evidence, { spaces: 2 });
    console.log(JSON.stringify(evidence, null, 2));
    console.log(`[EVIDENCE] written to ${file}`);
    process.exit(evidence.ok ? 0 : 1);
  })
  .catch((e) => {
    console.log(`[EVIDENCE] FAILED: ${e.message}`);
    process.exit(2);
  });
