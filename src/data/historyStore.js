// Deep bar history for backtesting, cached on disk.
//
// The live store keeps minutes-to-days of bars, which is right for trading and useless for learning: a model
// fitted on two weeks cannot see a second market regime, let alone a second year. This store fetches years of
// bars once, keeps them in data/history/<tf>/<symbol>.json, and tops up only what is missing on later runs.
// It is deliberately separate from marketdata: nothing in the trading path reads it.
const fs = require('fs-extra');
const path = require('path');
const marketFeed = require('../ctrader/marketFeed');

const DIR = process.env.AIS_HISTORY_DIR || path.join(__dirname, '../../data/history'); // env override is for tests
const TF_MINUTES = { M1: 1, M5: 5, M15: 15, H1: 60 };
const CHUNK = 1000;                 // the broker returns at most this many bars per request
const DEFAULT_DEADLINE_MS = 15 * 60000;

function fileFor(symbol, tf) { return path.join(DIR, tf, `${symbol}.json`); }

// How many bars of a timeframe cover `years`.
function barsFor(years, tf) {
  const minutes = TF_MINUTES[tf];
  if (!minutes) throw new Error(`unknown timeframe ${tf}`);
  return Math.ceil(years * 365 * 24 * 60 / minutes);
}

async function read(symbol, tf) {
  try {
    const j = await fs.readJson(fileFor(symbol, tf));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

async function write(symbol, tf, bars) {
  await fs.ensureDir(path.dirname(fileFor(symbol, tf)));
  await fs.writeJson(fileFor(symbol, tf), bars);
}

// Merges two series by bar time, oldest first. A bar present in both is taken from `newer`.
function merge(oldBars, newBars) {
  const byTime = new Map();
  for (const b of oldBars) byTime.set(b.time, b);
  for (const b of newBars) byTime.set(b.time, b);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// Loads `years` of bars for one symbol, fetching only what the cache does not already hold.
// Returns { bars, fetched, cached } so a caller can report how much of the window was real work.
async function load(symbol, tf, { years = 5, client, accountId, symbolId, deadlineMs = DEFAULT_DEADLINE_MS, now = Date.now } = {}) {
  const want = barsFor(years, tf);
  const minutes = TF_MINUTES[tf];
  const period = marketFeed.PERIOD[tf];
  let bars = await read(symbol, tf);
  const cached = bars.length;
  let fetched = 0;

  const windowStart = now() - years * 365 * 24 * 60 * 60000;
  // `want` is rounded up, so a full cache holds `want` bars whose oldest is up to one bar interval newer than
  // the window start. Without that tolerance a complete cache never counts as covering the window, and every
  // run re-downloads the whole thing.
  const coversWindow = bars.length > 0 && bars[0].time <= windowStart + minutes * 60000;

  if (!coversWindow) {
    // Fetch the older part, ending at the oldest bar already held, so the cache grows backwards without
    // re-downloading what it has. With no cache at all this is simply the whole window.
    const endAt = bars.length ? bars[0].time : now();
    const missing = Math.max(CHUNK, want - bars.length);
    const older = await marketFeed.fetchBars(client, accountId, symbolId, period, minutes, missing, {
      deadlineMs, now: () => endAt
    });
    fetched += older.length;
    bars = merge(older, bars);
  }

  // Top up the recent end: bars that closed since the cache was written.
  if (bars.length) {
    const last = bars[bars.length - 1].time;
    const gapBars = Math.ceil((now() - last) / (minutes * 60000));
    if (gapBars > 1) {
      const recent = await marketFeed.fetchBars(client, accountId, symbolId, period, minutes, Math.min(gapBars + CHUNK, want), { deadlineMs });
      fetched += recent.length;
      bars = merge(bars, recent);
    }
  }

  bars = bars.slice(-want);
  if (fetched) await write(symbol, tf, bars);
  return { bars, fetched, cached };
}

// Aggregates a bar series into a higher timeframe by whole buckets. Used to derive the context frames from
// the backtest series itself, so the frames are exactly aligned with the bars the strategies traded.
// `baseMinutes` is the timeframe of `bars`: the bucket width is factor × base, not factor minutes.
function aggregate(bars, factor, baseMinutes = 1) {
  if (factor <= 1) return bars;
  const span = factor * baseMinutes * 60000;
  const out = [];
  let bucket = null;
  for (const b of bars) {
    const start = Math.floor(b.time / span) * span;
    if (!bucket || bucket.time !== start) {
      if (bucket) out.push(bucket);
      bucket = { time: start, open: b.open, high: b.high, low: b.low, close: b.close };
    } else {
      bucket.high = Math.max(bucket.high, b.high);
      bucket.low = Math.min(bucket.low, b.low);
      bucket.close = b.close;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

async function clear(symbol, tf) { await fs.remove(fileFor(symbol, tf)).catch(() => {}); }

module.exports = { load, aggregate, barsFor, merge, clear, fileFor, DIR, TF_MINUTES };
