// SMA Crossover + RSI filter strategy
function sma(data, period) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  return slice.reduce((s, b) => s + b.close, 0) / period;
}

function rsi(data, period = 14) {
  if (data.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function generateSignal(symbol, history) {
  const fast = sma(history, 10);
  const slow = sma(history, 30);
  const r = rsi(history);
  if (!fast || !slow) return { symbol, action: 'HOLD', reason: 'Insufficient data', score: 0 };

  let action = 'HOLD', reason = 'No setup', score = 0;
  if (fast > slow && r < 70) { action = 'BUY'; reason = 'Fast SMA above slow + RSI healthy'; score = Math.min(100, (fast - slow) / slow * 10000 + (70 - r)); }
  else if (fast < slow && r > 30) { action = 'SELL'; reason = 'Fast SMA below slow + RSI healthy'; score = Math.min(100, (slow - fast) / slow * 10000 + (r - 30)); }
  else if (r >= 70) { reason = 'RSI overbought — wait'; }
  else if (r <= 30) { reason = 'RSI oversold — wait'; }

  return { symbol, action, reason, score: Math.round(score), indicators: { fastSMA: fast, slowSMA: slow, rsi: r } };
}

module.exports = { generateSignal };