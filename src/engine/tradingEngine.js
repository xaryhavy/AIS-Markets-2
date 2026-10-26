const signalEngine = require('../intelligence/signalEngine');
const riskManager = require('../risk/riskManager');
const orderManager = require('../execution/orderManager');
const trading = require('../ctrader/trading');
const governance = require('../governance');
const shadowTracker = require('../governance/shadowTracker');
const marketData = require('../data/marketdata');
const adaptiveLearner = require('../intelligence/adaptiveLearner');
const indicators = require('../intelligence/indicators');
const patternMiner = require('../intelligence/patternMiner');
const timeframes = require('../intelligence/timeframes');
const mlModel = require('../intelligence/mlModel');
const noTrade = require('../governance/noTrade');
const mode = require('../governance/mode');
const alerts = require('../ops/alerts');
const audit = require('../audit/audit');
const guardrails = require('../governance/guardrails');
const storage = require('../data/storage');
const safety = require('../execution/safety');
const dataQuality = require('../data/quality');
const entryPause = require('./entryPause');
const shutdownRecords = require('../governance/shutdown');

let engineInterval = null;
let monitorInterval = null;
let lastRec = { adopted: [], emergencyClosed: [], unmanaged: [], unresolved: [], reconcileFailed: false };
let lastReconcileOk = null;
let lastCycleAt = null;
let stats = { cycles: 0, tradesExecuted: 0, signalsScanned: 0, lastRun: null, regimes: {}, lastBlockReason: null };
const limitsCfg = require('../risk/limits');
const orderCooldown = {}; // symbol -> timestamp until which new orders are paused

// What the situation looked like when the trade was opened. The model and the pattern miner learn from these.
function buildFeatures(signal, trends) {
  const now = new Date();
  return {
    regime: signal.regime,
    hourUtc: now.getUTCHours(),
    dayOfWeek: now.getUTCDay(),
    strategy: signal.dominantStrategy || null,
    patterns: (signal.detectedPatterns || []).map(p => p.pattern),
    mtf: trends
  };
}

// Consecutive failed cycles before the owner is alerted. Each failure is logged; the alert is what makes it visible.
const CYCLE_FAILURE_ALERT = 3;
let consecutiveCycleFailures = 0;

// Pure. The alert condition for a run of failed cycles, or null.
function cycleFailureCondition(n) {
  return n >= CYCLE_FAILURE_ALERT ? { code: 'CYCLE_FAILING', severity: 'high', message: `${n} consecutive engine cycles failed; new entries are not guaranteed to be safe` } : null;
}

// Alerts reflect the current conditions every cycle, including cycles where trading is paused.
async function syncOps() {
  const conditions = [];
  const failing = cycleFailureCondition(consecutiveCycleFailures);
  if (failing) conditions.push(failing);
  if (entryPause.status().active) conditions.push({ code: 'ENTRIES_PAUSED', severity: 'high', message: entryPause.status().reason });
  const ownerShutdown = await shutdownRecords.current();
  if (ownerShutdown) conditions.push({ code: 'OWNER_SHUTDOWN', severity: 'critical', message: `owner shutdown active since ${ownerShutdown.requestedAt}: ${ownerShutdown.reason}` });
  if (lastRec.unresolved.length) conditions.push({ code: 'UNRESOLVED_ORDER', severity: 'critical', message: `${lastRec.unresolved.length} order outcome(s) not confirmed by the broker` });
  if (lastRec.unmanaged.length) conditions.push({ code: 'UNMANAGED_POSITION', severity: 'critical', message: `${lastRec.unmanaged.length} broker position(s) with no local record` });
  if (lastRec.reconcileFailed) conditions.push({ code: 'RECONCILE_FAILED', severity: 'high', message: 'broker reconciliation failed in the last cycle' });
  const em = await limitsCfg.emergencyState();
  if (em.on) conditions.push({ code: 'EMERGENCY_STOP', severity: 'high', message: `emergency stop on${em.reason ? ': ' + em.reason : ''}` });
  if (guardrails.fenceStatus().fenceActive) conditions.push({ code: 'RECOVERY_REVIEW', severity: 'critical', message: 'trading held until the recovery review is acknowledged' });
  if (!mode.allowsBrokerOrders()) conditions.push({ code: 'NO_BROKER_ORDERS', severity: 'info', message: `mode ${mode.current()} places no broker orders` });
  if (!trading.isReady()) conditions.push({ code: 'BROKER_OR_FEED_DOWN', severity: 'high', message: 'broker connection or live feed not ready' });
  await alerts.sync(conditions);
}

