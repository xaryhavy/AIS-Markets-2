// Deterministic tests for the backtest's cost model, intrabar exit handling and data-source labelling.
const test = require('node:test');
const assert = require('node:assert/strict');
const bt = require('../src/backtest/engine');

const buy = { action: 'BUY', stopLoss: 1.0950, takeProfit: 1.1150 };
const sell = { action: 'SELL', stopLoss: 1.1150, takeProfit: 1.0950 };

// ---- intrabar exit detection ----

test('a bar that touches neither level produces no exit', () => {
  assert.equal(bt.resolveExit(buy, { open: 1.10, high: 1.105, low: 1.096, close: 1.10 }).hit, null);
  assert.equal(bt.resolveExit(sell, { open: 1.10, high: 1.105, low: 1.096, close: 1.10 }).hit, null);
});

test('a stop touched inside the bar is seen even though the close never reaches it', () => {
  const r = bt.resolveExit(buy, { open: 1.10, high: 1.105, low: 1.094, close: 1.10 });
  assert.equal(r.hit, 'STOP');
  assert.equal(r.price, 1.0950);
  assert.equal(r.ambiguous, false);
});

test('a target touched inside the bar is seen even though the close never reaches it', () => {
  const r = bt.resolveExit(buy, { open: 1.10, high: 1.116, low: 1.096, close: 1.10 });
  assert.equal(r.hit, 'TARGET');
  assert.equal(r.price, 1.1150);
});

test('a short position mirrors the long levels', () => {
  assert.equal(bt.resolveExit(sell, { open: 1.10, high: 1.116, low: 1.096, close: 1.10 }).hit, 'STOP');
  assert.equal(bt.resolveExit(sell, { open: 1.10, high: 1.105, low: 1.094, close: 1.10 }).hit, 'TARGET');
});

test('a gap through the stop fills at the open, which is worse than the stop price', () => {
  const r = bt.resolveExit(buy, { open: 1.0900, high: 1.096, low: 1.0890, close: 1.0910 });
  assert.equal(r.hit, 'STOP');
  assert.equal(r.price, 1.0900);
  assert.ok(r.price < buy.stopLoss);
});

test('a stop and a target inside one bar are ambiguous, never resolved silently', () => {
  const r = bt.resolveExit(buy, { open: 1.10, high: 1.116, low: 1.094, close: 1.10 });
  assert.equal(r.hit, 'BOTH');
  assert.equal(r.ambiguous, true);
  assert.equal(r.price, null);
});

// ---- ambiguity policy ----

test('stop-first is the conservative default and assumes the stop was reached', () => {
  const bar = { open: 1.10, high: 1.116, low: 1.094, close: 1.10 };
  assert.equal(bt.ambiguousExit(buy, bar, 'stop-first'), 1.0950);
  assert.equal(bt.ambiguousExit(sell, bar, 'stop-first'), 1.1150);
});

test('target-first assumes the target was reached', () => {
  const bar = { open: 1.10, high: 1.116, low: 1.094, close: 1.10 };
  assert.equal(bt.ambiguousExit(buy, bar, 'target-first'), 1.1150);
  assert.equal(bt.ambiguousExit(sell, bar, 'target-first'), 1.0950);
});

test('the exclude policy drops the trade from the statistics instead of guessing', () => {
  const bar = { open: 1.10, high: 1.116, low: 1.094, close: 1.10 };
  assert.equal(bt.ambiguousExit(buy, bar, 'exclude'), null);
});

// ---- cost model ----

test('costs default to zero and are reported as not modelled', () => {
  const c = bt.normaliseCosts();
  assert.deepEqual(c, { spread: 0, slippage: 0, commission: 0 });
  assert.match(bt.costDisclosure(c), /no spread modelled/);
  assert.match(bt.costDisclosure(c), /no slippage modelled/);
  assert.match(bt.costDisclosure(c), /no commission modelled/);
});

test('a negative or non-numeric cost is refused rather than ignored', () => {
  assert.throws(() => bt.normaliseCosts({ spread: -0.0001 }), /non-negative/);
  assert.throws(() => bt.normaliseCosts({ commission: 'abc' }), /non-negative|number/);
});

