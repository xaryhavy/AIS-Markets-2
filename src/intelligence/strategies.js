const ind = require('./indicators');
const priceAction = require('./priceActionStrategies');

const indicatorStrategies = {
  smaCrossover: {
    name: 'SMA Crossover',
    defaultParams: { fast: 10, slow: 30, rsiPeriod: 14 },
    generate(history, p) {
      const fast = ind.sma(history, p.fast), slow = ind.sma(history, p.slow), r = ind.rsi(history, p.rsiPeriod);
      if (!fast || !slow) return { action: 'HOLD', reason: 'Insufficient data', score: 0 };
      let action = 'HOLD', reason = 'No setup', score = 0;
      if (fast > slow && r < 70) { action = 'BUY'; reason = 'Fast>Slow + RSI healthy'; score = Math.min(100, (fast - slow) / slow * 10000 + (70 - r)); }
      else if (fast < slow && r > 30) { action = 'SELL'; reason = 'Fast<Slow + RSI healthy'; score = Math.min(100, (slow - fast) / slow * 10000 + (r - 30)); }
      return { action, reason, score: Math.round(score), indicators: { fastSMA: fast, slowSMA: slow, rsi: r } };
    }
  },
  rsiMeanReversion: {
    name: 'RSI Mean Reversion',
    defaultParams: { rsiPeriod: 14, oversold: 30, overbought: 70 },
    generate(history, p) {
      const r = ind.rsi(history, p.rsiPeriod);
      let action = 'HOLD', reason = 'RSI neutral', score = 0;
      if (r < p.oversold) { action = 'BUY'; reason = 'RSI oversold — reversal expected'; score = (p.oversold - r) * 3; }
      else if (r > p.overbought) { action = 'SELL'; reason = 'RSI overbought — reversal expected'; score = (r - p.overbought) * 3; }
      return { action, reason, score: Math.min(100, Math.round(score)), indicators: { rsi: r } };
    }
  },
  macdCrossover: {
    name: 'MACD Crossover',
    defaultParams: {},
    generate(history) {
      const m = ind.macd(history);
      let action = 'HOLD', reason = 'No MACD cross', score = 0;
      if (m.histogram > 0.0001) { action = 'BUY'; reason = 'MACD bullish histogram'; score = Math.min(100, Math.abs(m.histogram) * 50000); }
      else if (m.histogram < -0.0001) { action = 'SELL'; reason = 'MACD bearish histogram'; score = Math.min(100, Math.abs(m.histogram) * 50000); }
      return { action, reason, score: Math.round(score), indicators: m };
    }
  },
  bollingerBreakout: {
    name: 'Bollinger Breakout',
    defaultParams: { period: 20, mult: 2 },
    generate(history, p) {
      const b = ind.bollinger(history, p.period, p.mult);
      const price = history[history.length - 1].close;
      let action = 'HOLD', reason = 'Inside bands', score = 0;
      if (price > b.upper) { action = 'BUY'; reason = 'Breakout above upper band'; score = Math.min(100, (price - b.upper) / b.upper * 10000); }
      else if (price < b.lower) { action = 'SELL'; reason = 'Breakdown below lower band'; score = Math.min(100, (b.lower - price) / b.lower * 10000); }
      return { action, reason, score: Math.round(score), indicators: b };
    }
  },
  momentum: {
    name: 'Momentum',
    defaultParams: { period: 10, threshold: 0.002 },
    generate(history, p) {
      const r = ind.roc(history, p.period);
      let action = 'HOLD', reason = 'Weak momentum', score = 0;
      if (r > p.threshold) { action = 'BUY'; reason = 'Strong upward momentum'; score = Math.min(100, r * 20000); }
      else if (r < -p.threshold) { action = 'SELL'; reason = 'Strong downward momentum'; score = Math.min(100, Math.abs(r) * 20000); }
      return { action, reason, score: Math.round(score), indicators: { roc: r } };
    }
  }
};

// Merge indicator strategies + price action (Candlestick Bible) strategies
const strategies = { ...indicatorStrategies, ...priceAction.strategies };

function getStrategy(name) { return strategies[name]; }
function listStrategies() { return Object.keys(strategies); }
module.exports = { strategies, getStrategy, listStrategies };