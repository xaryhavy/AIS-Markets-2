// Owner reports (daily, weekly, monthly, yearly). Pure builder: give it records, get a report.
// Rules: realised results come only from broker-demo trades (source 'ctrader') closed inside the period.
// Estimates, hypothetical NO-TRADE outcomes and simulated records are shown in their own sections.
// Every report lists its sources, its generation time and the data it does not have.
const noTrade = require('../governance/noTrade');
const benchmarks = require('../analytics/benchmarks');

const MIN_SAMPLE = 30;
const CODES_RISK = new Set(['RISK_ADMISSION', 'PRETRADE_BOUNDARY', 'ENTRY_BLOCKED']);
const INTENT_BAD = new Set(['UNKNOWN', 'PROTECTION_FAILED', 'CLOSED_EMERGENCY', 'NOT_FILLED']);

// Calendar periods in UTC.
function periodStart(period, now) {
  const d = new Date(now);
  if (period === 'daily') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (period === 'weekly') {
    const daysSinceMonday = (d.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday));
  }
  if (period === 'monthly') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

const round2 = x => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const pct = (k, n) => (n ? Math.round(k / n * 1000) / 10 : null);

function sampleFlag(n) {
  return n >= MIN_SAMPLE ? 'sufficient' : `insufficient (n=${n}, need ${MIN_SAMPLE})`;
}

// Largest peak-to-trough fall in balance samples inside the window, as % of the peak.
function maxDrawdownInPeriod(samples, start, end) {
  const pts = samples.filter(p => p.t >= start.getTime() && p.t <= end.getTime()).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  let peak = pts[0].balance, worst = 0;
  for (const p of pts) {
    peak = Math.max(peak, p.balance);
    if (peak > 0) worst = Math.max(worst, (peak - p.balance) / peak * 100);
  }
  return Math.round(worst * 100) / 100;
}

function groupPnl(trades, keyFn) {
  const g = {};
  for (const t of trades) {
    const k = keyFn(t) || 'unknown';
    const e = (g[k] ||= { trades: 0, pnl: 0, wins: 0 });
    e.trades++;
    e.pnl += Number(t.pnl) || 0;
    if (Number(t.pnl) > 0) e.wins++;
  }
  return Object.fromEntries(Object.entries(g).map(([k, e]) => [k, {
    trades: e.trades, realisedPnl: round2(e.pnl), winRatePct: pct(e.wins, e.trades), sample: sampleFlag(e.trades)
  }]));
}

