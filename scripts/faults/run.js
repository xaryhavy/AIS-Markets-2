// Fault-injection runs against the DEMO account only. One scenario per invocation:
//   node scripts/faults/run.js timeout      lost order reply: the request times out after the order may have filled
//   node scripts/faults/run.js disconnect   socket dropped right after the order request is written
//   node scripts/faults/run.js restart      process exits right after the order request; a new process reconciles
// Production code is not modified. Faults are applied to the client instance inside this process only.
// Each run closes what it opened and writes a result file under scripts/faults/results/.
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(process.env.AIS_MAIN_DIR || 'C:/Users/sirju/Documents/AIS Markets 2', '.env') });
const connectionManager = require('../../src/ctrader/connectionManager');
const marketData = require('../../src/data/marketdata');
const marketFeed = require('../../src/ctrader/marketFeed');
const trading = require('../../src/ctrader/trading');
const storage = require('../../src/data/storage');
const orderManager = require('../../src/execution/orderManager');

const SYMBOL = 'EURUSD';
const UNITS = 1000; // broker minimum for EURUSD (minVolume 100000 broker units = 1000 units)
const PIP = 0.0001;
const RESULTS = path.join(__dirname, 'results');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const result = { scenario: process.argv[2], startedAt: new Date().toISOString(), steps: [] };
const step = (msg, data) => {
  result.steps.push({ at: new Date().toISOString(), msg, data });
  log(msg, data === undefined ? '' : JSON.stringify(data));
};

function portOpen(port) {
  return new Promise(res => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
}

async function waitReady(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (connectionManager.getStatus().state === 'ACCOUNT_AUTHENTICATED' && marketFeed.isReady()) return true;
    await sleep(1000);
  }
  return false;
}

async function connectReady() {
  await connectionManager.connect();
  if (!(await waitReady())) throw new Error('broker did not become ready');
}

function levels(action) {
  const q = marketData.getQuote(SYMBOL);
  if (!q) throw new Error('no quote for ' + SYMBOL);
  const entry = action === 'BUY' ? q.ask : q.bid;
  const s = action === 'BUY' ? 1 : -1;
  const r = x => Math.round(x * 1e5) / 1e5;
  return { stopLoss: r(entry - s * 15 * PIP), takeProfit: r(entry + s * 45 * PIP) };
}

// Reconciles until the unknown order is adopted (position found and protected) or declared not filled.
async function awaitResolution(timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await trading.reconcile(new Set());
      step('reconcile pass', { adopted: r.adopted.length, notFilled: r.notFilled.length, remaining: r.remaining.length, unmanaged: r.unmanaged.length });
      if (r.adopted.length || r.notFilled.length || r.emergencyClosed.length) return r;
    } catch (e) {
      step('reconcile not possible yet', { reason: e.message });
    }
    await sleep(10000);
  }
  return null;
}

async function flattenAndVerify(resolved) {
  for (const a of (resolved && resolved.adopted) || []) {
    // Same record path as production: the adopted position gets a trade record, and the close updates it.
    const trade = await orderManager.recordAdopted(a.intent, a.position);
    const closed = await orderManager.closeTrade(trade, 'Fault-injection test close');
    step('closed test position', { positionId: closed.positionId, pnl: closed.pnl, exitPrice: closed.exitPrice, tradeId: closed.id });
  }
  const open = await trading.openPositions();
  step('broker open positions after run', { count: open.length });
  return open.length;
}

