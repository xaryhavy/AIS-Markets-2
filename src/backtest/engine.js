const { strategies } = require('../intelligence/strategies');
const ind = require('../intelligence/indicators');

// Generate realistic synthetic history with regime shifts
function generateSyntheticHistory(bars = 500, startPrice = 1.0850) {
  const history = [];
  let price = startPrice;
  let regime = 'TRENDING_UP';
  let regimeBars = 0;
  for (let i = 0; i < bars; i++) {
    regimeBars++;
    if (regimeBars > 80 + Math.random() * 60) {
      const regimes = ['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'VOLATILE'];
      regime = regimes[Math.floor(Math.random() * regimes.length)];
      regimeBars = 0;
    }
    let drift = 0, vol = 0.001;
    if (regime === 'TRENDING_UP') { drift = 0.0003; vol = 0.0008; }
    if (regime === 'TRENDING_DOWN') { drift = -0.0003; vol = 0.0008; }
    if (regime === 'RANGING') { drift = 0; vol = 0.0005; }
    if (regime === 'VOLATILE') { drift = (Math.random() - 0.5) * 0.001; vol = 0.003; }
    const change = price * (drift + (Math.random() - 0.5) * vol * 2);
    const open = price;
    price = Math.max(price + change, startPrice * 0.5);
    history.push({ time: Date.now() - (bars - i) * 60000, open, high: Math.max(open, price) * (1 + Math.random() * 0.0005), low: Math.min(open, price) * (1 - Math.random() * 0.0005), close: price });
  }
  return history;
}

// Run a backtest for one strategy with given params
function runBacktest(strategyName, params = {}, options = {}) {
  const strategy = strategies[strategyName];
  if (!strategy) return { error: 'Unknown strategy: ' + strategyName };
  const p = { ...strategy.defaultParams, ...params };
  const history = options.history || generateSyntheticHistory(options.bars || 500, options.startPrice || 1.0850);
  const initialBalance = options.balance || 10000;
  const riskPerTrade = options.riskPerTrade || 0.01;
  let balance = initialBalance;
  let position = null;
  const trades = [];
  let peak = initialBalance, maxDrawdown = 0;

  for (let i = 30; i < history.length; i++) {
    const slice = history.slice(0, i + 1);
    const price = slice[i].close;
    // Check open position SL/TP
    if (position) {
      let closed = false;
      if (position.action === 'BUY' && (price <= position.stopLoss || price >= position.takeProfit)) {
        const pnl = (price - position.entry) * position.size;
        balance += pnl;
        trades.push({ ...position, exitPrice: price, pnl });
        position = null; closed = true;
      } else if (position.action === 'SELL' && (price >= position.stopLoss || price <= position.takeProfit)) {
        const pnl = (position.entry - price) * position.size;
        balance += pnl;
        trades.push({ ...position, exitPrice: price, pnl });
        position = null; closed = true;
      }
      if (closed) { peak = Math.max(peak, balance); maxDrawdown = Math.max(maxDrawdown, (peak - balance) / peak); }
    }
    // Generate signal
    if (!position) {
      const sig = strategy.generate(slice, p);
      if (sig.action !== 'HOLD' && sig.score >= (options.minScore || 20)) {
        const atrVal = ind.atr(slice, 14);
        const stopDist = atrVal * 1.5;
        const size = (balance * riskPerTrade) / stopDist;
        const entry = price;
        position = {
          symbol: 'BACKTEST', action: sig.action, size, entry,
          stopLoss: sig.action === 'BUY' ? entry - stopDist : entry + stopDist,
          takeProfit: sig.action === 'BUY' ? entry + stopDist * 3 : entry - stopDist * 3, // 1:3 reward to risk
          openBar: i, reason: sig.reason, score: sig.score
        };
      }
    }
  }
  // Close any open position at end
  if (position) {
    const price = history[history.length - 1].close;
    const pnl = position.action === 'BUY' ? (price - position.entry) * position.size : (position.entry - price) * position.size;
    balance += pnl;
    trades.push({ ...position, exitPrice: price, pnl });
  }

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : (wins.length ? 99 : 0);
  const returns = trades.map(t => t.pnl / initialBalance);
  const meanRet = returns.length ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const stdRet = returns.length ? Math.sqrt(returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / returns.length) : 1;
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(252) : 0;

  return {
    strategy: strategyName,
    params: p,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? Math.round(wins.length / trades.length * 100) : 0,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalReturnPct: Math.round((balance - initialBalance) / initialBalance * 10000) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdown * 10000) / 100,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    finalBalance: Math.round(balance * 100) / 100,
    trades: trades.slice(-20),
    ...(options.includeTrades ? { allTrades: trades } : {})
  };
}

// Backtest all strategies, return sorted by Sharpe
function backtestAll(options = {}) {
  return Object.keys(strategies).map(name => runBacktest(name, {}, options))
    .filter(r => !r.error)
    .sort((a, b) => b.sharpeRatio - a.sharpeRatio);
}

module.exports = { runBacktest, backtestAll, generateSyntheticHistory };