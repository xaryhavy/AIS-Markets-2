function sma(data, period) {
  if (data.length < period) return null;
  return data.slice(-period).reduce((s, b) => s + b.close, 0) / period;
}
function ema(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let e = data.slice(0, period).reduce((s, b) => s + b.close, 0) / period;
  for (let i = period; i < data.length; i++) e = data[i].close * k + e * (1 - k);
  return e;
}
function rsi(data, period = 14) {
  if (data.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const d = data[i].close - data[i - 1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / (losses / period));
}
function macd(data) {
  const e12 = ema(data, 12), e26 = ema(data, 26);
  if (!e12 || !e26) return { macd: 0, signal: 0, histogram: 0 };
  const macdLine = e12 - e26;
  const closes = data.map(b => b.close);
  const signalLine = closes.slice(-9).reduce((s, c) => s + c, 0) / 9;
  return { macd: macdLine, signal: signalLine, histogram: macdLine - signalLine };
}
function bollinger(data, period = 20, mult = 2) {
  if (data.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = data.slice(-period).map(b => b.close);
  const mid = slice.reduce((s, c) => s + c, 0) / period;
  const variance = slice.reduce((s, c) => s + (c - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mid + mult * sd, middle: mid, lower: mid - mult * sd };
}
function atr(data, period = 14) {
  if (data.length < period + 1) return data[data.length - 1].close * 0.002;
  let sum = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const tr = Math.max(data[i].high - data[i].low, Math.abs(data[i].high - data[i - 1].close), Math.abs(data[i].low - data[i - 1].close));
    sum += tr;
  }
  return sum / period;
}
function stdDev(data, period = 20) {
  if (data.length < period) return 0;
  const slice = data.slice(-period).map(b => b.close);
  const mean = slice.reduce((s, c) => s + c, 0) / period;
  return Math.sqrt(slice.reduce((s, c) => s + (c - mean) ** 2, 0) / period);
}
function roc(data, period = 10) {
  if (data.length < period + 1) return 0;
  return (data[data.length - 1].close - data[data.length - 1 - period].close) / data[data.length - 1 - period].close;
}
module.exports = { sma, ema, rsi, macd, bollinger, atr, stdDev, roc };