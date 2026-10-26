const test = require('node:test');
const assert = require('node:assert/strict');
const limits = require('../src/risk/limits');
const preTrade = require('../src/risk/preTrade');

// Pure tests only: nothing here writes to the data folder (limits.init and approve are not called).
const cfg = limits.active();
const base = {
  cfg, balance: 10000, bid: 1.09999, ask: 1.10001,
  openPositions: [], emergency: false, consecutiveLosses: 0, drawdownPct: 0, nowMs: Date.parse('2026-10-26T12:00:00Z')
};
const buy = { symbol: 'EURUSD', action: 'BUY', units: 1000, price: 1.1, stopLoss: 1.097, takeProfit: 1.109 };
const ok = (over = {}, o = {}) => preTrade.check({ ...buy, ...o }, { ...base, ...over });

test('the active configuration matches the values AIS already used', () => {
  assert.equal(cfg.riskPerTradePct, 1);
  assert.equal(cfg.maxOpenPositions, 3);
  assert.equal(cfg.maxExposurePct, 20);
  assert.equal(cfg.minRewardRisk, 3);
  assert.equal(cfg.stopAtrMultiple, 1.5);
});

test('proposed limits are NOT in effect until approved', () => {
  assert.equal(cfg.maxTotalOpenRiskPct, null);
  assert.equal(cfg.maxDrawdownPct, null);
  assert.equal(cfg.maxSpreadPct, null);
  assert.equal(cfg.maxConsecutiveLosses, null);
  assert.deepEqual(cfg.blockedSessionsUtc, []);
});

test('values outside safe bounds are refused', () => {
  assert.match(limits.checkValue('riskPerTradePct', 5), /between/);
  assert.match(limits.checkValue('minRewardRisk', 2), /between/, 'cannot drop below 1:3');
  assert.match(limits.checkValue('maxOpenPositions', 2.5), /whole number/);
  assert.match(limits.checkValue('maxOpenPositions', 50), /between/);
  assert.match(limits.checkValue('maxSpreadPct', NaN), /number/);
  assert.equal(limits.checkValue('riskPerTradePct', 0.5), null);
  assert.match(limits.checkValue('notARealLimit', 1), /Unknown/);
});

test('a valid, well-protected trade is allowed', () => {
  assert.deepEqual(ok().reasons, []);
  assert.equal(ok().allow, true);
});

test('a stop on the wrong side of the entry is refused', () => {
  const r = ok({}, { stopLoss: 1.103 });
  assert.equal(r.allow, false);
  assert.match(r.reasons.join(' '), /wrong side/);
});

test('reward to risk below 1:3 is refused', () => {
  const r = ok({}, { takeProfit: 1.106 }); // 2R
  assert.match(r.reasons.join(' '), /reward to risk 2\.00/);
});

test('risk per trade above the limit is refused', () => {
  const r = ok({}, { units: 1000 }); // 3 USD at stop, well within limits
  const big = ok({}, { units: 40000 }); // 120 USD = 1.2% of 10000
  assert.equal(r.allow, true, 'within limit');
  assert.match(big.reasons.join(' '), /risk 1\.2\d% of balance exceeds 1%/);
});

test('the position count limit is enforced', () => {
  const open = [1, 2, 3].map(i => ({ symbol: 'GBPUSD', volume: 100000, price: 1.27, stopLoss: 1.26 + i * 0.001 }));
  assert.match(ok({ openPositions: open }).reasons.join(' '), /3 positions open; limit 3/);
});

test('exposure above the limit is refused', () => {
  const open = [{ symbol: 'XAUUSD', volume: 300, price: 4000, stopLoss: 3990 }]; // 3 units x 4000 = 12000 notional
  assert.match(ok({ openPositions: open }, { units: 200 }).reasons.join(' '), /exposure would exceed 20%/);
});

test('a position with no stop-loss holds all new entries', () => {
  const open = [{ symbol: 'USDJPY', volume: 100000, price: 150, stopLoss: 0 }];
  assert.match(ok({ openPositions: open }).reasons.join(' '), /no stop-loss/);
});

test('an emergency stop refuses every entry', () => {
  assert.match(ok({ emergency: true }).reasons.join(' '), /emergency stop is on/);
});

test('an unknown balance refuses entries', () => {
  assert.match(ok({ balance: null }).reasons.join(' '), /balance unknown/);
});

test('an enabled spread limit refuses wide spreads and unknown spreads', () => {
  const on = { ...cfg, maxSpreadPct: 0.05 };
  assert.match(ok({ cfg: on, ask: 1.102 }).reasons.join(' '), /spread .* exceeds 0\.05%/);
  assert.match(ok({ cfg: on, bid: undefined }).reasons.join(' '), /spread unknown/);
  assert.equal(ok({ cfg: on }).allow, true);
});

test('an enabled drawdown limit refuses entries at or beyond it', () => {
  const on = { ...cfg, maxDrawdownPct: 10 };
  assert.match(ok({ cfg: on, drawdownPct: 12 }).reasons.join(' '), /drawdown 12\.0% is at or above 10%/);
  assert.equal(ok({ cfg: on, drawdownPct: 4 }).allow, true);
});

test('an enabled consecutive-loss limit refuses entries', () => {
  const on = { ...cfg, maxConsecutiveLosses: 5 };
  assert.match(ok({ cfg: on, consecutiveLosses: 5 }).reasons.join(' '), /5 consecutive losses/);
});

test('an enabled session window refuses entries inside it only', () => {
  const on = { ...cfg, blockedSessionsUtc: [{ from: '09:00', to: '10:00' }] };
  assert.match(ok({ cfg: on, nowMs: Date.parse('2026-10-26T09:30:00Z') }).reasons.join(' '), /blocked UTC session/);
  assert.equal(ok({ cfg: on, nowMs: Date.parse('2026-10-26T11:00:00Z') }).allow, true);
});

test('session windows that cross midnight work', () => {
  const w = [{ from: '23:00', to: '01:00' }];
  assert.equal(limits.inBlockedSession(w, Date.parse('2026-10-26T23:30:00Z')), true);
  assert.equal(limits.inBlockedSession(w, Date.parse('2026-10-26T00:30:00Z')), true);
  assert.equal(limits.inBlockedSession(w, Date.parse('2026-10-26T12:00:00Z')), false);
});

test('risk on USD-base pairs converts the quote currency to USD', () => {
  // 1000 units, 0.45 yen risk per unit at 150 yen per dollar = 3 USD
  assert.ok(Math.abs(preTrade.riskUsd('USDJPY', 1000, 150, 149.55) - 3) < 1e-9);
});

test('drawdown is measured from the highest balance in the window', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const h = [{ t: now - 3600000, balance: 100 }, { t: now - 1800000, balance: 120 }, { t: now, balance: 108 }];
  assert.ok(Math.abs(limits.drawdownPct(h, now) - 10) < 1e-9);
  const old = [{ t: now - 90 * 86400000, balance: 1000 }, { t: now, balance: 500 }];
  assert.equal(limits.drawdownPct(old, now), 0, 'points outside the 30-day window are ignored');
});
