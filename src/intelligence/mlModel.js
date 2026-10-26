// Learned win-probability model (logistic regression, no external dependencies).
// Trained on closed trades: live trades and real-data backtests. It is validated on the most recent
// trades before it is allowed to gate anything; until then it has no effect.
const fs = require('fs-extra');
const path = require('path');
const storage = require('../data/storage');
const { listStrategies } = require('./strategies');
const timeframes = require('./timeframes');
const realBacktest = require('../backtest/realBacktest');

const MODEL_FILE = path.join(__dirname, '../../data/ml_model.json');
const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD'];
const REGIMES = ['RANGING', 'TRENDING_UP', 'TRENDING_DOWN', 'VOLATILE'];
const MIN_PROBABILITY = 0.5;
const MIN_SELECTED = 20;
const SPLIT = 0.7;
const RETRAIN_EVERY_MS = 15 * 60 * 1000;

let model = null;       // { weights, featureNames, report, trainedAt }
let lastRetrain = 0;

function featureNames() {
  return [
    ...REGIMES.map(r => `regime=${r}`),
    'hour_sin', 'hour_cos', 'day_sin', 'day_cos',
    'action',
    'mtf_M5', 'mtf_M15', 'mtf_H1',
    ...SYMBOLS.map(s => `symbol=${s}`),
    ...listStrategies().map(s => `strategy=${s}`),
    'patterns',
    'bias'
  ];
}

// Numeric description of a trade's situation. Same function for live trades, backtests and new signals.
function vectorOf(trade) {
  const f = trade.features || {};
  const sign = trade.action === 'BUY' ? 1 : -1;
  const hour = Number.isFinite(f.hourUtc) ? f.hourUtc : 0;
  const day = Number.isFinite(f.dayOfWeek) ? f.dayOfWeek : 0;
  const mtf = timeframes.signedAgreement(f.mtf, trade.action);
  const strategies = listStrategies();
  const x = [
    ...REGIMES.map(r => (f.regime === r ? 1 : 0)),
    Math.sin(2 * Math.PI * hour / 24), Math.cos(2 * Math.PI * hour / 24),
    Math.sin(2 * Math.PI * day / 7), Math.cos(2 * Math.PI * day / 7),
    sign,
    mtf.M5, mtf.M15, mtf.H1,
    ...SYMBOLS.map(s => (trade.symbol === s ? 1 : 0)),
    ...strategies.map(s => (f.strategy === s ? 1 : 0)),
    Math.min(3, (f.patterns || []).length) / 3,
    1
  ];
  return x;
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function dot(w, x) { let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * x[i]; return s; }

// Batch gradient descent on the log-loss, with L2 regularisation on every weight except the bias.
function train(X, y, { epochs = 500, lr = 0.3, l2 = 0.001 } = {}) {
  const d = X[0].length;
  const w = new Array(d).fill(0);
  const n = X.length;
  for (let e = 0; e < epochs; e++) {
    const g = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      const err = sigmoid(dot(w, X[i])) - y[i];
      for (let j = 0; j < d; j++) g[j] += err * X[i][j];
    }
    for (let j = 0; j < d; j++) {
      const reg = j === d - 1 ? 0 : l2 * w[j];
      w[j] -= lr * (g[j] / n + reg);
    }
  }
  return w;
}

function evaluate(w, X, y) {
  if (!X.length) return { n: 0, accuracy: 0, logLoss: 0 };
  let correct = 0, loss = 0;
  for (let i = 0; i < X.length; i++) {
    const p = Math.min(0.999999, Math.max(0.000001, sigmoid(dot(w, X[i]))));
    if ((p >= 0.5 ? 1 : 0) === y[i]) correct++;
    loss += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p));
  }
  return { n: X.length, accuracy: Math.round(correct / X.length * 1000) / 1000, logLoss: Math.round(loss / X.length * 1000) / 1000 };
}

