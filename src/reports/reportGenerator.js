const fs = require('fs-extra');
const path = require('path');
const storage = require('../data/storage');
const noTrade = require('../governance/noTrade');
const { CLASSES, classifyTrade } = require('../analytics/evidence');
const marketData = require('../data/marketdata');
const ownerReport = require('./ownerReport');
const adaptiveLearner = require('../intelligence/adaptiveLearner');
const mlModel = require('../intelligence/mlModel');
const limits = require('../risk/limits');
const guardrails = require('../governance/guardrails');
const REPORTS_DIR = path.join(__dirname, '../../data/reports');

// Broker demo closes with no AIS trade record (made by the fault-injection harness before trade recording
// was added on 2026-10-26). They are disclosed in any report period that contains them, and are never added to the totals.
const UNRECORDED_BROKER_CLOSES = [
  { positionId: 252276705, pnl: 0.08, closedAt: '2026-10-25T23:27:31Z', note: 'fault-injection test: lost order reply' },
  { positionId: 252276925, pnl: 0.07, closedAt: '2026-10-25T23:29:03Z', note: 'fault-injection test: disconnect mid-order' },
  { positionId: 252277165, pnl: 0.07, closedAt: '2026-10-25T23:30:15Z', note: 'fault-injection test: restart during submission' }
];

// Start of the report period containing `now`, UTC. Yearly and monthly are calendar periods.
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

// Pure report builder. Only broker-demo trades (source 'ctrader') count as results. Simulated and
// hypothetical records are reported separately and never mixed into performance.
function buildReport(period, { trades = [], decisions: rawDecisions = [], outcomes = [] }, now = new Date()) {
  const decisions = rawDecisions.map(noTrade.normalizeDecision);
  const start = periodStart(period, now);
  const inPeriod = t => {
    const when = t.closeTime ? new Date(t.closeTime) : null;
    return when && when >= start && when <= now;
  };
  const demo = trades.filter(t => t.source === 'ctrader');
  const closed = demo.filter(t => t.status === 'CLOSED' && inPeriod(t));
  const open = demo.filter(t => t.status === 'OPEN');
  const estimated = closed.filter(t => t.pnlEstimated);
  const exact = closed.filter(t => !t.pnlEstimated && Number.isFinite(Number(t.pnl)));
  const missingPnl = closed.filter(t => !Number.isFinite(Number(t.pnl)));
  const sumPnl = list => Math.round(list.reduce((s, t) => s + Number(t.pnl || 0), 0) * 100) / 100;
  const wins = exact.filter(t => Number(t.pnl) > 0).length;
  const losses = exact.filter(t => Number(t.pnl) < 0).length;
  const periodDecisions = decisions.filter(d => new Date(d.timestamp) >= start && new Date(d.timestamp) <= now);
  // Deliberate broker test trades are real demo executions; they stay in the figures above and are disclosed here.
  const faultTests = closed.filter(t => classifyTrade(t) === CLASSES.FAULT_TEST);
  const unrecorded = UNRECORDED_BROKER_CLOSES.filter(c => new Date(c.closedAt) >= start && new Date(c.closedAt) <= now);
  const unrecordedPnl = Math.round(unrecorded.reduce((s, c) => s + c.pnl, 0) * 100) / 100;
  const simulated = trades.filter(t => t.source !== 'ctrader');
  // Hypothetical NO-TRADE results: reported separately, never counted as executions, profit or loss.
  const periodOutcomes = outcomes.filter(o => o.producedAt && new Date(o.producedAt) >= start && new Date(o.producedAt) <= now);
  const count = s => periodOutcomes.filter(o => o.status === s).length;
  const hypothetical = {
    label: 'HYPOTHETICAL — not executed, not profit or loss',
    outcomesRecorded: periodOutcomes.length,
    targetHit: count('TARGET_HIT'), stopHit: count('STOP_HIT'), expired: count('EXPIRED'),
    ambiguous: count('AMBIGUOUS'), missingData: count('MISSING_DATA'), notEvaluable: count('NOT_EVALUABLE'), invalidated: count('INVALIDATED'),
    byReasonCode: noTrade.summarise(periodOutcomes.filter(o => o.reasonCode), 'reasonCode')
  };

  return {
    period,
    periodStart: start.toISOString(),
    periodEnd: now.toISOString(),
    generatedAt: now.toISOString(),
    dataSources: ['broker-demo trade records (cTrader demo account)', 'decision log'],
    summary: {
      closedDemoTrades: closed.length,
      openDemoTrades: open.length,
      wins, losses,
      winRatePct: exact.length ? Math.round(wins / exact.length * 1000) / 10 : null,
      realisedPnlExact: sumPnl(exact),
      realisedPnlEstimated: sumPnl(estimated),
      openTradesFloatingPnl: 'not computed (no mark-to-market in this report)',
      decisionsInPeriod: periodDecisions.length,
      executedInPeriod: periodDecisions.filter(d => d.decision === 'EXECUTED').length,
      skippedInPeriod: periodDecisions.filter(d => d.decision === 'SKIPPED').length,
      unrecordedBrokerCloses: { count: unrecorded.length, pnlExcludedFromTotals: unrecordedPnl }
    },
    hypothetical,
    dataNotes: [
      estimated.length ? `${estimated.length} closed trade(s) have estimated P&L (closed on cTrader outside AIS)` : null,
      missingPnl.length ? `${missingPnl.length} closed trade(s) have no P&L and are excluded from totals` : null,
      simulated.length ? `${simulated.length} simulated/legacy record(s) excluded from performance` : null,
      faultTests.length ? `${faultTests.length} closed trade(s) in this period are deliberate broker fault-injection tests (real demo executions, reported P&L ${sumPnl(faultTests)} included above)` : null,
      unrecorded.length ?`${unrecorded.length} broker demo close(s) in this period have no AIS trade record (${unrecorded.map(c => c.note).join('; ')}); reported P&L ${unrecordedPnl} is excluded from all totals above` : null,
      'Open positions are not marked to market; floating P&L is not included',
      'Costs beyond the broker-reported commission and swap are not modelled'
    ].filter(Boolean),
    trades: closed.slice(-50).map(t => ({ id: t.id, symbol: t.symbol, action: t.action, closeTime: t.closeTime, pnl: t.pnl, pnlEstimated: !!t.pnlEstimated }))
  };
}

