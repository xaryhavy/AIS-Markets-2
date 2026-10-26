const storage = require('../data/storage');
const broker = require('./brokerAdapter');
const marketData = require('../data/marketdata');
const trading = require('../ctrader/trading');

// Opens a real market position on the cTrader demo account.
async function openPosition(signal, size, stops) {
  if (!trading.isReady()) throw new Error('cTrader is not connected — position not opened');
  const fill = await trading.openMarket({
    symbol: signal.symbol,
    action: signal.action,
    units: size,
    stopLoss: stops.stopLoss,
    takeProfit: stops.takeProfit
  });
  const trade = {
    id: `ctrader-${fill.positionId}`,
    symbol: signal.symbol,
    action: signal.action,
    size: fill.units,
    entryPrice: fill.entryPrice,
    stopLoss: stops.stopLoss,
    takeProfit: stops.takeProfit,
    status: 'OPEN',
    openTime: new Date().toISOString(),
    reason: signal.reason,
    score: signal.score,
    environment: 'demo',
    source: 'ctrader',
    positionId: fill.positionId,
    orderId: fill.orderId,
    volume: fill.volume,
    features: signal.features || null
  };
  await storage.append('trades', trade);
  return trade;
}

// Stop-loss / take-profit checks on the live price. Closes on cTrader and records the realised result.
async function checkAndClosePositions() {
  const trades = await storage.load('trades');
  const closed = [];
  for (const t of trades) {
    if (t.status !== 'OPEN') continue;
    if (t.source === 'ctrader') {
      const closedTrade = await closeCtraderTrade(t);
      if (closedTrade) closed.push(closedTrade);
      continue;
    }
    // Trades from before the live connection were paper trades; they are settled the old way.
    const price = marketData.getPrice(t.symbol);
    if (price === undefined) continue;
    const reason = exitReason(t, price);
    if (reason) {
      const result = broker.closePosition(t, price);
      await storage.update('trades', t.id, { status: 'CLOSED', exitPrice: result.exitPrice, pnl: result.pnl, closeTime: result.closeTime, closeReason: reason });
      closed.push({ ...t, ...result, closeReason: reason });
    }
  }
  return closed;
}

function exitReason(t, price) {
  if (t.action === 'BUY') {
    if (price <= t.stopLoss) return 'Stop loss hit';
    if (price >= t.takeProfit) return 'Take profit hit';
  } else {
    if (price >= t.stopLoss) return 'Stop loss hit';
    if (price <= t.takeProfit) return 'Take profit hit';
  }
  return null;
}

async function closeCtraderTrade(t) {
  const price = marketData.getPrice(t.symbol);
  if (price === undefined) return null;
  const reason = exitReason(t, price);
  if (!reason) return null;
  let result;
  try {
    result = await trading.closeMarket({ positionId: t.positionId, volume: t.volume });
  } catch (e) {
    // Keep the trade open and try again next cycle.
    console.log(`[ENGINE] Could not close ${t.symbol} position ${t.positionId}: ${e.message}`);
    return null;
  }
  const update = { status: 'CLOSED', exitPrice: result.exitPrice, pnl: result.pnl, closeTime: new Date().toISOString(), closeReason: reason };
  await storage.update('trades', t.id, update);
  return { ...t, ...update };
}

// Closes a trade AIS recorded, whatever the price, and records the result. Used for owner-requested and test closes.
async function closeTrade(t, reason) {
  const result = await trading.closeMarket({ positionId: t.positionId, volume: t.volume });
  const update = { status: 'CLOSED', exitPrice: result.exitPrice, pnl: result.pnl, closeTime: new Date().toISOString(), closeReason: reason };
  await storage.update('trades', t.id, update);
  return { ...t, ...update };
}

// Marks trades the broker has already closed (its own stop-loss/take-profit, or a manual close on cTrader).
async function syncWithBroker() {
  if (!trading.isReady()) return [];
  const trades = await storage.load('trades');
  const open = trades.filter(t => t.status === 'OPEN' && t.source === 'ctrader');
  if (!open.length) return [];
  const brokerOpen = await trading.openPositionIds();
  const closed = [];
  for (const t of open) {
    if (brokerOpen.has(t.positionId)) continue;
    const price = marketData.getPrice(t.symbol);
    const exit = price === undefined ? t.entryPrice : price;
    const dir = t.action === 'BUY' ? 1 : -1;
    // The broker does not report the exact result here, so this is an estimate in quote currency.
    const update = {
      status: 'CLOSED', exitPrice: exit, pnl: Math.round((exit - t.entryPrice) * t.size * dir * 100) / 100,
      pnlEstimated: true, closeTime: new Date().toISOString(), closeReason: 'Closed on cTrader (broker stop/take-profit or manual)'
    };
    await storage.update('trades', t.id, update);
    closed.push({ ...t, ...update });
  }
  return closed;
}

// Records a position that was confirmed after an unknown outcome, with the levels that were intended.
async function recordAdopted(intent, position) {
  const trade = {
    id: `ctrader-${position.positionId}`,
    symbol: intent.symbol,
    action: intent.action,
    size: position.tradeData.volume / 100,
    entryPrice: position.price,
    stopLoss: intent.stopLoss,
    takeProfit: intent.takeProfit,
    status: 'OPEN',
    openTime: new Date(Number(position.tradeData.openTimestamp || Date.now())).toISOString(),
    reason: `Adopted after unconfirmed order ${intent.id}`,
    score: null,
    environment: 'demo',
    source: 'ctrader',
    adopted: true,
    positionId: Number(position.positionId),
    orderId: null,
    volume: Number(position.tradeData.volume),
    features: null
  };
  await storage.append('trades', trade);
  return trade;
}

module.exports = { openPosition, checkAndClosePositions, syncWithBroker, recordAdopted, closeTrade };
