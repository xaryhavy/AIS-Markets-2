// Market data store. Prices come only from the cTrader live feed (see ctrader/marketFeed.js).
// Nothing is simulated: a symbol is listed only while its live quotes are flowing.
// Bars are kept per timeframe: M1 for execution and backtests, M5/M15/H1 for higher-timeframe context.
const WANTED = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD'];
const TF_MINUTES = { M1: 1, M5: 5, M15: 15, H1: 60 };
const MAX_BARS = { M1: 6000, M5: 2000, M15: 2000, H1: 2000 };

const live = {};                                   // symbol -> { bid, ask, price, time }
const bars = { M1: {}, M5: {}, M15: {}, H1: {} };  // timeframe -> symbol -> [{ time, open, high, low, close }]

// Symbols AIS wants from the broker (whether or not they are currently live).
function wantedSymbols() { return WANTED; }
function timeframes() { return Object.keys(TF_MINUTES); }

// Symbols with live quotes right now.
function getSymbols() { return Object.keys(live); }
function isConnected() { return Object.keys(live).length > 0; }
function isLive(symbol) { return !!live[symbol]; }

function getPrice(symbol) { return live[symbol]?.price; }

function getHistory(symbol, limit = 50, tf = 'M1') {
  return (bars[tf][symbol] || []).slice(-limit);
}

// Latest quote as a tick; null when the symbol has no live feed.
function getTick(symbol) {
  return live[symbol] ? { symbol, price: live[symbol].price } : null;
}

// Replaces a symbol's bars for one timeframe (used to seed from broker trendbars).
function setBars(symbol, list, tf = 'M1') {
  bars[tf][symbol] = list.slice(-MAX_BARS[tf]);
}

// Applies a live quote and rolls it into the current bar of every timeframe.
function setQuote(symbol, bid, ask, time = Date.now()) {
  const price = (bid + ask) / 2;
  live[symbol] = { bid, ask, price, time };
  for (const [tf, minutes] of Object.entries(TF_MINUTES)) {
    const list = bars[tf][symbol] || (bars[tf][symbol] = []);
    const start = Math.floor(time / (minutes * 60000)) * minutes * 60000;
    const last = list[list.length - 1];
    if (last && last.time === start) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
    } else {
      list.push({ time: start, open: price, high: price, low: price, close: price });
      if (list.length > MAX_BARS[tf]) list.shift();
    }
  }
}

// Latest bid/ask/mid for a symbol, or undefined when there is no live feed.
function getQuote(symbol) {
  return live[symbol];
}

// Milliseconds since the last quote for this symbol arrived; Infinity when there is none.
function quoteAgeMs(symbol, nowMs = Date.now()) {
  return live[symbol] ? nowMs - live[symbol].time : Infinity;
}

// Called when the cTrader connection drops: prices are no longer trustworthy.
function clearLive() {
  for (const s of Object.keys(live)) delete live[s];
}

module.exports = { wantedSymbols, timeframes, getSymbols, isConnected, isLive, getPrice, getHistory, getTick, setBars, setQuote, clearLive, quoteAgeMs, getQuote, TF_MINUTES };
