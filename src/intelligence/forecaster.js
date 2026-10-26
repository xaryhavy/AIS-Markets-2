// Price Direction Forecaster — predicts next-bar direction with probability
// Ensemble of technical features + candlestick patterns + regime awareness
const ind = require('./indicators');
const regimeDetector = require('./regimeDetector');
const patterns = require('./candlestickPatterns');
const fs = require('fs-extra');
const path = require('path');

const PRED_FILE = path.join(__dirname, '../../data/forecast_accuracy.json');
let accuracyLog = { total: 0, correct: 0, byDirection: { UP: { t: 0, c: 0 }, DOWN: { t: 0, c: 0 } } };

async function loadAccuracy() {
  try {
    if (await fs.pathExists(PRED_FILE)) accuracyLog = await fs.readJson(PRED_FILE);
  } catch {}
}
async function saveAccuracy() {
  await fs.ensureDir(path.dirname(PRED_FILE));
  await fs.writeJson(PRED_FILE, accuracyLog, { spaces: 2 });
}

// Record a forecast result (called after bar closes)
async function recordResult(predictedDirection, actualDirection) {
  accuracyLog.total++;
  const correct = predictedDirection === actualDirection;
  if (correct) accuracyLog.correct++;
  accuracyLog.byDirection[predictedDirection].t++;
  if (correct) accuracyLog.byDirection[predictedDirection].c++;
  await saveAccuracy();
}

// Main forecast function
function forecast(history) {
  if (history.length < 50) return { direction: 'NEUTRAL', probability: 0.5, confidence: 0, features: {} };

  const price = history[history.length - 1].close;
  const prevPrice = history[history.length - 2].close;
  const features = {};
  let upVotes = 0, downVotes = 0, totalWeight = 0;

  // Feature 1: RSI (mean reversion) — weight 1.5
  const rsi = ind.rsi(history, 14);
  features.rsi = Math.round(rsi * 10) / 10;
  if (rsi < 35) { upVotes += 1.5; totalWeight += 1.5; }
  else if (rsi > 65) { downVotes += 1.5; totalWeight += 1.5; }
  else totalWeight += 1.5;

  // Feature 2: MACD histogram momentum — weight 2.0
  const macd = ind.macd(history);
  features.macdHist = macd.histogram;
  if (macd.histogram > 0) { upVotes += 2.0; totalWeight += 2.0; }
  else { downVotes += 2.0; totalWeight += 2.0; }

  // Feature 3: SMA slope (trend direction) — weight 2.5
  const sma20now = ind.sma(history, 20);
  const sma20prev = ind.sma(history.slice(0, -1), 20);
  const slope = sma20now - sma20prev;
  features.smaSlope = slope;
  if (slope > 0) { upVotes += 2.5; totalWeight += 2.5; }
  else { downVotes += 2.5; totalWeight += 2.5; }

  // Feature 4: Rate of Change — weight 1.0
  const roc = ind.roc(history, 10);
  features.roc = Math.round(roc * 10000) / 10000;
  if (roc > 0.001) { upVotes += 1.0; totalWeight += 1.0; }
  else if (roc < -0.001) { downVotes += 1.0; totalWeight += 1.0; }
  else totalWeight += 1.0;

  // Feature 5: Regime — weight 2.0
  const regime = regimeDetector.classify(history);
  features.regime = regime.regime;
  if (regime.regime === 'TRENDING_UP') { upVotes += 2.0 * regime.confidence; totalWeight += 2.0; }
  else if (regime.regime === 'TRENDING_DOWN') { downVotes += 2.0 * regime.confidence; totalWeight += 2.0; }
  else totalWeight += 1.0;

  // Feature 6: Candlestick pattern signal — weight 1.5
  const sig = patterns.getStrongestSignal(history);
  features.pattern = sig ? sig.pattern : 'none';
  if (sig) {
    if (sig.direction === 'BULLISH') { upVotes += 1.5 * (sig.strength / 100); totalWeight += 1.5; }
    else { downVotes += 1.5 * (sig.strength / 100); totalWeight += 1.5; }
  } else totalWeight += 0.5;

  // Feature 7: Price vs EMA21 (dynamic S/R) — weight 1.0
  const ema21 = ind.ema(history, 21);
  features.vsEma21 = price > ema21 ? 'ABOVE' : 'BELOW';
  if (price > ema21) { upVotes += 1.0; totalWeight += 1.0; }
  else { downVotes += 1.0; totalWeight += 1.0; }

  // Compute probability
  const upProb = totalWeight > 0 ? upVotes / totalWeight : 0.5;
  const direction = upProb >= 0.55 ? 'UP' : upProb <= 0.45 ? 'DOWN' : 'NEUTRAL';
  const probability = direction === 'UP' ? upProb : direction === 'DOWN' ? (1 - upProb) : 0.5;
  const confidence = Math.round(Math.abs(upProb - 0.5) * 200); // 0-100

  return { direction, probability: Math.round(probability * 100) / 100, confidence, features, upVotes: Math.round(upVotes * 10) / 10, downVotes: Math.round(downVotes * 10) / 10 };
}

function getAccuracy() {
  const acc = accuracyLog.total > 0 ? Math.round((accuracyLog.correct / accuracyLog.total) * 100) : null;
  return { ...accuracyLog, accuracyPct: acc };
}

loadAccuracy();

module.exports = { forecast, recordResult, getAccuracy };