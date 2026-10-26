// Yearly benchmarks (decision 8). Two labelled baselines, over the same period as the owner's results:
//   (a) buy-and-hold on each instrument traded in the period
//   (b) flat / cash (0% return; no interest is modelled)
// If the price history does not cover the period, buy-and-hold is reported as "benchmark unavailable". It is never estimated.
const DEFINITION = 'Buy-and-hold: close-to-close return on each traded instrument over the report period, using completed candles only. ' +
  'Flat/cash: 0% return. No interest, spread or commission is modelled for either baseline.';
const MAX_EDGE_GAP_MS = 2 * 3600000;     // the first and last bars must be within 2 hours of the period edges
const MIN_COVERAGE = 0.95;               // at least 95% of the period must be covered by bars, with no large hole

// Pure. Buy-and-hold for one instrument from its completed candles. `bars` are { time, close }.
function buyAndHold({ symbol, bars, startMs, endMs, periodMs = 60000 }) {
  const inside = (bars || []).filter(b => Number.isFinite(b.close) && b.time >= startMs - MAX_EDGE_GAP_MS && b.time <= endMs).sort((a, b) => a.time - b.time);
  if (!inside.length) return { symbol, status: 'BENCHMARK UNAVAILABLE', reason: 'no price history for the period' };
  const first = inside[0], last = inside[inside.length - 1];
  if (first.time - startMs > MAX_EDGE_GAP_MS) return { symbol, status: 'BENCHMARK UNAVAILABLE', reason: 'history does not start at the beginning of the period' };
  if (endMs - last.time > MAX_EDGE_GAP_MS) return { symbol, status: 'BENCHMARK UNAVAILABLE', reason: 'history does not reach the end of the period' };
  let covered = 0, largestHole = 0;
  for (let i = 1; i < inside.length; i++) {
    const step = inside[i].time - inside[i - 1].time;
    covered += Math.min(step, periodMs * 60);
    largestHole = Math.max(largestHole, step);
  }
  const coverage = covered / (endMs - startMs);
  if (coverage < MIN_COVERAGE) return { symbol, status: 'BENCHMARK UNAVAILABLE', reason: `history covers ${(coverage * 100).toFixed(1)}% of the period (needs ${MIN_COVERAGE * 100}%)` };
  const returnPct = (last.close - first.close) / first.close * 100;
  return { symbol, status: 'OK', returnPct: Math.round(returnPct * 100) / 100, from: new Date(first.time).toISOString(), to: new Date(last.time).toISOString(), coverage: Math.round(coverage * 1000) / 1000 };
}

// The benchmark section for a report. `barsBySymbol` maps symbol to bars (may be empty).
function build({ symbols, startMs, endMs, barsBySymbol = {} }) {
  const buyHold = [...new Set(symbols)].sort().map(s => buyAndHold({ symbol: s, bars: barsBySymbol[s] || [], startMs, endMs }));
  return {
    definition: DEFINITION,
    flatCash: { label: 'flat/cash baseline', status: 'OK', returnPct: 0 },
    buyAndHold: buyHold,
    unavailableCount: buyHold.filter(b => b.status !== 'OK').length
  };
}

module.exports = { buyAndHold, build, DEFINITION, MIN_COVERAGE, MAX_EDGE_GAP_MS };