function save() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const f = path.join(RESULTS, `${result.scenario}-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(result, null, 2));
  log('result written', f);
}

async function orderOnce(action) {
  return trading.openMarket({ symbol: SYMBOL, action, units: UNITS, ...levels(action) });
}

async function scenarioTimeout() {
  await connectReady();
  const client = connectionManager.getClient();
  const orig = client._onFrame.bind(client);
  let dropping = true;
  client._onFrame = frame => {
    if (dropping) {
      const w = client.ProtoMessage.decode(frame);
      if (w.payloadType === client.ProtoOAPayload.PROTO_OA_EXECUTION_EVENT) {
        step('FAULT: execution event dropped (reply lost)', { clientMsgId: w.clientMsgId });
        return;
      }
    }
    return orig(frame);
  };
  try {
    const r = await orderOnce('BUY');
    step('UNEXPECTED: order returned a result', r);
  } catch (e) {
    step('order call ended as', { name: e.name, message: e.message, intentId: e.intentId || null });
  } finally {
    dropping = false;
    client._onFrame = orig;
  }
  const resolved = await awaitResolution();
  step('resolution', resolved ? { adopted: resolved.adopted.length, notFilled: resolved.notFilled.length } : { result: 'none within window' });
  return flattenAndVerify(resolved);
}

async function scenarioDisconnect() {
  await connectReady();
  const client = connectionManager.getClient();
  const origWrite = client._write.bind(client);
  let armed = true;
  client._write = frame => {
    origWrite(frame);
    if (armed) {
      const w = client.ProtoMessage.decode(frame);
      if (w.payloadType === client.ProtoOAPayload.PROTO_OA_NEW_ORDER_REQ) {
        armed = false;
        step('FAULT: socket destroyed right after order request written');
        client.socket.destroy();
      }
    }
  };
  try {
    const r = await orderOnce('BUY');
    step('UNEXPECTED: order returned a result', r);
  } catch (e) {
    step('order call ended as', { name: e.name, message: e.message, intentId: e.intentId || null });
  }
  client._write = origWrite;
  step('waiting for automatic reconnect');
  if (!(await waitReady(180000))) throw new Error('did not reconnect within 3 minutes');
  step('reconnected', { state: connectionManager.getStatus().state });
  const resolved = await awaitResolution();
  step('resolution', resolved ? { adopted: resolved.adopted.length, notFilled: resolved.notFilled.length } : { result: 'none within window' });
  return flattenAndVerify(resolved);
}

// Child process: submits one order and crashes 50 ms after the request leaves, before any reply.
async function scenarioRestartChild() {
  await connectReady();
  const client = connectionManager.getClient();
  const origWrite = client._write.bind(client);
  client._write = frame => {
    origWrite(frame);
    const w = client.ProtoMessage.decode(frame);
    if (w.payloadType === client.ProtoOAPayload.PROTO_OA_NEW_ORDER_REQ) {
      setTimeout(() => process.exit(1), 50);
    }
  };
  await orderOnce('BUY');
  process.exit(0);
}

async function scenarioRestart() {
  step('starting submitting process');
  const child = spawnSync(process.execPath, [__filename, 'child-restart'], { stdio: 'inherit', timeout: 120000 });
  step('submitting process ended', { status: child.status, signal: child.signal });
  const pending = (await storage.load(trading.INTENTS)).filter(i => ['SUBMITTING', 'UNKNOWN'].includes(i.status));
  step('intents left behind by the crash', pending.map(i => ({ id: i.id, status: i.status, symbol: i.symbol, volume: i.volume })));
  await connectReady();
  const resolved = await awaitResolution();
  step('resolution after restart', resolved ? { adopted: resolved.adopted.length, notFilled: resolved.notFilled.length } : { result: 'none within window' });
  return flattenAndVerify(resolved);
}

(async () => {
  const mode = process.argv[2];
  if (mode === 'child-restart') return scenarioRestartChild();
  if (await portOpen(37492)) {
    console.error('Refusing to run: the demo server is listening on 37492. Stop it first.');
    process.exit(2);
  }
  try {
    let left;
    if (mode === 'timeout') left = await scenarioTimeout();
    else if (mode === 'disconnect') left = await scenarioDisconnect();
    else if (mode === 'restart') left = await scenarioRestart();
    else throw new Error('unknown scenario: ' + mode);
    result.openPositionsLeft = left;
  } catch (e) {
    step('run failed', { message: e.message });
    result.error = e.message;
  } finally {
    result.finishedAt = new Date().toISOString();
    save();
    process.exit(result.error || result.openPositionsLeft ? 1 : 0);
  }
})();
