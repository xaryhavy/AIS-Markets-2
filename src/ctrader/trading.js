// Demo order execution on the cTrader account. The engine calls these; nothing else sends orders.
//
// Every order is written to a local intent record BEFORE it is sent. The intent records the outcome:
//   SUBMITTING        — written, request not yet answered (crash here leaves this state behind)
//   FILLED            — broker confirmed a position, protection verified
//   REJECTED          — broker explicitly refused the order (no position exists)
//   UNKNOWN           — request timed out or the connection dropped after sending; the order MAY have filled
//   PROTECTION_FAILED — position exists but stop-loss/take-profit could not be attached or verified
//   CLOSED_EMERGENCY  — position was closed because it could not be protected
//   NOT_FILLED        — UNKNOWN resolved: no matching broker position was found
// UNKNOWN is never treated as a failure: resolveIntents() reconciles it with the broker before entries resume.
const connectionManager = require('./connectionManager');
const marketFeed = require('./marketFeed');
const auth = require('./auth');
const storage = require('../data/storage');
const audit = require('../audit/audit');
const preTrade = require('../risk/preTrade');
const limits = require('../risk/limits');
const mode = require('../governance/mode');
const marketData = require('../data/marketdata');
const adaptiveLearner = require('../intelligence/adaptiveLearner');

const SIDE = { BUY: 1, SELL: 2 }; // ProtoOATradeSide
const POSITION_OPEN = 'POSITION_STATUS_OPEN';
const INTENTS = 'order_intents';
const UNKNOWN_GRACE_MS = 120000;  // how long to wait for a matching position before declaring NOT_FILLED
const MATCH_WINDOW_MS = 10000;    // broker open time may be slightly before our record

class UnknownOutcomeError extends Error {
  constructor(message, intentId) {
    super(message);
    this.name = 'UnknownOutcomeError';
    this.intentId = intentId;
  }
}

// The broker answered and refused: no position was opened.
function isBrokerRefusal(e) {
  return /rejected|cTrader error/i.test(e.message) && !/timed out|socket|closed/i.test(e.message);
}

