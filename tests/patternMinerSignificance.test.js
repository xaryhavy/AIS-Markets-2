const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// The proposals file is redirected before the module is required, so no test writes into the repo data dir.
const tmpFile = path.join(os.tmpdir(), `ais-proposals-${process.pid}-${Date.now()}.json`);
process.env.AIS_PROPOSALS_FILE = tmpFile;

const miner = require('../src/intelligence/patternMiner');
const evaluation = require('../src/analytics/evaluation');

function rng(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function trades(n, plant) {
  const r = rng(42);
  const out = [];
  for (let i = 0; i < n; i++) {
    const inEarly = i < n * 0.7;
    const pattern = i % 3 === 0 ? 'Bullish Engulfing' : 'Doji';
    const regime = i % 2 === 0 ? 'RANGING' : 'TRENDING_UP';
    const features = { regime, hourUtc: i % 24, dayOfWeek: i % 7, strategy: 'rsi', patterns: [pattern] };
    const planted = plant(i, inEarly, pattern, regime);
    const win = planted !== null ? planted : r() < 0.45;
    out.push({
      symbol: 'EURUSD', action: 'BUY', features,
      pnl: win ? 10 : -10,
      openTime: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString()
    });
  }
  return out;
}

// Every token, and every pair of tokens, is a rule examined. The miner reports that count.
test('the number of rules examined is reported on each proposal', () => {
  const data = trades(600, (i, early, pattern, regime) => (pattern === 'Bullish Engulfing' && regime === 'RANGING') ? (i % 5) !== 0 : null);
  const rules = miner.findRules(data);
  assert.ok(rules.length > 0, 'expected at least one rule');
  for (const r of rules) {
    assert.ok(Number.isInteger(r.candidatesTested) && r.candidatesTested > 0, 'candidatesTested must be a positive integer');
    assert.equal(r.candidatesTested, rules[0].candidatesTested, 'every rule was judged against the same candidate space');
  }
});

// The correction divides the threshold by the number of rules tried, so a wide search makes a rule
// harder to call significant, not easier.
test('the significance threshold is divided by the number of rules examined', () => {
  const data = trades(600, (i, early, pattern, regime) => (pattern === 'Bullish Engulfing' && regime === 'RANGING') ? (i % 5) !== 0 : null);
  const rules = miner.findRules(data);
  const sig = rules.find(r => r.significance && r.significance.tStatistic !== null);
  assert.ok(sig, 'expected at least one rule with a computable t-statistic');
  const expected = Math.round((0.05 / sig.candidatesTested) * 1e12) / 1e12;
  assert.ok(Math.abs(sig.significance.adjustedAlpha - expected) < 1e-9, 'adjusted alpha must be alpha / candidatesTested');
  assert.ok(sig.significance.zNeeded > 1.96, 'a corrected threshold must be stricter than the uncorrected one');
});

// A rule whose win rate clears the miner's own thresholds but whose edge is weak must not be
// presented as statistically established.
test('a weak edge does not clear the corrected threshold', () => {
  // 56% wins on the held-back trades: clears MIN_WIN_OUT of 0.5, but the mean is small against the spread.
  const weak = Array.from({ length: 40 }, (_, i) => (i % 25 < 14 ? 10 : -10));
  const sig = evaluation.significanceOf(weak, { strategiesTested: 500 });
  assert.equal(sig.clearsThreshold, false, 'a weak edge under a wide search must not clear');
  assert.ok(sig.tStatistic !== null);
});

test('a strong edge with a sufficient sample clears the corrected threshold', () => {
  const strong = Array.from({ length: 120 }, (_, i) => (i % 10 < 9 ? 10 : -10));
  const sig = evaluation.significanceOf(strong, { strategiesTested: 50 });
  assert.equal(sig.clearsThreshold, true);
});

test('a sample below the minimum never clears, however strong the numbers look', () => {
  const few = [10, 10, 10, 10, 10];
  const sig = evaluation.significanceOf(few, { strategiesTested: 1 });
  assert.equal(sig.clearsThreshold, false);
});

test('the same P&L series always gives the same significance', () => {
  const series = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? -10 : 12));
  assert.deepEqual(evaluation.significanceOf(series, { strategiesTested: 7 }), evaluation.significanceOf(series, { strategiesTested: 7 }));
});

// A rejection is a recorded decision with a reason attached, not a silent disappearance.
test('a rejected proposal keeps the owner\'s reason on the record', async () => {
  await miner.init();
  await miner.mine(trades(600, (i, early, pattern, regime) => (pattern === 'Bullish Engulfing' && regime === 'RANGING') ? (i % 5) !== 0 : null), []);
  const proposal = miner.list()[0];
  assert.ok(proposal, 'expected a proposal to decide on');
  const p = await miner.decide(proposal.key, 'REJECTED', 'edge too small to risk capital');
  assert.equal(p.status, 'REJECTED');
  assert.equal(p.rejectedReason, 'edge too small to risk capital');
  // The decision survives a reload from disk.
  await miner.init();
  assert.equal(miner.list().find(x => x.key === proposal.key).rejectedReason, 'edge too small to risk capital');
});

test('a rejection with no reason says so rather than leaving the field empty', async () => {
  await miner.init();
  await miner.mine(trades(600, (i, early, pattern, regime) => (pattern === 'Bullish Engulfing' && regime === 'RANGING') ? (i % 5) !== 0 : null), []);
  const proposal = miner.list()[0];
  const p = await miner.decide(proposal.key, 'REJECTED');
  assert.equal(p.rejectedReason, 'no reason recorded');
});

test.after(() => { try { fs.unlinkSync(tmpFile); } catch { /* nothing to clean up */ } });