function build({ period, now = new Date(), trades = [], decisions = [], outcomes = [], intents = [], equity = [], snapshot = {}, barsBySymbol = {} }) {
  const start = periodStart(period, now);
  const end = now;
  const inP = iso => { if (!iso) return false; const t = new Date(iso); return t >= start && t <= end; };

  const demo = trades.filter(t => t.source === 'ctrader');
  const closed = demo.filter(t => t.status === 'CLOSED' && inP(t.closeTime));
  const exact = closed.filter(t => !t.pnlEstimated && Number.isFinite(Number(t.pnl)));
  const estimated = closed.filter(t => t.pnlEstimated);
  const noPnl = closed.filter(t => !Number.isFinite(Number(t.pnl)));
  const openNow = demo.filter(t => t.status === 'OPEN');
  const dec = decisions.map(noTrade.normalizeDecision).filter(d => inP(d.timestamp));
  const intentsP = intents.filter(i => inP(i.createdAt));
  const outP = outcomes.filter(o => inP(o.producedAt));

  const wins = exact.filter(t => Number(t.pnl) > 0);
  const losses = exact.filter(t => Number(t.pnl) < 0);
  const sumExact = exact.reduce((s, t) => s + Number(t.pnl), 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + Number(t.pnl), 0) / wins.length : null;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + Number(t.pnl), 0) / losses.length : null;
  const grossWin = wins.reduce((s, t) => s + Number(t.pnl), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.pnl), 0));

  const regimeCounts = {};
  for (const d of dec) if (d.regime) regimeCounts[d.regime] = (regimeCounts[d.regime] || 0) + 1;
  const stateCounts = { TRADE: 0, WAIT: 0, NO_TRADE: 0 };
  const reasonCounts = {};
  for (const d of dec) {
    const code = d.reasonCode || (d.decision === 'EXECUTED' ? 'EXECUTED' : noTrade.reasonCode(d.skipReason, false));
    const state = d.state || noTrade.stateFor(d.decision, code); // older records: derived, same rules
    stateCounts[state] = (stateCounts[state] || 0) + 1;
    if (d.decision === 'SKIPPED') reasonCounts[code] = (reasonCounts[code] || 0) + 1;
  }
  const execCounts = {};
  for (const i of intentsP) execCounts[i.status] = (execCounts[i.status] || 0) + 1;
  const unresolved = (snapshot.unresolvedIntents || []).length;
  const hyp = { TARGET_HIT: 0, STOP_HIT: 0, EXPIRED: 0, AMBIGUOUS: 0, MISSING_DATA: 0, NOT_EVALUABLE: 0 };
  for (const o of outP) if (hyp[o.status] !== undefined) hyp[o.status]++;

  const missing = [
    'Broker account statement: not reconciled (no statement feed exists)',
    'Commission and swap per trade: not stored separately; realised P&L is the broker net figure only',
    'Benchmark: no benchmark defined',
    'Floating P&L on open positions: not marked to market in this report'
  ];
  if (!equity.some(p => inP(new Date(p.t).toISOString()))) missing.push('Equity samples in this period: none (drawdown not available)');
  if (noPnl.length) missing.push(`${noPnl.length} closed trade(s) without P&L, excluded from totals`);
  if (dec.some(d => d.legacy)) missing.push(`${dec.filter(d => d.legacy).length} decision(s) from before structured logging (state and reason inferred from text)`);

  const attention = [];
  if (unresolved) attention.push({ severity: 'critical', text: `${unresolved} order(s) not confirmed by the broker; new entries are paused until they are resolved` });
  if (execCounts.PROTECTION_FAILED) attention.push({ severity: 'critical', text: `${execCounts.PROTECTION_FAILED} position(s) could not be protected` });
  if (execCounts.UNKNOWN) attention.push({ severity: 'high', text: `${execCounts.UNKNOWN} order(s) had unknown outcome in this period` });
  if (execCounts.CLOSED_EMERGENCY) attention.push({ severity: 'high', text: `${execCounts.CLOSED_EMERGENCY} position(s) closed on the emergency policy` });
  if (dec.length && (reasonCounts.RISK_ADMISSION || 0) / dec.length > 0.5) attention.push({ severity: 'medium', text: `Risk admission refused more than half of decisions (${reasonCounts.RISK_ADMISSION} of ${dec.length}); review limits (owner decision)` });
  if (estimated.length) attention.push({ severity: 'low', text: `${estimated.length} closed trade(s) have estimated P&L (closed on cTrader outside AIS)` });
  if (snapshot.emergencyOn) attention.push({ severity: 'critical', text: 'Emergency stop is ON at generation time' });
  if (snapshot.fenceActive) attention.push({ severity: 'critical', text: 'Recovery review required: trading held until acknowledged' });
  if (snapshot.mlActive === false) attention.push({ severity: 'info', text: 'ML model is not active (validation not met); rules alone decide' });

  const report = {
    period,
    header: {
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      generatedAt: now.toISOString(),
      sources: ['broker-demo trade records (cTrader demo account)', 'decision log', 'order intent records', 'hypothetical NO-TRADE outcome records', 'balance samples', 'configuration and state snapshot at generation time'],
      label: 'Broker-demo results only. Hypothetical sections are labelled and excluded from results.'
    },
    missingData: missing,
    marketConditions: { regimeObservations: regimeCounts, decisionsByInstrument: countBy(dec, d => d.symbol) },
    opportunities: { decisions: dec.length, states: stateCounts, skipReasons: reasonCounts },
    trades: {
      closedInPeriod: closed.length,
      exactResults: exact.length,
      estimatedResults: estimated.length,
      openNow: openNow.length,
      executionsByStatus: execCounts,
      adopted: intentsP.filter(i => i.adopted).length
    },
    performance: {
      realisedPnlExact: round2(sumExact),
      realisedPnlEstimated: round2(estimated.reduce((s, t) => s + Number(t.pnl || 0), 0)),
      wins: wins.length, losses: losses.length,
      winRatePct: pct(wins.length, exact.length),
      avgWin: round2(avgWin), avgLoss: round2(avgLoss),
      expectancyPerTrade: exact.length ? round2(sumExact / exact.length) : null,
      profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
      maxDrawdownPct: maxDrawdownInPeriod(equity, start, end),
      sample: sampleFlag(exact.length),
      byInstrument: groupPnl(exact, t => t.symbol),
      byStrategy: groupPnl(exact, t => t.features && t.features.strategy),
      byRegime: groupPnl(exact, t => t.features && t.features.regime),
      timeframe: 'M1 entries; higher timeframes are used as confirmation only'
    },
    risk: {
      riskAdmissionRefusals: reasonCounts.RISK_ADMISSION || 0,
      otherRiskRefusals: [...CODES_RISK].filter(c => c !== 'RISK_ADMISSION').reduce((s, c) => s + (reasonCounts[c] || 0), 0),
      openPositionsNow: openNow.length,
      note: 'Emergency-stop history is not stored as events; only the current state is known.'
    },
    execution: {
      intentsInPeriod: intentsP.length,
      byStatus: execCounts,
      badOutcomes: Object.entries(execCounts).filter(([s]) => INTENT_BAD.has(s)).reduce((s, [, n]) => s + n, 0),
      unresolvedNow: unresolved
    },
    hypothetical: {
      label: 'HYPOTHETICAL — not executed, not profit or loss',
      outcomes: hyp,
      resolvedDecisive: hyp.TARGET_HIT + hyp.STOP_HIT,
      targetRatePct: pct(hyp.TARGET_HIT, hyp.TARGET_HIT + hyp.STOP_HIT),
      sample: sampleFlag(hyp.TARGET_HIT + hyp.STOP_HIT)
    },
    learning: { snapshot: { adaptiveTrades: snapshot.adaptiveTrades ?? null, consecutiveLosses: snapshot.consecutiveLosses ?? null, mlActive: snapshot.mlActive ?? null }, note: 'Snapshot at generation time, not a period measure.' },
    attention,
    recommendations: attention.map(a => recommend(a)).filter(Boolean)
  };

  if (period === 'monthly') report.weeklyBreakdown = weekly(exact, start, end);
  if (period === 'yearly') {
    report.monthlyBreakdown = monthly(exact, start, end);
    // Yearly benchmarks (decision 8): buy-and-hold per traded instrument, and flat/cash. Never estimated.
    report.benchmarks = benchmarks.build({ symbols: exact.map(t => t.symbol), startMs: start.getTime(), endMs: end.getTime(), barsBySymbol });
    if (report.benchmarks.unavailableCount) missing.push(`Benchmarks: ${report.benchmarks.unavailableCount} buy-and-hold benchmark(s) unavailable (price history does not cover the period); not estimated`);
  }
  return report;
}

