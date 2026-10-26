// Demo/paper broker adapter — simulates fills with spread & slippage
const SPREAD = 0.00005;

function placeOrder(symbol, action, size, price) {
  const fillPrice = action === 'BUY' ? price + SPREAD : price - SPREAD;
  const id = 'ORD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  return {
    id,
    symbol,
    action,
    size,
    entryPrice: fillPrice,
    status: 'FILLED',
    fillTime: new Date().toISOString(),
    environment: 'demo'
  };
}

function closePosition(trade, currentPrice) {
  const exitPrice = trade.action === 'BUY' ? currentPrice - SPREAD : currentPrice + SPREAD;
  const pnl = trade.action === 'BUY'
    ? (exitPrice - trade.entryPrice) * trade.size
    : (trade.entryPrice - exitPrice) * trade.size;
  return { exitPrice, pnl: Math.round(pnl * 100) / 100, closeTime: new Date().toISOString() };
}

module.exports = { placeOrder, closePosition };