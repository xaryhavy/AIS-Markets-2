// Supply & Demand Zone Detector — Institutional Trading (from Candlestick Bible)
// Demand Zone = Rally-Base-Rally / Drop-Base-Rally (institutions accumulate here)
// Supply Zone = Rally-Base-Drop / Drop-Base-Drop (institutions distribute here)

function body(c) { return Math.abs(c.close - c.open); }
function isGreen(c) { return c.close > c.open; }
function isRed(c) { return c.close < c.open; }

// Average body size over a window
function avgBody(history, from, window = 10) {
  const slice = history.slice(Math.max(0, from - window), from);
  if (!slice.length) return 0;
  return slice.reduce((s, c) => s + body(c), 0) / slice.length;
}

// Detect all supply/demand zones in recent history
function detectZones(history, lookback = 60) {
  const zones = { demand: [], supply: [] };
  const slice = history.slice(-lookback);
  
  for (let i = 3; i < slice.length - 1; i++) {
    const avg = avgBody(slice, i, 10);
    if (avg === 0) continue;
    
    // Check for a BASE (1-3 small candles) followed by a STRONG MOVE candle
    for (let baseLen = 1; baseLen <= 3 && i - baseLen >= 0; baseLen++) {
      const baseCandles = slice.slice(i - baseLen, i);
      const moveCandle = slice[i];
      const moveBody = body(moveCandle);
      
      // Base candles must be small (consolidation)
      const baseSmall = baseCandles.every(c => body(c) < avg * 0.8);
      // Move candle must be strong (≥1.5x average)
      const moveStrong = moveBody > avg * 1.5;
      
      if (!baseSmall || !moveStrong) continue;
      
      const baseHigh = Math.max(...baseCandles.map(c => c.high));
      const baseLow = Math.min(...baseCandles.map(c => c.low));
      const baseMid = (baseHigh + baseLow) / 2;
      
      // Count how many times price has returned to this zone (freshness)
      let touches = 0;
      for (let j = i + 1; j < slice.length; j++) {
        if (slice[j].low <= baseHigh && slice[j].high >= baseLow) touches++;
      }
      const freshness = Math.max(0, 100 - touches * 25); // 100 = untouched, drops with each touch
      
      if (isGreen(moveCandle)) {
        // Bullish move away → base is a DEMAND zone (institutions bought)
        zones.demand.push({
          type: 'DEMAND',
          upper: baseHigh,
          lower: baseLow,
          mid: baseMid,
          strength: Math.min(100, Math.round(moveBody / avg * 30)),
          freshness,
          touched: touches,
          formedAtIndex: i,
          pattern: baseLen === 1 ? 'Drop-Base-Rally' : 'Rally-Base-Rally'
        });
      } else {
        // Bearish move away → base is a SUPPLY zone (institutions sold)
        zones.supply.push({
          type: 'SUPPLY',
          upper: baseHigh,
          lower: baseLow,
          mid: baseMid,
          strength: Math.min(100, Math.round(moveBody / avg * 30)),
          freshness,
          touched: touches,
          formedAtIndex: i,
          pattern: baseLen === 1 ? 'Rally-Base-Drop' : 'Drop-Base-Drop'
        });
      }
      break; // found a base at this index, move on
    }
  }
  
  // Sort by freshness (freshest first) and keep top 5 of each
  zones.demand = zones.demand.sort((a, b) => b.freshness - a.freshness).slice(0, 5);
  zones.supply = zones.supply.sort((a, b) => b.freshness - a.freshness).slice(0, 5);
  return zones;
}

// Check if price is currently inside/near a zone
function atZone(price, zones, type, pct = 0.003) {
  return zones.filter(z => z.type === type).find(z => {
    const zoneMid = z.mid;
    const zoneWidth = (z.upper - z.lower) / 2;
    return Math.abs(price - zoneMid) < (zoneWidth + price * pct);
  });
}

// Get the strongest fresh zone near current price
function getRelevantZone(history, direction) {
  const zones = detectZones(history);
  const price = history[history.length - 1].close;
  if (direction === 'BULLISH') return atZone(price, zones.demand, 'DEMAND');
  if (direction === 'BEARISH') return atZone(price, zones.supply, 'SUPPLY');
  return null;
}

module.exports = { detectZones, atZone, getRelevantZone };