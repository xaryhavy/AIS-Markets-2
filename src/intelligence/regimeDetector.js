const ind = require('./indicators');

// Classifies market into: TRENDING_UP / TRENDING_DOWN / RANGING / VOLATILE
function classify(history) {
  if (history.length < 30) return { regime: 'RANGING', confidence: 0.5, details: {} };
  const price = history[history.length - 1].close;
  const sma50 = ind.sma(history, 50) || price;
  const sma20 = ind.sma(history, 20) || price;
  const sd = ind.stdDev(history, 20);
  const atrVal = ind.atr(history, 14);
  const atrPct = atrVal / price;
  // Trend strength: how far price is from SMA50, normalized by ATR
  const trendStrength = Math.abs(price - sma50) / (atrVal || 1);
  const isUp = price > sma50 && sma20 > sma50;
  const isDown = price < sma50 && sma20 < sma50;

  let regime = 'RANGING', confidence = 0.5;
  if (atrPct > 0.01) {
    regime = 'VOLATILE';
    confidence = Math.min(0.95, atrPct * 50);
  }
  else if (trendStrength > 2 && isUp) {
    regime = 'TRENDING_UP';
    confidence = Math.min(0.95, 0.5 + trendStrength * 0.1);
  }
  else if (trendStrength > 2 && isDown) {
    regime = 'TRENDING_DOWN';
    confidence = Math.min(0.95, 0.5 + trendStrength * 0.1);
  }
  else {
    regime = 'RANGING';
    confidence = Math.min(0.9, 0.7 - trendStrength * 0.1);
  }

  return {
    regime,
    confidence: Math.round(confidence * 100) / 100,
    details: {
      trendStrength: Math.round(trendStrength * 100) / 100,
      atrPct: Math.round(atrPct * 10000) / 10000,
      sd: Math.round(sd * 100000) / 100000
    }
  };
}

// Which strategies work best in which regime (starting priors, refined by adaptive learner)
const REGIME_STRATEGY_PRIORS = {
  TRENDING_UP: { smaCrossover: 1.2, macdCrossover: 1.1, momentum: 1.1, rsiMeanReversion: 0.5, bollingerBreakout: 0.8 },
  TRENDING_DOWN: { smaCrossover: 1.2, macdCrossover: 1.1, momentum: 1.1, rsiMeanReversion: 0.5, bollingerBreakout: 0.8 },
  RANGING: { rsiMeanReversion: 1.3, bollingerBreakout: 1.1, smaCrossover: 0.6, macdCrossover: 0.7, momentum: 0.6 },
  VOLATILE: { bollingerBreakout: 1.2, momentum: 1.0, rsiMeanReversion: 0.7, smaCrossover: 0.7, macdCrossover: 0.8 }
};

module.exports = { classify, REGIME_STRATEGY_PRIORS };