function countBy(list, fn) {
  const g = {};
  for (const x of list) { const k = fn(x) || 'unknown'; g[k] = (g[k] || 0) + 1; }
  return g;
}

function recommend(a) {
  if (a.severity === 'critical' || a.severity === 'high') return `Investigate now: ${a.text}`;
  if (a.severity === 'medium') return `Owner decision: ${a.text}`;
  return null;
}

function weekly(exact, start, end) {
  const weeks = {};
  for (const t of exact) {
    const d = new Date(t.closeTime);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    const k = monday.toISOString().slice(0, 10);
    const w = (weeks[k] ||= { trades: 0, pnl: 0 });
    w.trades++; w.pnl += Number(t.pnl);
  }
  const rows = Object.entries(weeks).sort().map(([k, w]) => ({ weekStarting: k, trades: w.trades, realisedPnl: round2(w.pnl) }));
  return { weeks: rows, profitableWeeks: rows.filter(r => r.realisedPnl > 0).length, sample: sampleFlag(rows.length) };
}

function monthly(exact) {
  const months = {};
  for (const t of exact) {
    const k = t.closeTime.slice(0, 7);
    const m = (months[k] ||= { trades: 0, pnl: 0 });
    m.trades++; m.pnl += Number(t.pnl);
  }
  return Object.entries(months).sort().map(([k, m]) => ({ month: k, trades: m.trades, realisedPnl: round2(m.pnl) }));
}

