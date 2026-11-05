// Backtest engine. Honest by construction:
//  - every fill carries an explicit cost model (spread, slippage, commission) and the assumption is reported
//  - exits are checked against each bar's high/low, not just its close, so intrabar touches are seen
//  - when a stop and a target fall inside the same bar, the outcome is ambiguous. It is never silently
//    resolved in the optimistic direction: the policy is named, reported, and defaults to the conservative
//    stop-first treatment
//  - the result states where its bars came from. Synthetic history is labelled SYNTHETIC and can never be
//    mistaken for broker bars
const { strategies } = require('../intelligence/strategies');
const ind = require('../intelligence/indicators');

const WARMUP = 30;
// Bars handed to a strategy at each step. Every strategy and indicator here looks back at most 50 bars
// (SMA50 in the regime detector), but MACD is EMA-based and an EMA never fully forgets: 500 bars is where
// the oldest bar's influence falls below double precision, so the window is exact rather than approximate.
// It is also what makes a multi-year backtest possible — slicing the whole history at every bar is O(n²),
// which is 1.4e11 element copies over five years of M5.
const WINDOW = 500;
// Cost model: spread and slippage are in price units per fill; commission is account currency per trade.
const ZERO_COSTS = { spread: 0, slippage: 0, commission: 0 };
// How a stop and a target both touched inside one bar are treated. Stop-first is the conservative default.
const AMBIGUITY_POLICIES = ['stop-first', 'exclude', 'target-first'];

// Generate synthetic history with regime shifts. Only for labelled development runs — never for evidence.
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

// Validates and returns the cost model. Throws rather than silently ignoring a negative or non-numeric cost.
function normaliseCosts(raw = {}) {
  const out = { ...ZERO_COSTS };
  for (const key of Object.keys(ZERO_COSTS)) {
    if (raw[key] === undefined) continue;
    const v = Number(raw[key]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`cost ${key} must be a non-negative number`);
    out[key] = v;
  }
  return out;
}

// The readable statement of what the result does and does not include. Always reported with the metrics.
function costDisclosure(costs) {
  const parts = [];
  parts.push(costs.spread > 0 ? `spread ${costs.spread} price units per round trip` : 'no spread modelled');
  parts.push(costs.slippage > 0 ? `slippage ${costs.slippage} price units per fill` : 'no slippage modelled');
  parts.push(costs.commission > 0 ? `commission ${costs.commission} per trade` : 'no commission modelled');
  return parts.join('; ');
}

// Price actually paid on entry, after half the spread and slippage, both adverse.
function entryFill(action, price, costs) {
  const adverse = costs.spread / 2 + costs.slippage;
  return action === 'BUY' ? price + adverse : price - adverse;
}

// Price actually received on exit, after half the spread and slippage, both adverse.
function exitFill(action, price, costs) {
  const adverse = costs.spread / 2 + costs.slippage;
  return action === 'BUY' ? price - adverse : price + adverse;
}

// Pure. Did this bar touch the stop, the target, both, or neither?
// `hit` names the level reached; `ambiguous` is true when both were reached inside the same bar.
function resolveExit(position, bar) {
  const isBuy = position.action === 'BUY';
  const stopHit = isBuy ? bar.low <= position.stopLoss : bar.high >= position.stopLoss;
  const targetHit = isBuy ? bar.high >= position.takeProfit : bar.low <= position.takeProfit;
  if (!stopHit && !targetHit) return { hit: null, price: null, ambiguous: false };
  if (stopHit && targetHit) {
    // Both inside one bar. The bar alone cannot say which came first.
    return { hit: 'BOTH', price: null, ambiguous: true };
  }
  if (stopHit) {
    // A gap through the stop fills at the bar's open, which is worse than the stop price.
    const gapped = isBuy ? bar.open <= position.stopLoss : bar.open >= position.stopLoss;
    return { hit: 'STOP', price: gapped ? bar.open : position.stopLoss, ambiguous: false };
  }
  const gapped = isBuy ? bar.open >= position.takeProfit : bar.open <= position.takeProfit;
  return { hit: 'TARGET', price: gapped ? bar.open : position.takeProfit, ambiguous: false };
}

// Applies the ambiguity policy to a bar that touched both levels. Returns the exit price, or null when the
// trade is to be excluded from the statistics.
function ambiguousExit(position, bar, policy) {
  if (policy === 'exclude') return null;
  const isBuy = position.action === 'BUY';
  if (policy === 'target-first') return isBuy ? bar.open >= position.takeProfit ? bar.open : position.takeProfit : bar.open <= position.takeProfit ? bar.open : position.takeProfit;
  // stop-first: assume the stop was reached first.
  return isBuy ? bar.open <= position.stopLoss ? bar.open : position.stopLoss : bar.open >= position.stopLoss ? bar.open : position.stopLoss;
}

// Net result of one closed trade, as a dealer would settle it.
function settle(position, exitPrice, costs) {
  const dir = position.action === 'BUY' ? 1 : -1;
  const gross = (exitPrice - position.entry) * position.size * dir;
  const net = (exitFill(position.action, exitPrice, costs) - position.entryNet) * position.size * dir - costs.commission;
  return { gross, net };
}