// Hourly broker bars for the yearly benchmarks. Empty when the broker is not authenticated: then every buy-and-hold is unavailable.
async function yearlyBars(now) {
  const cm = require('../ctrader/connectionManager');
  if (cm.getStatus().state !== 'ACCOUNT_AUTHENTICATED') return {};
  const auth = require('../ctrader/auth');
  const hours = (now.getTime() - periodStart('yearly', now).getTime()) / 3600000;
  return require('../analytics/benchmarkBars').loadForSymbols({ client: cm.getClient(), accountId: Number(auth.getConfig().accountId), symbols: marketData.getSymbols(), hours, now: now.getTime() });
}

// Owner report: JSON (machine-checkable) and Markdown (for the owner), from the same build.
async function generateReport(period, now = new Date()) {
  await fs.ensureDir(REPORTS_DIR);
  const unresolvedStatuses = new Set(['SUBMITTING', 'UNKNOWN', 'PROTECTION_FAILED']);
  const intents = await storage.load('order_intents');
  const adaptive = await adaptiveLearner.getStats();
  const emergency = await limits.emergencyState();
  // Benchmark history (decision 8): yearly reports load hourly completed bars from the broker; other periods need none.
  const barsBySymbol = period === 'yearly' ? await yearlyBars(now) : {};
  const report = ownerReport.build({
    period,
    now,
    barsBySymbol,
    trades: await storage.load('trades'),
    decisions: await storage.load('decisions'),
    outcomes: await storage.load('no_trade_outcomes'),
    intents,
    equity: await fs.readJson(limits.EQUITY_FILE).catch(() => []),
    snapshot: {
      unresolvedIntents: intents.filter(i => unresolvedStatuses.has(i.status)),
      emergencyOn: !!emergency.on,
      fenceActive: guardrails.fenceStatus().fenceActive,
      adaptiveTrades: adaptive.totalTrades,
      consecutiveLosses: adaptive.consecutiveLosses,
      mlActive: mlModel.status().active
    }
  });
  const stamp = `${period}-${now.toISOString().slice(0, 10)}`;
  await fs.writeJson(path.join(REPORTS_DIR, `${stamp}.json`), report, { spaces: 2 });
  await fs.writeFile(path.join(REPORTS_DIR, `${stamp}.md`), ownerReport.toMarkdown(report));
  return report;
}

async function generateAll() {
  return {
    daily: await generateReport('daily'),
    weekly: await generateReport('weekly'),
    monthly: await generateReport('monthly'),
    yearly: await generateReport('yearly')
  };
}

module.exports = { generateReport, generateAll, buildReport, periodStart, UNRECORDED_BROKER_CLOSES };
