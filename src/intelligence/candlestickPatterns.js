// Candlestick pattern detector — based on The Candlestick Trading Bible
// Returns: { pattern, direction: 'BULLISH'|'BEARISH', strength: 0-100, details }

function body(c) { return Math.abs(c.close - c.open); }
function range(c) { return c.high - c.low; }
function isGreen(c) { return c.close > c.open; }
function isRed(c) { return c.close < c.open; }
function upperWick(c) { return c.high - Math.max(c.open, c.close); }
function lowerWick(c) { return Math.min(c.open, c.close) - c.low; }

function detectAll(history) {
  if (history.length < 3) return [];
  const detected = [];
  const c1 = history[history.length - 1]; // current
  const c2 = history[history.length - 2]; // previous
  const c3 = history[history.length - 3]; // two back

  // 1. PIN BAR — long wick rejection
  const b1 = body(c1), r1 = range(c1);
  if (r1 > 0 && b1 / r1 < 0.35) {
    const uw = upperWick(c1), lw = lowerWick(c1);
    if (lw / r1 > 0.6 && uw / r1 < 0.15) detected.push({ pattern: 'Bullish Pin Bar', direction: 'BULLISH', strength: Math.min(100, Math.round(lw / r1 * 120)), details: { lowerWickPct: Math.round(lw/r1*100) } });
    if (uw / r1 > 0.6 && lw / r1 < 0.15) detected.push({ pattern: 'Bearish Pin Bar', direction: 'BEARISH', strength: Math.min(100, Math.round(uw / r1 * 120)), details: { upperWickPct: Math.round(uw/r1*100) } });
  }

  // 2. ENGULFING BAR
  const b2 = body(c2);
  if (b2 > 0 && b1 > b2 * 1.1) {
    if (isRed(c2) && isGreen(c1) && c1.open < c2.close && c1.close > c2.open)
      detected.push({ pattern: 'Bullish Engulfing', direction: 'BULLISH', strength: Math.min(100, Math.round(b1/b2*40)), details: { engulfRatio: Math.round(b1/b2*10)/10 } });
    if (isGreen(c2) && isRed(c1) && c1.open > c2.close && c1.close < c2.open)
      detected.push({ pattern: 'Bearish Engulfing', direction: 'BEARISH', strength: Math.min(100, Math.round(b1/b2*40)), details: { engulfRatio: Math.round(b1/b2*10)/10 } });
  }

  // 3. DOJI (indecision)
  if (r1 > 0 && b1 / r1 < 0.1) {
    const uw = upperWick(c1), lw = lowerWick(c1);
    if (lw / r1 > 0.55 && uw / r1 < 0.2) detected.push({ pattern: 'Dragonfly Doji', direction: 'BULLISH', strength: 70, details: {} });
    else if (uw / r1 > 0.55 && lw / r1 < 0.2) detected.push({ pattern: 'Gravestone Doji', direction: 'BEARISH', strength: 70, details: {} });
    else detected.push({ pattern: 'Doji (Indecision)', direction: 'NEUTRAL', strength: 40, details: {} });
  }

  // 4. HAMMER / SHOOTING STAR
  if (r1 > 0 && b1 / r1 < 0.4) {
    const uw = upperWick(c1), lw = lowerWick(c1);
    if (lw > b1 * 2 && uw < b1 * 0.5) detected.push({ pattern: 'Hammer', direction: 'BULLISH', strength: Math.min(100, Math.round(lw/b1*25)), details: {} });
    if (uw > b1 * 2 && lw < b1 * 0.5) detected.push({ pattern: 'Shooting Star', direction: 'BEARISH', strength: Math.min(100, Math.round(uw/b1*25)), details: {} });
  }

  // 5. MORNING STAR / EVENING STAR (3-candle)
  const b3 = body(c3);
  if (b3 > 0 && b1 > 0 && body(c2) / Math.max(range(c2), 0.0001) < 0.3) {
    // Morning star: red → small → green, green closes > midpoint of red body
    if (isRed(c3) && isGreen(c1) && c1.close > (c3.open + c3.close) / 2)
      detected.push({ pattern: 'Morning Star', direction: 'BULLISH', strength: 75, details: {} });
    // Evening star: green → small → red, red closes < midpoint of green body
    if (isGreen(c3) && isRed(c1) && c1.close < (c3.open + c3.close) / 2)
      detected.push({ pattern: 'Evening Star', direction: 'BEARISH', strength: 75, details: {} });
  }

  // 6. HARAMI — small body inside previous large body
  if (b2 > 0 && b1 < b2 * 0.5) {
    const prevHigh = Math.max(c2.open, c2.close), prevLow = Math.min(c2.open, c2.close);
    const curHigh = Math.max(c1.open, c1.close), curLow = Math.min(c1.open, c1.close);
    if (curHigh < prevHigh && curLow > prevLow) {
      detected.push({ pattern: isGreen(c2) ? 'Bearish Harami' : 'Bullish Harami', direction: isGreen(c2) ? 'BEARISH' : 'BULLISH', strength: 55, details: {} });
    }
  }

  // 7. TWEEZERS — matching highs/lows
  const tol = range(c1) * 0.05;
  if (Math.abs(c1.low - c2.low) < tol && isRed(c2) && isGreen(c1))
    detected.push({ pattern: 'Tweezers Bottom', direction: 'BULLISH', strength: 60, details: {} });
  if (Math.abs(c1.high - c2.high) < tol && isGreen(c2) && isRed(c1))
    detected.push({ pattern: 'Tweezers Top', direction: 'BEARISH', strength: 60, details: {} });

  // 8. INSIDE BAR — fully contained in mother candle
  if (c1.high < c2.high && c1.low > c2.low) {
    detected.push({ pattern: 'Inside Bar (Consolidation)', direction: 'NEUTRAL', strength: 50, details: { motherRange: Math.round(range(c2)*100000)/100000 } });
    // Inside bar false breakout: current closes back inside after breaking mother
    if (history.length >= 4) {
      const c0 = history[history.length - 1];
      if ((c0.high > c2.high && c0.close < c2.high) || (c0.low < c2.low && c0.close > c2.low)) {
        const dir = c0.close > (c2.high + c2.low)/2 ? 'BULLISH' : 'BEARISH';
        detected.push({ pattern: 'Inside Bar False Breakout', direction: dir, strength: 70, details: {} });
      }
    }
  }

  return detected;
}

// Get the strongest actionable pattern (BULLISH/BEARISH only)
function getStrongestSignal(history) {
  const all = detectAll(history).filter(p => p.direction !== 'NEUTRAL');
  if (!all.length) return null;
  return all.sort((a, b) => b.strength - a.strength)[0];
}

module.exports = { detectAll, getStrongestSignal };