async function runCycle() {
  stats.cycles++;
  lastCycleAt = Date.now();
  await syncOps();
  stats.lastRun = new Date().toISOString();

  // 1. Live prices come from the cTrader feed; without it there is nothing safe to trade on
  if (!trading.isReady()) {
    stats.lastBlockReason = 'cTrader not connected — trading paused';
    return;
  }

  // 2a. Confirm orders whose outcome was unknown, and find broker positions AIS does not track.
  const tracked = new Set((await storage.load('trades'))
    .filter(t => t.status === 'OPEN' && t.positionId !== undefined)
    .map(t => Number(t.positionId)));
  let rec;
  try {
    rec = await trading.reconcile(tracked);
    lastReconcileOk = true;
  } catch (e) {
    // If the broker cannot be reconciled, nothing new may be opened. Exits still run below.
    console.log(`[ENGINE] Reconciliation failed, entries paused: ${e.message}`);
    rec = { adopted: [], emergencyClosed: [], unmanaged: [], unresolved: [{ reason: 'reconciliation failed' }], reconcileFailed: true };
    lastReconcileOk = false;
  }
  for (const a of rec.adopted) {
    await orderManager.recordAdopted(a.intent, a.position);
    console.log(`[ENGINE] Adopted position ${a.position.positionId} from unconfirmed order ${a.intent.id}`);
  }
  lastRec = rec;
  for (const i of rec.emergencyClosed) console.log(`[ENGINE] Emergency close for ${i.symbol} (${i.id}) — position could not be protected`);
  if (rec.unmanaged.length) console.log(`[ENGINE] ${rec.unmanaged.length} broker position(s) have no local record — entries paused`);

  // 2. Reconcile with the broker and manage exits. This runs even when new trades are paused,
  //    so open positions are always closed on their stop/take-profit levels.
  const synced = await orderManager.syncWithBroker();
  const closed = [...synced, ...(await orderManager.checkAndClosePositions())];
  for (const trade of closed) {
    const strategyName = trade.features?.strategy || 'unknown';
    const regime = trade.features?.regime || 'UNKNOWN';
    await adaptiveLearner.updateOnTrade(trade, strategyName, regime);
    console.log(`[ENGINE] Closed ${trade.symbol} ${trade.action} — PnL: ${trade.pnl} (${trade.closeReason})`);
  }
  if (closed.length) await mlModel.maybeRetrain();

  // 2b. Entries paused after repeated cycle failures: exits above already ran; nothing new is opened until an owner resumes
  if (entryPause.status().active) { stats.lastBlockReason = entryPause.status().reason; return; }

  // 3. Owner switch, recovery fence and loss caps stop new trades only
  const govCheck = await governance.allowTrade('demo');
  if (!govCheck.allow) { stats.lastBlockReason = govCheck.reason; return; }
  stats.lastBlockReason = null;

  // 4. Scan all symbols with the adaptive ensemble
  // Data integrity is assessed before analysis; a symbol with bad or stale data is not analysed or traded.
  const assessments = Object.fromEntries(marketData.getSymbols().map(s => [s, dataQuality.assess(s)]));
  const signals = await signalEngine.scanAll();
  stats.signalsScanned += signals.length;
  for (const s of signals) { stats.regimes[s.symbol] = s.regime; }
  for (const s of signals) {
    s.trends = timeframes.analyzeLive(s.symbol);
    s.features = buildFeatures(s, s.trends);
  }

  // Signals matching an owner-approved pattern are considered first; nothing else changes.
  signals.sort((a, b) =>
    patternMiner.approvalScore(b.features, b.symbol, b.action) - patternMiner.approvalScore(a.features, a.symbol, a.action));

  // 5. Circuit breaker position multiplier
  const posMultiplier = await adaptiveLearner.getPositionMultiplier();

  for (const signal of signals) {
    if (!signal.qualified) {
      await shadowTracker.recordDecision(signal, { decision: 'SKIPPED' });
      continue;
    }
    // Freeze the levels this signal would have used, before any gate can reject it (NO-TRADE monitor input).
    const price0 = marketData.getPrice(signal.symbol);
    if (price0 !== undefined) {
      const atr0 = indicators.atr(dataQuality.completedBars(signal.symbol, 'M1', 60), 14);
      const stops0 = riskManager.calculateStops(signal.symbol, price0, signal.action, atr0);
      signal.levels = noTrade.frozenLevels(signal, price0, stops0.stopLoss, stops0.takeProfit);
    }
    // Operating mode: decisions are still recorded, but no broker order is placed outside the order-placing modes.
    if (!mode.allowsBrokerOrders()) {
      await shadowTracker.recordDecision(signal, { decision: 'SKIPPED', reason: `Operating mode ${mode.current()}: no broker orders` });
      continue;
    }
    const assessment = assessments[signal.symbol];
    if (!assessment || !assessment.ok) {
      await shadowTracker.recordDecision(signal, { decision: 'SKIPPED', reason: `Data quality: ${assessment ? assessment.reasons.join('; ') : 'not assessed'}` });
      continue;
    }
    signal.dataFingerprint = assessment.frames.M1.fingerprint;
    // Higher timeframes (H1, M15) must not oppose the trade and at least one must confirm it.
    if (!timeframes.allows(signal.trends, signal.action)) {
      await shadowTracker.recordDecision(signal, { decision: 'SKIPPED', reason: `Higher timeframes do not confirm ${signal.action} (H1 ${signal.trends.H1}, M15 ${signal.trends.M15})` });
      continue;
    }
    const blockers = safety.entryBlockers({
      feedReady: trading.isReady(),
      quoteAgeMs: marketData.quoteAgeMs(signal.symbol),
      unresolvedIntents: rec.unresolved,
      unmanagedPositions: rec.unmanaged
    });
    if (blockers.length) {
      await shadowTracker.recordDecision(signal, { decision: 'SKIPPED', reason: `Entries paused: ${blockers.join('; ')}` });
      stats.lastBlockReason = blockers.join('; ');
      continue;
    }
    if ((orderCooldown[signal.symbol] || 0) > Date.now()) {
      await shadowTracker.recordDecision(signal, { decision: 'SKIPPED', reason: 'Cooling down after a failed order' });
      continue;
    }
    const price = marketData.getPrice(signal.symbol);
    if (price === undefined) continue;
    const atr = indicators.atr(dataQuality.completedBars(signal.symbol, 'M1', 60), 14);
    const stops = riskManager.calculateStops(signal.symbol, price, signal.action, atr);
    const rr = riskManager.riskReward(stops, price);
    if (rr < limitsCfg.value("minRewardRisk") - 0.05) {
      await shadowTracker.recordDecision(signal, { decision: 'SKIPPED', reason: `Reward to risk ${rr.toFixed(2)} below 1:${limitsCfg.value("minRewardRisk")}` });
      continue;
    }
    // Learned win probability; only applies once the model has been validated on held-back trades.
    const p = mlModel.probability({ symbol: signal.symbol, action: signal.action, features: signal.features });
    if (p !== null) {
      signal.features.mlProbability = Math.round(p * 1000) / 1000;
      if (p < mlModel.MIN_PROBABILITY) {
        await shadowTracker.recordDecision(signal, { decision: 'SKIPPED', reason: `Model win probability ${(p * 100).toFixed(0)}% below ${mlModel.MIN_PROBABILITY * 100}%` });
        continue;
      }
    }
    let size = await riskManager.calculatePositionSize(signal.symbol, price, stops.stopLoss);
    size = Math.round(size * posMultiplier * 100) / 100;
    if (size <= 0) {
      await shadowTracker.recordDecision(signal, { decision: 'SKIPPED', reason: 'Zero position size' });
      continue;
    }
    const riskCheck = await riskManager.checkRisk(signal.symbol, size, price);
    if (!riskCheck.allow) {
      await shadowTracker.recordDecision(signal, { decision: 'SKIPPED', reason: riskCheck.reason });
      continue;
    }
    // Admission: the analysis must still be current and must be built on the same candles it was made from.
    const now = dataQuality.assess(signal.symbol);
    if (!now.ok || now.frames.M1.fingerprint !== signal.dataFingerprint || dataQuality.isExpired(assessment)) {
      await shadowTracker.recordDecision(signal, { decision: 'SKIPPED', reason: 'Data changed or analysis expired before dispatch — re-evaluated next cycle' });
      continue;
    }
    let trade;
    try {
      trade = await orderManager.openPosition(signal, size, stops);
    } catch (e) {
      // Do not retry this symbol every cycle; wait before the next attempt.
      orderCooldown[signal.symbol] = Date.now() + (limitsCfg.value('orderCooldownMinutes') * 60000);
      await shadowTracker.recordDecision(signal, { decision: 'SKIPPED', reason: e.message });
      console.log(`[ENGINE] ${signal.symbol} order not placed: ${e.message}`);
      continue;
    }
    stats.tradesExecuted++;
    await shadowTracker.recordDecision(signal, { decision: 'EXECUTED' });
    console.log(`[ENGINE] ${signal.action} ${trade.size} ${signal.symbol} @ ${trade.entryPrice} [${signal.regime}] R:R 1:${rr.toFixed(1)} — ${signal.reason}${posMultiplier < 1 ? ' (circuit breaker: 50% size)' : ''}`);
  }

}