test('entry and exit fills are both adverse, for longs and shorts', () => {
  const costs = bt.normaliseCosts({ spread: 0.0002, slippage: 0.0001 });
  // BUY: pay more to get in, receive less to get out.
  assert.equal(bt.entryFill('BUY', 1.1000, costs), 1.1002);
  assert.equal(bt.exitFill('BUY', 1.1010, costs), 1.1008);
  // SELL: receive less to get in, pay more to get out.
  assert.equal(bt.entryFill('SELL', 1.1000, costs), 1.0998);
  assert.equal(bt.exitFill('SELL', 1.0990, costs), 1.0992);
});

test('settle reports gross and net separately, with costs deducted once per trade', () => {
  const costs = bt.normaliseCosts({ spread: 0.0002, slippage: 0.0001, commission: 5 });
  const long = { action: 'BUY', size: 1000, entry: 1.1000, entryNet: bt.entryFill('BUY', 1.1000, costs) };
  const r = bt.settle(long, 1.1010, costs);
  assert.equal(Math.round(r.gross * 1000) / 1000, 1);
  assert.equal(Math.round(r.net * 1000) / 1000, -4.4);

  const short = { action: 'SELL', size: 1000, entry: 1.1000, entryNet: bt.entryFill('SELL', 1.1000, costs) };
  const s = bt.settle(short, 1.0990, costs);
  assert.equal(Math.round(s.gross * 1000) / 1000, 1);
  assert.equal(Math.round(s.net * 1000) / 1000, -4.4);
});

// ---- end to end ----

// A deterministic path: a long rise then a long fall, so momentum strategies produce real trades.
function trendingHistory(bars = 220) {
  const out = [];
  let price = 1.1000;
  for (let i = 0; i < bars; i++) {
    const open = price;
    const drift = i < bars / 2 ? 0.01 : -0.01;
    price = Number((price * (1 + drift)).toFixed(5));
    out.push({
      time: 1700000000000 + i * 60000,
      open,
      high: Math.max(open, price),
      low: Math.min(open, price),
      close: price
    });
  }
  return out;
}

test('synthetic history is labelled SYNTHETIC and supplied history is not', () => {
  assert.equal(bt.runBacktest('momentum', {}, { bars: 100 }).dataSource, 'SYNTHETIC');
  assert.equal(bt.runBacktest('momentum', {}, { history: trendingHistory() }).dataSource, 'SUPPLIED_HISTORY');
  assert.equal(bt.runBacktest('momentum', {}, { history: trendingHistory(), dataSource: 'CTRADER_BARS' }).dataSource, 'CTRADER_BARS');
});

test('an unknown ambiguity policy is refused', () => {
  const r = bt.runBacktest('momentum', {}, { history: trendingHistory(), ambiguityPolicy: 'wishful' });
  assert.match(r.error, /unknown ambiguity policy/i);
});

test('the same supplied history produces the same result twice', () => {
  const history = trendingHistory();
  const a = bt.runBacktest('momentum', {}, { history });
  const b = bt.runBacktest('momentum', {}, { history });
  assert.ok(a.totalTrades > 0, 'the fixture must produce trades for this test to mean anything');
  assert.equal(a.totalTrades, b.totalTrades);
  assert.equal(a.totalPnl, b.totalPnl);
  assert.equal(a.winRate, b.winRate);
});

test('adding costs lowers net P&L and is disclosed in the result', () => {
  const history = trendingHistory();
  const free = bt.runBacktest('momentum', {}, { history });
  const costly = bt.runBacktest('momentum', {}, { history, costs: { spread: 0.0004, slippage: 0.0001, commission: 2 } });
  assert.ok(free.totalTrades > 0, 'the fixture must produce trades for this test to mean anything');
  assert.ok(costly.totalPnl < free.totalPnl, 'costs must reduce net P&L');
  assert.equal(costly.totalCosts > 0, true);
  assert.equal(Math.round((costly.grossPnl - costly.totalPnl) * 100) / 100, costly.totalCosts);
  assert.match(costly.costAssumption, /spread 0.0004/);
  assert.match(costly.costAssumption, /commission 2/);
});

test('gross P&L never equals net P&L once costs are charged', () => {
  const r = bt.runBacktest('momentum', {}, { history: trendingHistory(), costs: { spread: 0.0004 } });
  if (r.totalTrades > 0) assert.notEqual(r.grossPnl, r.totalPnl);
});

test('an ambiguous bar is counted and reported rather than hidden', () => {
  const r = bt.runBacktest('momentum', {}, { history: trendingHistory(), ambiguityPolicy: 'exclude' });
  assert.equal(typeof r.ambiguousTrades, 'number');
  assert.equal(r.excludedAmbiguous, r.ambiguousTrades);
});
