const test = require('node:test');
const assert = require('node:assert/strict');
const risk = require('../src/risk/riskManager');

test('exposure: USD-quoted pairs are units x price', () => {
  assert.equal(risk.notionalUsd('EURUSD', 1000, 1.1), 1100);
  assert.equal(risk.notionalUsd('XAUUSD', 2, 4000), 8000);
});

test('exposure: USD-base pairs are already in USD', () => {
  assert.equal(risk.notionalUsd('USDJPY', 1000, 150), 1000);
});

test('stops from ATR for a BUY on EURUSD', () => {
  const s = risk.calculateStops('EURUSD', 1.1, 'BUY', 0.002);
  assert.equal(s.stopLoss, 1.097);
  assert.equal(s.takeProfit, 1.109);
});

test('stops from ATR for a SELL on USDJPY use 3 decimals', () => {
  const s = risk.calculateStops('USDJPY', 150, 'SELL', 0.3);
  assert.equal(s.stopLoss, 150.45);
  assert.equal(s.takeProfit, 148.65);
});

test('stops fall back to 0.2% of price when ATR is unavailable', () => {
  const s = risk.calculateStops('EURUSD', 1.1, 'BUY', undefined);
  assert.equal(s.stopLoss, 1.0967);
});

test('price precision follows the price level', () => {
  assert.equal(risk.priceDecimals(1.1), 5);
  assert.equal(risk.priceDecimals(150), 3);
  assert.equal(risk.priceDecimals(4000), 2);
});

test('every trade is at least 1:3 reward to risk', () => {
  for (const [sym, price, action, atr] of [['EURUSD', 1.1, 'BUY', 0.002], ['USDJPY', 150, 'SELL', 0.3], ['XAUUSD', 4000, 'BUY', 12], ['BTCUSD', 81000, 'SELL', undefined]]) {
    const stops = risk.calculateStops(sym, price, action, atr);
    assert.ok(risk.riskReward(stops, price) >= risk.MIN_REWARD_RISK - 0.05, `${sym} below 1:3`);
  }
});