function newId() {
  return `INT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultDeps() {
  const cfg = auth.getConfig();
  return {
    client: connectionManager.getClient(),
    accountId: Number(cfg.accountId),
    store: storage
  };
}

function isReady() {
  return connectionManager.getStatus().state === 'ACCOUNT_AUTHENTICATED' && marketFeed.isReady();
}

function requireReady() {
  if (!isReady()) throw new Error('cTrader is not connected — orders are not sent');
  const cfg = auth.getConfig();
  if (cfg.environment !== 'demo') throw new Error('Live trading is locked — only the demo environment is enabled');
  return defaultDeps();
}

async function updateIntent(store, id, patch) {
  await store.update(INTENTS, id, { ...patch, updatedAt: new Date().toISOString() });
}

// Opens a market position with verified protection. Throws UnknownOutcomeError when the outcome is not known.
async function openWith(deps, { symbol, action, units, stopLoss, takeProfit }, ctx) {
  const { client, accountId, store } = deps;
  const i = marketFeed.getInfo(symbol);
  const volume = marketFeed.unitsToVolume(symbol, units);
  if (!volume) throw new Error(`${symbol} size ${units} is below the broker minimum`);
  if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) throw new Error(`${symbol} has no valid stop-loss/take-profit — order not sent`);
  // Server-side risk boundary: refused orders are never recorded as intents and never sent.
  if (!ctx) throw new Error('pre-trade context missing — order not sent');
  const verdict = preTrade.check({ symbol, action, units, price: ctx.price, stopLoss, takeProfit }, ctx);
  if (!verdict.allow) {
    audit.record('ORDER_REFUSED', { symbol, action, units, reasons: verdict.reasons });
    throw new Error(`Pre-trade check refused the order: ${verdict.reasons.join('; ')}`);
  }

  const intent = {
    id: newId(), status: 'SUBMITTING', symbol, symbolId: i.symbolId, action, volume,
    stopLoss: marketFeed.roundPrice(symbol, stopLoss), takeProfit: marketFeed.roundPrice(symbol, takeProfit),
    createdAt: new Date().toISOString()
  };
  await store.append(INTENTS, intent);
  audit.record('ORDER_SUBMITTING', { intentId: intent.id, symbol, action, volume });

  let ev;
  try {
    ev = await client.newMarketOrder({
      ctidTraderAccountId: accountId, symbolId: i.symbolId, tradeSide: SIDE[action], volume, label: 'AIS', comment: `AIS ${intent.id}`
    });
  } catch (e) {
    if (isBrokerRefusal(e)) {
      await updateIntent(store, intent.id, { status: 'REJECTED', reason: e.message });
      throw e;
    }
    await updateIntent(store, intent.id, { status: 'UNKNOWN', reason: e.message });
    audit.record('ORDER_OUTCOME_UNKNOWN', { intentId: intent.id, symbol, reason: e.message });
    throw new UnknownOutcomeError(`Order outcome unknown (${e.message}) — entries paused until the broker confirms`, intent.id);
  }

  if (!ev.position || !ev.deal) {
    await updateIntent(store, intent.id, { status: 'UNKNOWN', reason: 'filled reply without a position' });
    throw new UnknownOutcomeError('Order reply had no position — entries paused until the broker confirms', intent.id);
  }
  const positionId = ev.position.positionId;
  const filledVolume = ev.position.tradeData.volume;
  await updateIntent(store, intent.id, { status: 'FILLED', positionId, filledVolume, entryPrice: ev.deal.executionPrice });
  audit.record('ORDER_FILLED', { intentId: intent.id, positionId, symbol });

  try {
    await client.amendSltp({ ctidTraderAccountId: accountId, positionId, stopLoss: intent.stopLoss, takeProfit: intent.takeProfit });
  } catch (e) {
    // A position without protection is not allowed to stay open.
    try {
      await client.closePosition({ ctidTraderAccountId: accountId, positionId, volume: filledVolume });
      await updateIntent(store, intent.id, { status: 'CLOSED_EMERGENCY', reason: `protection failed: ${e.message}` });
      audit.record('EMERGENCY_CLOSE', { intentId: intent.id, positionId, reason: e.message });
    } catch (closeErr) {
      await updateIntent(store, intent.id, { status: 'PROTECTION_FAILED', reason: `protection failed: ${e.message}; close failed: ${closeErr.message}` });
      audit.record('PROTECTION_FAILED', { intentId: intent.id, positionId, symbol, reason: e.message });
    }
    throw new Error(`Stop-loss/take-profit could not be attached (${e.message}); position handled by emergency policy`);
  }

  return {
    intentId: intent.id,
    positionId,
    orderId: ev.order ? ev.order.orderId : null,
    entryPrice: ev.deal.executionPrice,
    volume: filledVolume,
    units: filledVolume / 100
  };
}

// The live state the pre-trade check needs, read from the broker and the feed at decision time.
async function buildContext(deps, symbol) {
  const quote = marketData.getQuote(symbol) || {};
  const adaptive = await adaptiveLearner.getStats();
  const brokerPositions = await openPositions();
  return {
    cfg: limits.active(),
    balance: connectionManager.getBalance() ? connectionManager.getBalance().amount : null,
    price: quote.price,
    bid: quote.bid,
    ask: quote.ask,
    openPositions: brokerPositions.map(p => ({
      symbol: marketFeed.nameForSymbolId(p.tradeData.symbolId),
      volume: Number(p.tradeData.volume),
      price: p.price,
      stopLoss: p.stopLoss
    })),
    emergency: (await limits.emergencyState()).on,
    mode: mode.current(),
    allowsOrders: mode.allowsBrokerOrders(),
    consecutiveLosses: adaptive.consecutiveLosses,
    drawdownPct: await limits.currentDrawdown(),
    nowMs: Date.now()
  };
}

// Opens a market position for the live demo account.
async function openMarket(params) {
  const deps = requireReady();
  const ctx = await buildContext(deps, params.symbol);
  return openWith(deps, params, ctx);
}

// Closes an open position. Returns the exit price and the realised profit in account currency.
async function closeMarket({ positionId, volume }) {
  const { client, accountId } = requireReady();
  const ev = await client.closePosition({ ctidTraderAccountId: accountId, positionId, volume });
  const detail = ev.deal && ev.deal.closePositionDetail;
  const digits = detail && detail.moneyDigits ? detail.moneyDigits : 2;
  const net = detail
    ? (Number(detail.grossProfit || 0) + Number(detail.swap || 0) + Number(detail.commission || 0)) / Math.pow(10, digits)
    : null;
  const out = { exitPrice: ev.deal ? ev.deal.executionPrice : null, pnl: net === null ? null : Math.round(net * 100) / 100 };
  audit.record('POSITION_CLOSED', { positionId: Number(positionId), volume: Number(volume), exitPrice: out.exitPrice, pnl: out.pnl });
  await markIntentClosed(positionId);
  return out;
}

// Moves the filled intent for a closed position to CLOSED, so it is no longer shown as an open order.
async function markIntentClosed(positionId, store = storage) {
  const all = await store.load(INTENTS);
  for (const i of all) {
    if (i.status === 'FILLED' && String(i.positionId) === String(positionId)) await updateIntent(store, i.id, { status: 'CLOSED' });
  }
}

// Broker's open positions (plain objects).
async function openPositions() {
  const { client, accountId } = requireReady();
  const res = await client.reconcile(accountId);
  return (res.position || []).filter(p => p.positionStatus === POSITION_OPEN);
}

// Set of positionIds the broker currently holds open.
async function openPositionIds() {
  return new Set((await openPositions()).map(p => p.positionId));
}

async function unresolvedIntents(store = storage) {
  const all = await store.load(INTENTS);
  return all.filter(i => ['SUBMITTING', 'UNKNOWN', 'PROTECTION_FAILED'].includes(i.status));
}

// Reconciles intents whose outcome is unknown or whose position has no verified protection.
//   knownPositionIds: positions AIS already tracks locally.
// Returns { adopted: [...], notFilled: [...], emergencyClosed: [...], remaining: [...] }.
async function resolveIntents({ client, accountId, store = storage, knownPositionIds, brokerPositions, nowMs = Date.now() }) {
  const result = { adopted: [], notFilled: [], emergencyClosed: [], remaining: [] };
  const intents = await store.load(INTENTS);
  const used = new Set(knownPositionIds);

  for (const intent of intents) {
    if (intent.status === 'PROTECTION_FAILED') {
      const pos = brokerPositions.find(p => String(p.positionId) === String(intent.positionId));
      if (!pos) { await updateIntent(store, intent.id, { status: 'CLOSED_EMERGENCY', reason: 'position no longer open at broker' }); continue; }
      try {
        await client.closePosition({ ctidTraderAccountId: accountId, positionId: pos.positionId, volume: pos.tradeData.volume });
        await updateIntent(store, intent.id, { status: 'CLOSED_EMERGENCY' });
        result.emergencyClosed.push(intent);
      } catch (e) {
        result.remaining.push(intent);
      }
      continue;
    }

    if (intent.status !== 'UNKNOWN' && intent.status !== 'SUBMITTING') continue;
    const createdMs = new Date(intent.createdAt).getTime();
    const match = brokerPositions.find(p =>
      !used.has(p.positionId) &&
      Number(p.tradeData.symbolId) === Number(intent.symbolId) &&
      Number(p.tradeData.volume) === Number(intent.volume) &&
      p.tradeData.tradeSide === (intent.action === 'BUY' ? 'BUY' : 'SELL') &&
      Number(p.tradeData.openTimestamp || 0) >= createdMs - MATCH_WINDOW_MS
    );

    if (match) {
      used.add(match.positionId);
      try {
        await client.amendSltp({ ctidTraderAccountId: accountId, positionId: match.positionId, stopLoss: intent.stopLoss, takeProfit: intent.takeProfit });
        await updateIntent(store, intent.id, { status: 'FILLED', positionId: match.positionId, adopted: true });
      audit.record('POSITION_ADOPTED', { intentId: intent.id, positionId: match.positionId, symbol: intent.symbol });
        result.adopted.push({ intent: { ...intent, positionId: match.positionId }, position: match });
      } catch (e) {
        try {
          await client.closePosition({ ctidTraderAccountId: accountId, positionId: match.positionId, volume: match.tradeData.volume });
          await updateIntent(store, intent.id, { status: 'CLOSED_EMERGENCY', positionId: match.positionId, reason: `adopted position could not be protected: ${e.message}` });
          result.emergencyClosed.push(intent);
        } catch (closeErr) {
          await updateIntent(store, intent.id, { status: 'PROTECTION_FAILED', positionId: match.positionId, reason: `could not protect or close: ${closeErr.message}` });
          result.remaining.push(intent);
        }
      }
      continue;
    }

    if (nowMs - createdMs > UNKNOWN_GRACE_MS) {
      await updateIntent(store, intent.id, { status: 'NOT_FILLED', reason: 'no matching broker position after grace period' });
      result.notFilled.push(intent);
    } else {
      result.remaining.push(intent);
    }
  }
  return result;
}

// One reconciliation pass against the broker. knownPositionIds: positionIds AIS already tracks as OPEN.
// Unmanaged positions (broker has them, AIS does not) are reported, never closed automatically:
// the account may hold positions placed outside AIS, and that is the owner's decision.
async function reconcile(knownPositionIds) {
  const { client, accountId, store } = requireReady();
  const brokerPositions = await openPositions();
  const known = new Set([...knownPositionIds].map(Number));
  const result = await resolveIntents({ client, accountId, store, knownPositionIds: known, brokerPositions });
  const adoptedIds = new Set(result.adopted.map(a => Number(a.position.positionId)));
  const unmanaged = brokerPositions.filter(p => !known.has(Number(p.positionId)) && !adoptedIds.has(Number(p.positionId)));
  return { ...result, brokerPositions, unmanaged, unresolved: await unresolvedIntents(store) };
}

module.exports = {
  isReady, openMarket, openWith, closeMarket, openPositions, openPositionIds, reconcile,
  unresolvedIntents, resolveIntents, UnknownOutcomeError, isBrokerRefusal, INTENTS
};
