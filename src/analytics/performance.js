// Performance Analytics — equity curve, drawdown, per-strategy stats
const storage = require('../data/storage');

async function getEquityCurve(startBalance = 10000) {
  const trades = await storage.load('trades');
  const closed = trades.filter(t => t.status === 'CLOSED' && t.pnl != null);
  let equity = startBalance;
  const curve = [{ time: 0, equity: startBalance, drawdown: 0 }];
  let peak = startBalance, maxDrawdown = 0;

  closed.forEach((t, i) => {
    equity += t.pnl || 0;
    peak = Math.max(peak, equity);
    const dd = ((peak - equity) / peak) * 100;
    maxDrawdown = Math.max(maxDrawdown, dd);
    curve.push({ time: i + 1, equity: Math.round(equity * 100) / 100, drawdown: Math.round(dd * 100) / 100, symbol: t.symbol, pnl: t.pnl });
  });

  return { curve, finalEquity: Math.round(equity * 100) / 100, maxDrawdown: Math.round(maxDrawdown * 100) / 100, totalTrades: closed.length };
}

async function perStrategyStats() {
  const trades = await storage.load('trades');
  const closed = trades.filter(t => t.status === 'CLOSED' && t.pnl != null);
  const byStrategy = {};

  closed.forEach(t => {
    const s = t.strategy || 'unknown';
    if (!byStrategy[s]) byStrategy[s] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    byStrategy[s].trades++;
    byStrategy[s].pnl += t.pnl || 0;
    if ((t.pnl || 0) >= 0) byStrategy[s].wins++;
    else byStrategy[s].losses++;
  });

  return Object.entries(byStrategy).map(([strategy, d]) => ({
    strategy,
    trades: d.trades,
    wins: d.wins,
    losses: d.losses,
    winRate: d.trades > 0 ? Math.round((d.wins / d.trades) * 100) : 0,
    pnl: Math.round(d.pnl * 100) / 100,
    avgPnl: d.trades > 0 ? Math.round((d.pnl / d.trades) * 100) / 100 : 0
  })).sort((a, b) => b.pnl - a.pnl);
}

async function perSymbolStats() {
  const trades = await storage.load('trades');
  const closed = trades.filter(t => t.status === 'CLOSED' && t.pnl != null);
  const bySymbol = {};
  closed.forEach(t => {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, pnl: 0 };
    bySymbol[t.symbol].trades++;
    bySymbol[t.symbol].pnl += t.pnl || 0;
  });
  return Object.entries(bySymbol).map(([symbol, d]) => ({ symbol, trades: d.trades, pnl: Math.round(d.pnl * 100) / 100 }));
}

async function summary() {
  const equity = await getEquityCurve();
  const strategies = await perStrategyStats();
  const symbols = await perSymbolStats();
  const closed = equity.curve.length - 1;
  const wins = equity.curve.filter(p => p.pnl > 0).length;
  const losses = equity.curve.filter(p => p.pnl < 0).length;
  const grossWin = equity.curve.filter(p => p.pnl > 0).reduce((s, p) => s + p.pnl, 0);
  const grossLoss = Math.abs(equity.curve.filter(p => p.pnl < 0).reduce((s, p) => s + p.pnl, 0));

  return {
    equityCurve: equity.curve,
    finalEquity: equity.finalEquity,
    maxDrawdown: equity.maxDrawdown,
    totalTrades: closed,
    winRate: closed > 0 ? Math.round((wins / closed) * 100) : 0,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 999 : 0,
    totalPnl: Math.round((equity.finalEquity - 10000) * 100) / 100,
    byStrategy: strategies,
    bySymbol: symbols
  };
}

module.exports = { getEquityCurve, perStrategyStats, perSymbolStats, summary };