function summarise(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winRate: 0, avgPnl: 0 };
  const wins = trades.filter(t => t.pnl > 0).length;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  return { n, winRate: Math.round(wins / n * 1000) / 1000, avgPnl: Math.round(total / n * 100) / 100 };
}

// Clean samples only: closed trades with a real outcome and a feature record.
function usable(trades) {
  return trades
    .filter(t => Number.isFinite(Number(t.pnl)) && t.openTime && t.features && t.symbol && t.action)
    .map(t => ({ ...t, pnl: Number(t.pnl) }))
    .sort((a, b) => new Date(a.openTime) - new Date(b.openTime));
}

// Walk-forward validation: train on the earliest trades, test on the latest. The model is active only if the
// trades it would have taken (probability >= threshold) did better than the average trade in the test period.
function validate(samples) {
  const cut = Math.floor(samples.length * SPLIT);
  const train_ = samples.slice(0, cut);
  const test = samples.slice(cut);
  const featureLen = vectorOf(samples[0]).length;
  const w = train(train_.map(vectorOf), train_.map(t => (t.pnl > 0 ? 1 : 0)));
  const scored = test.map(t => ({ trade: t, p: sigmoid(dot(w, vectorOf(t))) }));
  const selected = scored.filter(s => s.p >= MIN_PROBABILITY).map(s => s.trade);
  const sel = summarise(selected);
  const all = summarise(test);
  const active = sel.n >= MIN_SELECTED && sel.avgPnl > all.avgPnl && sel.winRate >= all.winRate;
  return {
    trainedOn: train_.length,
    testedOn: test.length,
    featureCount: featureLen,
    selected: sel,
    testAll: all,
    fit: evaluate(w, test.map(vectorOf), test.map(t => (t.pnl > 0 ? 1 : 0))),
    active,
    minProbability: MIN_PROBABILITY
  };
}

async function collectSamples() {
  const live = (await storage.load('trades')).filter(t => t.source === 'ctrader' && t.status === 'CLOSED');
  const backtested = await realBacktest.storedTrades();
  return usable([...live, ...backtested]);
}

async function init() {
  model = await fs.readJson(MODEL_FILE).catch(() => null);
}

// Re-validates and refits on everything known so far. Returns the validation report.
async function retrain(samples = null) {
  const data = samples || await collectSamples();
  if (data.length < 50) {
    model = { weights: null, report: { active: false, reason: `Only ${data.length} trades; at least 50 needed`, trainedOn: data.length }, trainedAt: new Date().toISOString() };
  } else {
    const report = validate(data);
    const weights = train(data.map(vectorOf), data.map(t => (t.pnl > 0 ? 1 : 0)));
    model = { weights, report, trainedAt: new Date().toISOString(), featureCount: weights.length };
  }
  lastRetrain = Date.now();
  await fs.ensureDir(path.dirname(MODEL_FILE));
  await fs.writeJson(MODEL_FILE, model, { spaces: 2 });
  return model.report;
}

// Retrains at most every RETRAIN_EVERY_MS, so it can be called after every trade.
async function maybeRetrain() {
  if (Date.now() - lastRetrain < RETRAIN_EVERY_MS) return null;
  return retrain();
}

// Win probability for a trade, or null when the model is not active (rules alone decide).
function probability(trade) {
  if (!model || !model.weights || !model.report || !model.report.active) return null;
  const x = vectorOf(trade);
  if (x.length !== model.weights.length) return null;
  return sigmoid(dot(model.weights, x));
}

function status() {
  return {
    active: !!(model && model.report && model.report.active),
    minProbability: MIN_PROBABILITY,
    trainedAt: model ? model.trainedAt : null,
    report: model ? model.report : null
  };
}

module.exports = { init, retrain, maybeRetrain, probability, status, vectorOf, validate, usable, collectSamples, MIN_PROBABILITY, featureNames, train, sigmoid };