// Markdown for the owner. Same content as the JSON; no numbers appear that are not in the JSON.
function toMarkdown(r) {
  const h = r.header;
  const lines = [];
  lines.push(`# ${r.period[0].toUpperCase() + r.period.slice(1)} owner report`);
  lines.push('');
  lines.push(`Period: ${h.periodStart} → ${h.periodEnd}  `);
  lines.push(`Generated: ${h.generatedAt}  `);
  lines.push(`Sources: ${h.sources.join('; ')}  `);
  lines.push(`_${h.label}_`);
  lines.push('');
  lines.push('## Attention');
  if (!r.attention.length) lines.push('Nothing flagged.');
  for (const a of r.attention) lines.push(`- **${a.severity.toUpperCase()}**: ${a.text}`);
  lines.push('');
  lines.push('## Performance (broker-demo, realised)');
  const p = r.performance;
  lines.push(`- Realised P&L (exact): ${p.realisedPnlExact} (${p.sample})`);
  lines.push(`- Realised P&L (estimated, shown separately): ${p.realisedPnlEstimated}`);
  lines.push(`- Trades: ${r.trades.closedInPeriod} closed, ${r.trades.openNow} open now`);
  lines.push(`- Win rate: ${p.winRatePct === null ? 'n/a' : p.winRatePct + '%'}; expectancy per trade: ${p.expectancyPerTrade ?? 'n/a'}; profit factor: ${p.profitFactor ?? 'n/a'}`);
  lines.push(`- Max drawdown in period: ${p.maxDrawdownPct === null ? 'not available' : p.maxDrawdownPct + '%'}`);
  lines.push('');
  lines.push('## Opportunities and decisions');
  lines.push(`- Decisions: ${r.opportunities.decisions}; states: ${JSON.stringify(r.opportunities.states)}`);
  lines.push(`- Skip reasons: ${JSON.stringify(r.opportunities.skipReasons)}`);
  lines.push('');
  lines.push('## Execution');
  lines.push(`- Intents: ${r.execution.intentsInPeriod}; by status: ${JSON.stringify(r.execution.byStatus)}; unresolved now: ${r.execution.unresolvedNow}`);
  lines.push('');
  lines.push('## Hypothetical NO-TRADE (not executed, not profit or loss)');
  lines.push(`- Outcomes: ${JSON.stringify(r.hypothetical.outcomes)}; target rate: ${r.hypothetical.targetRatePct ?? 'n/a'}% (${r.hypothetical.sample})`);
  lines.push('');
  if (r.benchmarks) {
    lines.push('## Yearly benchmarks');
    lines.push(`- Definition: ${r.benchmarks.definition}`);
    lines.push(`- Flat/cash: ${r.benchmarks.flatCash.returnPct}% (label: flat/cash baseline)`);
    for (const b of r.benchmarks.buyAndHold) lines.push(b.status === 'OK' ? `- Buy-and-hold ${b.symbol}: ${b.returnPct}% (${b.from} to ${b.to})` : `- Buy-and-hold ${b.symbol}: benchmark unavailable (${b.reason})`);
    lines.push('');
  }
  lines.push('## Missing or incomplete data');
  for (const m of r.missingData) lines.push(`- ${m}`);
  lines.push('');
  lines.push('## Recommendations');
  if (!r.recommendations.length) lines.push('None beyond normal monitoring.');
  for (const x of r.recommendations) lines.push(`- ${x}`);
  return lines.join('\n') + '\n';
}

module.exports = { build, toMarkdown, periodStart, maxDrawdownInPeriod, MIN_SAMPLE };
