// Confluence Engine — from The Candlestick Trading Bible (6 factors)
// 1. Trend direction (+25)  2. Support/Resistance (+15)  3. Supply/Demand zones (+20)
// 4. 8/21 EMA (+15)  5. Fibonacci 50/61.8% (+15)  6. Trendline (+10)  + Pattern strength (+10)
const ind = require('./indicators');
const regimeDetector = require('./regimeDetector');
const supplyDemand = require('./supplyDemand');

function findSwingLevels(history, lookback = 20) {
  const levels = { support: [], resistance: [] };
  const slice = history.slice(-lookback);
  for (let i = 2; i < slice.length - 2; i++) {
    if (slice[i].low < slice[i-1].low && slice[i].low < slice[i-2].low && slice[i].low < slice[i+1].low && slice[i].low < slice[i+2].low)
      levels.support.push(slice[i].low);
    if (slice[i].high > slice[i-1].high && slice[i].high > slice[i-2].high && slice[i].high > slice[i+1].high && slice[i].high > slice[i+2].high)
      levels.resistance.push(slice[i].high);
  }
  return levels;
}

function nearLevel(price, level, pct = 0.003) {
  return Math.abs(price - level) / level < pct;
}

function fibonacciLevels(history) {
  const slice = history.slice(-50);
  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  const diff = high - low;
  return { swingHigh: high, swingLow: low, fib382: high - diff*0.382, fib500: high - diff*0.5, fib618: high - diff*0.618 };
}

function atTrendline(history, direction) {
  const slice = history.slice(-20);
  if (slice.length < 5) return false;
  const n = slice.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    const y = direction === 'BULLISH' ? slice[i].low : slice[i].high;
    sumX += i; sumY += y; sumXY += i * y; sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  const currentY = slope * (n - 1) + intercept;
  const price = slice[n - 1].close;
  return Math.abs(price - currentY) / price < 0.003;
}

function scoreConfluence(history, signalDirection, patternStrength = 50) {
  const factors = [];
  let score = 0;
  const price = history[history.length - 1].close;
  const regime = regimeDetector.classify(history);

  // Factor 1: TREND (+25)
  const trendBullish = regime.regime === 'TRENDING_UP';
  const trendBearish = regime.regime === 'TRENDING_DOWN';
  if ((signalDirection === 'BULLISH' && trendBullish) || (signalDirection === 'BEARISH' && trendBearish)) {
    score += 25; factors.push('Trend alignment (+25)');
  }

  // Factor 2: SUPPLY / DEMAND ZONES — Institutional (+20, weighted by freshness)
  const sdZone = supplyDemand.getRelevantZone(history, signalDirection);
  if (sdZone) {
    const bonus = Math.round(20 * (sdZone.freshness / 100));
    score += bonus;
    factors.push(`${sdZone.type} zone (institutional) — freshness ${sdZone.freshness}% (+${bonus})`);
  }

  // Factor 3: SUPPORT / RESISTANCE (+15)
  const levels = findSwingLevels(history);
  const atSupport = levels.support.some(l => nearLevel(price, l));
  const atResistance = levels.resistance.some(l => nearLevel(price, l));
  if ((signalDirection === 'BULLISH' && atSupport) || (signalDirection === 'BEARISH' && atResistance)) {
    score += 15; factors.push('At key S/R level (+15)');
  }

  // Factor 4: 8 & 21 EMA (+15 each)
  const ema8 = ind.ema(history, 8);
  const ema21 = ind.ema(history, 21);
  if (ema8 && nearLevel(price, ema8, 0.002)) { score += 15; factors.push('8 EMA dynamic S/R (+15)'); }
  if (ema21 && nearLevel(price, ema21, 0.002)) { score += 15; factors.push('21 EMA dynamic S/R (+15)'); }

  // Factor 5: FIBONACCI 50% / 61.8% (+15)
  const fib = fibonacciLevels(history);
  if (nearLevel(price, fib.fib500, 0.003) || nearLevel(price, fib.fib618, 0.003)) {
    score += 15; factors.push('Fibonacci 50/61.8% zone (+15)');
  }

  // Factor 6: TRENDLINE touch (+10)
  if (atTrendline(history, signalDirection)) {
    score += 10; factors.push('Trendline touch (+10)');
  }

  // Pattern strength bonus (+10 max)
  const patternBonus = Math.min(10, Math.round(patternStrength / 10));
  score += patternBonus;
  if (patternStrength >= 70) factors.push(`Strong pattern formation (+${patternBonus})`);

  return {
    score: Math.min(100, score),
    factors,
    factorCount: factors.length,
    regime: regime.regime,
    supplyDemandZone: sdZone ? { type: sdZone.type, freshness: sdZone.freshness, strength: sdZone.strength, pattern: sdZone.pattern } : null,
    recommendation: score >= 40 ? 'HIGH PROBABILITY — Take the trade' : score >= 25 ? 'MEDIUM — Consider with caution' : 'LOW — Skip, insufficient confluence',
    grade: score >= 65 ? 'A+' : score >= 50 ? 'A' : score >= 40 ? 'B' : score >= 25 ? 'C' : 'D'
  };
}

module.exports = { scoreConfluence, findSwingLevels, fibonacciLevels, atTrendline };