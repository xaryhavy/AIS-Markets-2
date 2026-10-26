// Server-side pre-trade check. Runs inside the order path, after the engine's own checks, and cannot be skipped
// by a caller. Pure: it takes the state it needs and returns the reasons it refuses an order.
const limits = require('./limits');

const RISK_TOLERANCE = 1.05; // allows for rounding of the stop price to broker precision

// Converts a price-distance in the quote currency to USD. For USD-base pairs (USDJPY) the quote is JPY.
function quoteToUsd(symbol, price) {
  return symbol.startsWith('USD') ? 1 / price : 1;
}

// Exposure in USD for a position of `units` at `price`.
function notionalUsd(symbol, units, price) {
  return symbol.startsWith('USD') ? units : units * price;
}

// Loss in USD if a position is stopped out.
function riskUsd(symbol, units, entry, stopLoss) {
  return units * Math.abs(entry - stopLoss) * quoteToUsd(symbol, entry);
}

// `order`: { symbol, action, units, price, stopLoss, takeProfit }
// `ctx`:   { cfg, balance, openPositions: [{symbol, volume, price, stopLoss}], bid, ask,
//            emergency, consecutiveLosses, drawdownPct, nowMs }
// Returns { allow, reasons }.
function check(order, ctx) {
  const reasons = [];
  const cfg = ctx.cfg;
  const { symbol, action, units, price, stopLoss, takeProfit } = order;

  if (ctx.emergency) reasons.push('emergency stop is on');
  if (ctx.allowsOrders === false) reasons.push(`operating mode ${ctx.mode} does not place broker orders`);
  if (!Number.isFinite(ctx.balance) || ctx.balance <= 0) reasons.push('account balance unknown');
  if (![price, stopLoss, takeProfit, units].every(Number.isFinite) || units <= 0) {
    reasons.push('order levels are not valid numbers');
  } else {
    const geometryOk = action === 'BUY' ? stopLoss < price && price < takeProfit : takeProfit < price && price < stopLoss;
    if (!geometryOk) reasons.push('stop-loss and take-profit are on the wrong side of the entry');
    const rr = Math.abs(takeProfit - price) / Math.abs(price - stopLoss);
    if (!(rr >= cfg.minRewardRisk - 0.05)) reasons.push(`reward to risk ${rr.toFixed(2)} is below 1:${cfg.minRewardRisk}`);
  }

  const open = ctx.openPositions || [];
  if (open.some(p => !Number.isFinite(p.stopLoss) || p.stopLoss <= 0)) {
    reasons.push('an open position has no stop-loss; new entries are held until it is protected');
  }
  if (reasons.length) return { allow: false, reasons };

  const newRisk = riskUsd(symbol, units, price, stopLoss);
  const riskPct = newRisk / ctx.balance * 100;
  if (riskPct > cfg.riskPerTradePct * RISK_TOLERANCE) {
    reasons.push(`risk ${riskPct.toFixed(2)}% of balance exceeds ${cfg.riskPerTradePct}% per trade`);
  }
  if (open.length >= cfg.maxOpenPositions) reasons.push(`${open.length} positions open; limit ${cfg.maxOpenPositions}`);

  const openRisk = open.reduce((s, p) => s + riskUsd(p.symbol, p.volume / 100, p.price, p.stopLoss), 0);
  if (cfg.maxTotalOpenRiskPct !== null && (openRisk + newRisk) / ctx.balance * 100 > cfg.maxTotalOpenRiskPct) {
    reasons.push(`total open risk would exceed ${cfg.maxTotalOpenRiskPct}% of balance`);
  }

  const exposure = open.reduce((s, p) => s + notionalUsd(p.symbol, p.volume / 100, p.price), 0);
  const adding = notionalUsd(symbol, units, price);
  if (exposure + adding > ctx.balance * cfg.maxExposurePct / 100) {
    reasons.push(`exposure would exceed ${cfg.maxExposurePct}% of balance`);
  }

  if (cfg.maxPositionsPerInstrument !== null && open.filter(p => p.symbol === symbol).length >= cfg.maxPositionsPerInstrument) {
    reasons.push(`already ${cfg.maxPositionsPerInstrument} position(s) on ${symbol}`);
  }

  if (cfg.maxSpreadPct !== null) {
    if (!(ctx.bid > 0 && ctx.ask > 0 && ctx.ask >= ctx.bid)) reasons.push('spread unknown');
    else {
      const spreadPct = (ctx.ask - ctx.bid) / price * 100;
      if (spreadPct > cfg.maxSpreadPct) reasons.push(`spread ${spreadPct.toFixed(3)}% exceeds ${cfg.maxSpreadPct}%`);
    }
  }

  if (cfg.maxDrawdownPct !== null && ctx.drawdownPct >= cfg.maxDrawdownPct) {
    reasons.push(`drawdown ${ctx.drawdownPct.toFixed(1)}% is at or above ${cfg.maxDrawdownPct}%`);
  }
  if (cfg.maxConsecutiveLosses !== null && ctx.consecutiveLosses >= cfg.maxConsecutiveLosses) {
    reasons.push(`${ctx.consecutiveLosses} consecutive losses; limit ${cfg.maxConsecutiveLosses}`);
  }
  if (cfg.blockedSessionsUtc.length && limits.inBlockedSession(cfg.blockedSessionsUtc, ctx.nowMs)) {
    reasons.push('inside a blocked UTC session window');
  }

  return { allow: reasons.length === 0, reasons };
}

module.exports = { check, riskUsd, notionalUsd, quoteToUsd, RISK_TOLERANCE };
