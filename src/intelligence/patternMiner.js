// Finds recurring situations that have been profitable both early and late in the history, and proposes
// them to the owner. A proposal changes nothing until the owner approves it; approval only moves matching
// signals to the front of the queue. Rejected proposals are never shown again.
const fs = require('fs-extra');
const path = require('path');
const storage = require('../data/storage');

const PROPOSALS_FILE = path.join(__dirname, '../../data/proposals.json');
const MIN_IN_SAMPLE = 30;
const MIN_OUT_OF_SAMPLE = 10;
const MIN_WIN_IN = 0.55;
const MIN_WIN_OUT = 0.5;
const TOP_N = 10;
const SPLIT = 0.7; // earliest 70% of trades train the rule, the latest 30% test it

let cache = { proposals: {} };

async function init() {
  cache = await fs.readJson(PROPOSALS_FILE).catch(() => ({ proposals: {} }));
  cache.proposals = cache.proposals || {};
}

async function save() {
  await fs.ensureDir(path.dirname(PROPOSALS_FILE));
  await fs.writeJson(PROPOSALS_FILE, cache, { spaces: 2 });
}

// Tokens describing a trade's situation: "regime=RANGING", "hour=14", "pattern=Bullish Engulfing", ...
function tokensOf(trade) {
  const f = trade.features || {};
  const t = [];
  if (f.regime) t.push(`regime=${f.regime}`);
  if (f.hourUtc !== undefined && f.hourUtc !== null) t.push(`hour=${f.hourUtc}`);
  if (f.dayOfWeek !== undefined && f.dayOfWeek !== null) t.push(`day=${f.dayOfWeek}`);
  if (f.strategy) t.push(`strategy=${f.strategy}`);
  for (const p of f.patterns || []) t.push(`pattern=${p}`);
  t.push(`symbol=${trade.symbol}`, `action=${trade.action}`);
  return [...new Set(t)].sort();
}

function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winRate: 0, avgPnl: 0 };
  const wins = trades.filter(t => t.pnl > 0).length;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  return { n, winRate: Math.round(wins / n * 1000) / 1000, avgPnl: Math.round(total / n * 100) / 100 };
}

// Every single token and every pair of tokens is a candidate rule.
function candidateKeys(tokens) {
  const keys = tokens.map(t => [t]);
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) keys.push([tokens[i], tokens[j]]);
  }
  return keys;
}

// Pure: takes closed trades (with pnl, openTime, features) and returns the proposals that pass both samples.
function findRules(trades) {
  const usable = trades
    .filter(t => Number.isFinite(Number(t.pnl)) && t.openTime && t.features)
    .map(t => ({ ...t, pnl: Number(t.pnl) }))
    .sort((a, b) => new Date(a.openTime) - new Date(b.openTime));
  const cut = Math.floor(usable.length * SPLIT);

  const index = new Map(); // rule key -> { tokens, members: [trade positions] }
  usable.forEach((t, pos) => {
    for (const tokens of candidateKeys(tokensOf(t))) {
      const key = tokens.join(' AND ');
      if (!index.has(key)) index.set(key, { tokens, members: [] });
      index.get(key).members.push(pos);
    }
  });

  const found = [];
  for (const [key, { tokens, members }] of index) {
    const inS = stats(members.filter(p => p < cut).map(p => usable[p]));
    const outS = stats(members.filter(p => p >= cut).map(p => usable[p]));
    if (inS.n < MIN_IN_SAMPLE || outS.n < MIN_OUT_OF_SAMPLE) continue;
    if (inS.winRate < MIN_WIN_IN || inS.avgPnl <= 0) continue;
    if (outS.winRate < MIN_WIN_OUT || outS.avgPnl <= 0) continue;
    found.push({ key, tokens, inSample: inS, outOfSample: outS });
  }
  return found.sort((a, b) => b.outOfSample.avgPnl - a.outOfSample.avgPnl).slice(0, TOP_N);
}

// Mines live and backtest trades, then adds new proposals. Existing decisions are kept.
async function mine(liveTrades, backtestTrades) {
  const found = findRules([...liveTrades, ...backtestTrades]);
  const now = new Date().toISOString();
  for (const r of found) {
    const existing = cache.proposals[r.key];
    if (existing) {
      existing.inSample = r.inSample;
      existing.outOfSample = r.outOfSample;
      existing.lastMinedAt = now;
      continue;
    }
    cache.proposals[r.key] = {
      key: r.key,
      tokens: r.tokens,
      description: r.tokens.join(' AND '),
      inSample: r.inSample,
      outOfSample: r.outOfSample,
      status: 'PROPOSED',
      proposedAt: now,
      lastMinedAt: now
    };
  }
  await save();
  return list();
}

function list() {
  return Object.values(cache.proposals).sort((a, b) => {
    const order = { PROPOSED: 0, APPROVED: 1, REJECTED: 2 };
    return order[a.status] - order[b.status] || b.outOfSample.avgPnl - a.outOfSample.avgPnl;
  });
}

async function decide(key, decision) {
  const p = cache.proposals[key];
  if (!p) throw new Error('Unknown proposal');
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw new Error('Decision must be APPROVED or REJECTED');
  p.status = decision;
  p.decidedAt = new Date().toISOString();
  await save();
  return p;
}

// How many approved rules a signal matches. Used only to order signals.
function approvalScore(features, symbol, action) {
  const have = new Set(tokensOf({ features, symbol, action }));
  let n = 0;
  for (const p of Object.values(cache.proposals)) {
    if (p.status === 'APPROVED' && p.tokens.every(t => have.has(t))) n++;
  }
  return n;
}

// Loads the live trades (closed, with features) for mining.
async function liveClosedTrades() {
  const trades = await storage.load('trades');
  return trades.filter(t => t.source === 'ctrader' && t.status === 'CLOSED' && t.features);
}

module.exports = { init, mine, list, decide, approvalScore, findRules, tokensOf, liveClosedTrades };
