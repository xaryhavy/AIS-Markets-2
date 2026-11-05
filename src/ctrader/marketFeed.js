// Live cTrader market feed: maps AIS symbols to broker symbols, seeds 1-minute history,
// and streams bid/ask into the market data store.
const marketData = require('../data/marketdata');

// ProtoOATrendbarPeriod values and minutes per bar.
const PERIOD = { M1: 1, M5: 5, M15: 7, H1: 9 };
const SEED = { M1: 1, M5: 5, M15: 15, H1: 60 };
// Seed as deep as the store keeps, so the backtest can see the whole buffer from the first run. A shallower
// seed than the buffer is a silent cap: the store would never fill, and the model would learn from less
// history than the system appears to hold.
const SEED_BARS = { M1: marketData.maxBars('M1'), M5: marketData.maxBars('M5'), M15: marketData.maxBars('M15'), H1: marketData.maxBars('H1') };
const CHUNK = 1000; // broker returns at most this many bars per request

// Fetches `total` bars ending now, in chunks, oldest first, without duplicates.
// Stops when the broker has no more history, when a chunk adds nothing new (the broker is repeating itself),
// when the chunk limit is reached, or when the deadline passes. Without these the loop could run forever.
// Two weeks of M1 is 20 chunks of 1,000 bars per symbol, so the deadline has to cover a slow broker without
// letting a stuck one hold startup forever.
const FETCH_DEADLINE_MS = 180000;
async function fetchBars(client, accountId, symbolId, period, minutes, total, { deadlineMs = FETCH_DEADLINE_MS, now = Date.now } = {}) {
  const byTime = new Map();
  const deadline = now() + deadlineMs;
  const maxChunks = Math.ceil(total / CHUNK) + 2;
  let to = now();
  for (let chunk = 0; byTime.size < total && chunk < maxChunks; chunk++) {
    if (now() > deadline) throw new Error(`history fetch for symbol ${symbolId} timed out`);
    const count = Math.min(CHUNK, total - byTime.size);
    const from = to - count * minutes * 60000;
    const part = await client.getTrendbars({ ctidTraderAccountId: accountId, symbolId, period, count, fromTimestamp: from, toTimestamp: to });
    if (!part.length) break;
    const before = byTime.size;
    for (const b of part) {
      const low = Number(b.low);
      const bar = {
        time: Number(b.utcTimestampInMinutes) * 60000,
        open: (low + Number(b.deltaOpen || 0)) / PRICE_SCALE,
        high: (low + Number(b.deltaHigh || 0)) / PRICE_SCALE,
        low: low / PRICE_SCALE,
        close: (low + Number(b.deltaClose || 0)) / PRICE_SCALE
      };
      byTime.set(bar.time, bar);
    }
    if (byTime.size === before) break; // no new history: stop rather than repeat
    to = from;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
const PRICE_SCALE = 100000;   // cTrader prices are in 1/100000 of a unit

// Broker names that differ from ours.
const ALIASES = { XAUUSD: ['XAUUSD', 'GOLD'], BTCUSD: ['BTCUSD', 'BITCOIN'] };

const info = {};              // AIS symbol -> { symbolId, name, digits, minVolume, maxVolume, stepVolume }
let symbolBySpotId = {};      // broker symbolId -> AIS symbol
let feedReady = false;

function normalize(name) {
  return String(name || '').replace(/[\/\s_-]/g, '').toUpperCase();
}

async function start(client, accountId) {
  stop();
  const list = await client.getSymbolsList(accountId);
  const matched = {};
  for (const sym of marketData.wantedSymbols()) {
    const names = ALIASES[sym] || [sym];
    const hit = list.find(l => names.includes(normalize(l.symbolName)) && l.enabled !== false);
    if (hit) matched[sym] = { symbolId: Number(hit.symbolId), name: hit.symbolName };
    else console.log(`[cTrader] ${sym} is not offered by this broker — skipped`);
  }
  const ids = Object.values(matched).map(m => m.symbolId);
  if (!ids.length) throw new Error('None of the AIS symbols are offered by this broker');

  const details = await client.getSymbolsById(accountId, ids);
  for (const [sym, m] of Object.entries(matched)) {
    const d = details.find(x => Number(x.symbolId) === m.symbolId);
    if (!d) continue;
    info[sym] = {
      symbolId: m.symbolId,
      name: m.name,
      digits: d.digits,
      minVolume: Number(d.minVolume),
      maxVolume: Number(d.maxVolume),
      stepVolume: Math.max(1, Number(d.stepVolume))
    };
  }

  // Seed history for every timeframe so signals and multi-timeframe context are available immediately.
  for (const sym of Object.keys(info)) {
    for (const [tf, minutes] of Object.entries(SEED)) {
      const list = await fetchBars(client, accountId, info[sym].symbolId, PERIOD[tf], minutes, SEED_BARS[tf]);
      marketData.setBars(sym, list, tf);
      // A broker that holds less history than asked for is not an error, but it is the reason a backtest
      // covers less than expected — so it is said out loud rather than left to be discovered later.
      if (list.length < SEED_BARS[tf]) console.log(`[cTrader] ${sym} ${tf}: broker returned ${list.length} of ${SEED_BARS[tf]} bars`);
    }
  }

  symbolBySpotId = Object.fromEntries(Object.entries(info).map(([sym, i]) => [i.symbolId, sym]));
  client.onSpot = spot => {
    const sym = symbolBySpotId[Number(spot.symbolId)];
    if (!sym || !spot.bid || !spot.ask) return;
    // Stamped with arrival time: freshness is about when we heard the quote, not the broker's clock.
    marketData.setQuote(sym, spot.bid / PRICE_SCALE, spot.ask / PRICE_SCALE, Date.now());
  };
  await client.subscribeSpots(accountId, Object.keys(info).map(s => info[s].symbolId));
  feedReady = true;
  console.log(`[cTrader] live prices subscribed: ${Object.keys(info).join(', ')}`);
}

function stop() {
  feedReady = false;
  symbolBySpotId = {};
  for (const k of Object.keys(info)) delete info[k];
  marketData.clearLive();
}

function isReady() { return feedReady; }
function getInfo(symbol) {
  if (!info[symbol]) throw new Error(`${symbol} is not available on this cTrader account`);
  return info[symbol];
}

// AIS sizes positions in units; cTrader wants volume in cents (0.01 units), a multiple of stepVolume.
function unitsToVolume(symbol, units) {
  const i = getInfo(symbol);
  let cents = Math.min(Math.floor(units * 100 / i.stepVolume) * i.stepVolume, i.maxVolume);
  if (cents < i.minVolume) return 0;
  return cents;
}

// Our symbol name for a broker symbolId, or null.
function nameForSymbolId(symbolId) {
  const hit = Object.entries(info).find(([, i]) => i.symbolId === Number(symbolId));
  return hit ? hit[0] : null;
}

function roundPrice(symbol, price) {
  return Number(price.toFixed(getInfo(symbol).digits));
}

module.exports = { start, stop, isReady, getInfo, unitsToVolume, roundPrice, nameForSymbolId, fetchBars, PRICE_SCALE, PERIOD, SEED_BARS };
