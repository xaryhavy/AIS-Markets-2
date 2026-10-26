// Multi-timeframe context. Trend per higher timeframe from EMA(20) vs EMA(50) of completed bars only,
// so the analysis never uses a bar that has not closed yet (no look-ahead in backtests or live).
const marketData = require('../data/marketdata');

const CONTEXT_FRAMES = ['M5', 'M15', 'H1'];
const MIN_BARS = 55;
const LOOKBACK = 120;
const FLAT_BAND = 0.0003; // EMA20 within 0.03% of EMA50 counts as flat

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// Trend from completed bars: 'UP', 'DOWN', 'FLAT', or null when there is not enough history.
function trendOf(completed) {
  if (completed.length < MIN_BARS) return null;
  const closes = completed.slice(-LOOKBACK).map(b => b.close);
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  const diff = (fast - slow) / slow;
  if (diff > FLAT_BAND) return 'UP';
  if (diff < -FLAT_BAND) return 'DOWN';
  return 'FLAT';
}

// Only bars whose period has fully ended by `nowMs`.
function completedBars(list, minutes, nowMs) {
  const span = minutes * 60000;
  return list.filter(b => b.time + span <= nowMs);
}

// listsByFrame: { M5: [...], M15: [...], H1: [...] } at the moment of decision.
function trendsFrom(listsByFrame, nowMs) {
  const minutes = { M5: 5, M15: 15, H1: 60 };
  const out = {};
  for (const frame of CONTEXT_FRAMES) {
    out[frame] = trendOf(completedBars(listsByFrame[frame] || [], minutes[frame], nowMs));
  }
  return out;
}

// Live: trends for the symbol right now.
function analyzeLive(symbol) {
  const lists = {};
  for (const frame of CONTEXT_FRAMES) lists[frame] = marketData.getHistory(symbol, 2000, frame);
  return trendsFrom(lists, Date.now());
}

// Trends that were known at a past moment (used by backtests).
function trendsAt(listsByFrame, timeMs) {
  return trendsFrom(listsByFrame, timeMs);
}

// Direction a trade needs from the higher frames.
function wanted(action) { return action === 'BUY' ? 'UP' : 'DOWN'; }
function opposite(action) { return action === 'BUY' ? 'DOWN' : 'UP'; }

// Hard gate: the higher frames must not oppose the trade, and H1 or M15 must confirm it.
function allows(trends, action) {
  if (!trends || trends.H1 === null || trends.M15 === null) return false;
  if (trends.H1 === opposite(action) || trends.M15 === opposite(action)) return false;
  return trends.H1 === wanted(action) || trends.M15 === wanted(action);
}

// Per frame: +1 confirms the trade, -1 opposes it, 0 flat or unknown. Used as model input and for logging.
function signedAgreement(trends, action) {
  const out = {};
  for (const frame of CONTEXT_FRAMES) {
    const t = trends && trends[frame];
    out[frame] = t === wanted(action) ? 1 : t === opposite(action) ? -1 : 0;
  }
  return out;
}

module.exports = { ema, trendOf, completedBars, analyzeLive, trendsAt, allows, signedAgreement, CONTEXT_FRAMES };