function start(intervalMs = 5000) {
  if (engineInterval) return;
  console.log('[ENGINE] Adaptive trading engine started — cycle every ' + intervalMs / 1000 + 's');
  const safeCycle = () => runCycle()
    .then(() => { consecutiveCycleFailures = 0; })
    .catch(e => {
      consecutiveCycleFailures++;
      console.log(`[ENGINE] cycle error: ${e.message}`);
      // Repeated failures pause NEW entries only (owner decision 4). Exits and monitoring keep running.
      entryPause.tripOnFailures(consecutiveCycleFailures).catch(() => {});
      // The cycle may have failed before its own alert sync, so sync again from here.
      syncOps().catch(() => {});
    });
  safeCycle();
  engineInterval = setInterval(safeCycle, intervalMs);
  // NO-TRADE outcomes resolve on their own clock, so they keep resolving while trading is paused.
  const safeMonitor = () => noTrade.runMonitor().catch(e => console.log(`[ENGINE] no-trade monitor error: ${e.message}`));
  monitorInterval = setInterval(safeMonitor, 60000);
}
function stop() {
  if (engineInterval) { clearInterval(engineInterval); engineInterval = null; }
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
}
function getStats() { return { ...stats, lastReconcileOk, lastCycleAt }; }
function engineAgeMs() { return lastCycleAt === null ? null : Date.now() - lastCycleAt; }
function reconcileStatus() { return { lastReconcileOk, unresolved: lastRec.unresolved.length, unmanaged: lastRec.unmanaged.length }; }

module.exports = {
  cycleFailureCondition, CYCLE_FAILURE_ALERT, start, stop, getStats, runCycle, buildFeatures, engineAgeMs, reconcileStatus };
