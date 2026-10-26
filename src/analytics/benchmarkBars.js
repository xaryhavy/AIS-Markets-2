// Loads hourly completed bars from the broker for the yearly benchmarks (decision 8).
// Read-only: it only requests trend bars. Failures return an empty list, which the benchmark
// reports as "benchmark unavailable". Nothing is estimated or filled in.
const marketFeed = require('../ctrader/marketFeed');

const HOUR_MS = 3600000;

// Returns { time, close } bars covering [now - hours, now], completed only.
async function loadHourly({ client, accountId, symbolId, hours, now = Date.now() }) {
  if (!client || !Number.isFinite(symbolId)) return [];
  try {
    const bars = await marketFeed.fetchBars(client, accountId, symbolId, marketFeed.PERIOD.H1, 60, Math.ceil(hours));
    const cutoff = now - HOUR_MS; // the newest bar may still be forming; only completed bars are used
    return bars.filter(b => b.time + HOUR_MS <= now && b.time >= now - hours * HOUR_MS).map(b => ({ time: b.time, close: b.close }));
  } catch (e) {
    return [];
  }
}

// Hourly bars for every symbol given. Symbols the broker does not offer map to an empty list.
async function loadForSymbols({ client, accountId, symbols, hours, now = Date.now(), getInfo = marketFeed.getInfo }) {
  const out = {};
  for (const s of symbols) {
    const info = getInfo(s);
    out[s] = info ? await loadHourly({ client, accountId, symbolId: info.symbolId, hours, now }) : [];
  }
  return out;
}

module.exports = { loadHourly, loadForSymbols, HOUR_MS };
