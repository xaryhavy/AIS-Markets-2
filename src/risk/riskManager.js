const storage = require('../data/storage');
const connectionManager = require('../ctrader/connectionManager');
const limits = require('./limits');
const FALLBACK_BALANCE = 10000;
// Parameters come from the validated risk configuration (src/risk/limits.js). 1:3 is a hard floor there.
const MIN_REWARD_RISK = 3; // every trade targets at least 1:3 (take-profit distance / stop distance)

// The live cTrader balance. The engine only trades while connected, so the fallback is a safety net only.
function accountBalance() {
  const b = connectionManager.getBalance();
  return b ? b.amount : FALLBACK_BALANCE;
}

async function getOpenPositions() {
  const trades = await storage.load('trades');
  return trades.filter(t => t.status === 'OPEN');
}

// Position size in units that risks RISK_PER_TRADE of the balance between entry and stop.
async function calculatePositionSize(symbol, entryPrice, stopLoss) {
  const riskAmount = accountBalance() * limits.value("riskPerTradePct") / 100;
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (!Number.isFinite(stopDistance) || stopDistance === 0) return 0;
  const size = riskAmount / stopDistance;
  return Math.round(size * 100) / 100;
}

// Exposure in account currency. Pairs quoted in USD (EURUSD, XAUUSD, BTCUSD) are units x price.
// Pairs with USD as the base (USDJPY) are already in USD per unit.
function notionalUsd(symbol, units, price) {
  return symbol.startsWith('USD') ? units : units * price;
}

// Allows a new position only if it keeps the position count and total exposure within limits.
async function checkRisk(symbol, units, price) {
  const open = await getOpenPositions();
  const maxPositions = limits.value("maxOpenPositions");
  if (open.length >= maxPositions) return { allow: false, reason: `Max ${maxPositions} positions reached` };
  const existing = open.reduce((s, p) => s + notionalUsd(p.symbol, p.size, p.entryPrice), 0);
  const adding = notionalUsd(symbol, units, price);
  if (existing + adding > accountBalance() * limits.value("maxExposurePct") / 100) {
    return { allow: false, reason: `Exposure limit: ${(existing + adding).toFixed(0)} would exceed ${(accountBalance() * limits.value("maxExposurePct") / 100).toFixed(0)} USD` };
  }
  return { allow: true };
}

// Decimal places used for price rounding: 5 for FX majors, 3 for JPY-style, 2 for gold/crypto.
function priceDecimals(price) {
  if (price < 10) return 5;
  if (price < 1000) return 3;
  return 2;
}

// Stop from the market's average true range (falls back to 0.2% of price). The take-profit is set at
// MIN_REWARD_RISK times the stop distance, so every trade is at least 1:3.
function calculateStops(symbol, price, action, atr) {
  const distance = Number.isFinite(atr) && atr > 0 ? atr : price * 0.002;
  const stopDistance = distance * limits.value("stopAtrMultiple");
  const reward = stopDistance * Math.max(MIN_REWARD_RISK, limits.value("minRewardRisk"));
  const stopLoss = action === 'BUY' ? price - stopDistance : price + stopDistance;
  const takeProfit = action === 'BUY' ? price + reward : price - reward;
  const d = priceDecimals(price);
  return { stopLoss: Number(stopLoss.toFixed(d)), takeProfit: Number(takeProfit.toFixed(d)) };
}

// Reward per unit of risk for a set of stops at an entry price.
function riskReward(stops, price) {
  const risk = Math.abs(price - stops.stopLoss);
  if (risk === 0) return 0;
  return Math.abs(stops.takeProfit - price) / risk;
}

module.exports = { calculatePositionSize, checkRisk, calculateStops, riskReward, getOpenPositions, accountBalance, notionalUsd, priceDecimals, MIN_REWARD_RISK };