// One strategy over one history. Pure with respect to its inputs.
function runBacktest(strategyName, params = {}, options = {}) {
  const strategy = strategies[strategyName];
  if (!strategy) return { error: 'Unknown strategy: ' + strategyName };
  const p = { ...strategy.defaultParams, ...params };
  const synthetic = !options.history;
  const history = options.history || generateSyntheticHistory(options.bars || 500, options.startPrice || 1.0850);
  const dataSource = options.dataSource || (synthetic ? 'SYNTHETIC' : 'SUPPLIED_HISTORY');
  const costs = normaliseCosts(options.costs);
  const ambiguityPolicy = options.ambiguityPolicy || 'stop-first';
  if (!AMBIGUITY_POLICIES.includes(ambiguityPolicy)) {
    return { error: `Unknown ambiguity policy: ${ambiguityPolicy}` };
  }
  const initialBalance = options.balance || 10000;
  const riskPerTrade = options.riskPerTrade || 0.01;
  let balance = initialBalance;
  let position = null;
  const trades = [];
  let peak = initialBalance, maxDrawdown = 0;

  for (let i = WARMUP; i < history.length; i++) {
    const bar = history[i];
    // 1. Manage an open position against this bar's range. A position entered at the previous bar's close
    //    is first exposed here, so no exit can be taken on a bar that was not yet complete.
    if (position) {
      const r = resolveExit(position, bar);
      let exitPrice = null;
      let ambiguous = false;
      let excluded = false;
      let exitReason = null;

      if (r.ambiguous) {
        ambiguous = true;
        exitReason = `stop and target both touched in one bar (ambiguous, policy ${ambiguityPolicy})`;
        exitPrice = ambiguousExit(position, bar, ambiguityPolicy);
        if (exitPrice === null) {
          excluded = true;
          exitPrice = bar.close; // recorded for the audit trail only; never counted
        }
      } else if (r.hit === 'STOP') {
        exitPrice = r.price;
        exitReason = 'stop loss hit';
      } else if (r.hit === 'TARGET') {
        exitPrice = r.price;
        exitReason = 'take profit hit';
      }

      if (exitPrice !== null) {
        const { gross, net } = settle(position, exitPrice, costs);
        balance += net;
        trades.push({
          ...position, exitPrice, exitReason, ambiguous, excludedFromStats: excluded,
          pnl: net, grossPnl: gross, exitBar: i
        });
        position = null;
        peak = Math.max(peak, balance);
        maxDrawdown = Math.max(maxDrawdown, (peak - balance) / peak);
      }
    }

    // 2. Entry: the signal is built from the bars that had completed by this bar's close, and the fill is
    //    taken at that close. It is never exposed to this same bar's range.
    if (!position) {
      const slice = history.slice(Math.max(0, i + 1 - WINDOW), i + 1);
      const sig = strategy.generate(slice, p);
      if (sig.action !== 'HOLD' && sig.score >= (options.minScore || 20)) {
        const atrVal = ind.atr(slice, 14);
        const stopDist = atrVal * 1.5;
        if (Number.isFinite(stopDist) && stopDist > 0) {
          const size = (balance * riskPerTrade) / stopDist;
          const entry = bar.close;
          position = {
            symbol: 'BACKTEST', action: sig.action, size, entry,
            entryNet: entryFill(sig.action, entry, costs),
            stopLoss: sig.action === 'BUY' ? entry - stopDist : entry + stopDist,
            takeProfit: sig.action === 'BUY' ? entry + stopDist * 3 : entry - stopDist * 3, // 1:3 reward to risk
            openBar: i, reason: sig.reason, score: sig.score
          };
        }
      }
    }
  }

  // A position still open at the end is closed at the last close and marked as forced, not as a strategy exit.
  let forcedCloses = 0;
  if (position) {
    const bar = history[history.length - 1];
    const { gross, net } = settle(position, bar.close, costs);
    balance += net;
    trades.push({
      ...position, exitPrice: bar.close, exitReason: 'closed at end of series', forced: true,
      pnl: net, grossPnl: gross, exitBar: history.length - 1
    });
    forcedCloses = 1;
  }

  const scored = trades.filter(t => !t.excludedFromStats);
  const wins = scored.filter(t => t.pnl > 0);
  const losses = scored.filter(t => t.pnl <= 0);
  const totalPnl = scored.reduce((s, t) => s + t.pnl, 0);
  const totalGross = scored.reduce((s, t) => s + (t.grossPnl || 0), 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : (wins.length ? 99 : 0);
  const returns = scored.map(t => t.pnl / initialBalance);
  const meanRet = returns.length ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const stdRet = returns.length ? Math.sqrt(returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / returns.length) : 1;
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(252) : 0;
  const ambiguousTrades = trades.filter(t => t.ambiguous).length;

  return {
    strategy: strategyName,
    params: p,
    dataSource,
    costModel: { ...costs },
    costAssumption: costDisclosure(costs),
    ambiguityPolicy,
    totalTrades: scored.length,
    recordedTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    ambiguousTrades,
    excludedAmbiguous: trades.filter(t => t.excludedFromStats).length,
    forcedCloses,
    winRate: scored.length ? Math.round(wins.length / scored.length * 100) : 0,
    totalPnl: Math.round(totalPnl * 100) / 100,
    grossPnl: Math.round(totalGross * 100) / 100,
    totalCosts: Math.round((totalGross - totalPnl) * 100) / 100,
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

module.exports = {
  runBacktest, backtestAll, generateSyntheticHistory,
  normaliseCosts, costDisclosure, resolveExit, ambiguousExit, settle, entryFill, exitFill,
  ZERO_COSTS, AMBIGUITY_POLICIES
};
