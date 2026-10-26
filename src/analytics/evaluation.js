// Strategy evaluation on broker-demo results only. Pure functions: callers pass the records in.
// Positive historical results are not treated as proof of an edge: every output carries its sample size,
// an interval, and a flag when the sample is too small to say anything.
const { CLASSES, classifyTrade } = require('./evidence');
const { wilson } = require('../governance/noTrade');

const MIN_SAMPLE = 30;      // below this, no conclusion is drawn
const Z_CRIT = 1.96;        // two-sided 95%

// Exact broker-demo results only, sorted by close time (no reordering that could leak future information).
function exactResults(trades) {
  return trades
    .filter(t => classifyTrade(t) === CLASSES.BROKER_DEMO_EXACT && Number.isFinite(Number(t.pnl)) && t.closeTime)
    .sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime));
}

// Net P&L per trade after an explicit extra cost per trade (spread and slippage are not in broker P&L).
// costPerTrade defaults to 0 and is reported as "no extra cost modelled" in the output.
function evaluate(trades, { costPerTrade = 0 } = {}) {
  const rows = exactResults(trades);
  const net = rows.map(t => Number(t.pnl) - costPerTrade);
  const n = net.length;
  const wins = net.filter(x => x > 0);
  const losses = net.filter(x => x < 0);
  const grossWin = wins.reduce((s, x) => s + x, 0);
  const grossLoss = -losses.reduce((s, x) => s + x, 0);
  const mean = n ? net.reduce((s, x) => s + x, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(net.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  // Drawdown on cumulative net P&L, in account currency (no assumed starting balance).
  let cum = 0, peak = 0, maxDD = 0;
  for (const x of net) { cum += x; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  const ci = wilson(wins.length, n);
  return {
    sampleSize: n,
    sufficientSample: n >= MIN_SAMPLE,
    flag: n >= MIN_SAMPLE ? null : `insufficient sample (${n} of ${MIN_SAMPLE} needed); no conclusion drawn`,
    costAssumption: costPerTrade ? `extra cost ${costPerTrade} per trade assumed` : 'no extra cost modelled (broker P&L only)',
    winRate: n ? wins.length / n : null,
    winRateLow95: ci.low,
    winRateHigh95: ci.high,
    averageWin: wins.length ? grossWin / wins.length : null,
    averageLoss: losses.length ? grossLoss / losses.length : null,
    expectancy: mean,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? null : null),
    netPnl: net.reduce((s, x) => s + x, 0),
    maxDrawdown: maxDD,
    tStatistic: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : null
  };
}

// Chronological out-of-sample split: the first trainFraction is the in-sample period, the rest is held back.
// Results on the held-back part are the only ones that test whether a rule still works after it was chosen.
function outOfSample(trades, { trainFraction = 0.7, costPerTrade = 0 } = {}) {
  const rows = exactResults(trades);
  const cut = Math.floor(rows.length * trainFraction);
  const train = evaluate(rows.slice(0, cut), { costPerTrade });
  const test = evaluate(rows.slice(cut), { costPerTrade });
  const degradation = train.expectancy !== null && test.expectancy !== null ? test.expectancy - train.expectancy : null;
  return {
    split: 'chronological', trainFraction,
    trainFrom: rows[0] ? rows[0].closeTime : null,
    cutAt: rows[cut - 1] ? rows[cut - 1].closeTime : null,
    inSample: train, outOfSample: test,
    expectancyChange: degradation,
    sufficientForConclusion: train.sufficientSample && test.sufficientSample
  };
}

// Multiple testing: if k rules or strategies were tried, the significance threshold for each is divided by k.
// Returns whether the mean result clears the adjusted threshold (two-sided normal approximation).
function significanceAfterMultipleTesting(result, strategiesTested = 1, alpha = 0.05) {
  const adjustedAlpha = alpha / Math.max(1, strategiesTested);
  const zNeeded = normalQuantile(1 - adjustedAlpha / 2);
  const t = result.tStatistic;
  return {
    strategiesTested,
    adjustedAlpha,
    zNeeded: Math.round(zNeeded * 1000) / 1000,
    tStatistic: t === null ? null : Math.round(t * 1000) / 1000,
    clearsThreshold: t === null || result.sufficientSample === false ? false : t >= zNeeded
  };
}

// Inverse normal CDF (Acklam approximation), enough for the thresholds used here.
function normalQuantile(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288832];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

module.exports = { evaluate, outOfSample, significanceAfterMultipleTesting, exactResults, MIN_SAMPLE };
