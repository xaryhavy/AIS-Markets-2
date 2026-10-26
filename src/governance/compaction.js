// Decision-log compaction (decision 6). WAIT and NOT_QUALIFIED records older than the retention window are rolled up
// into daily aggregates by reason code, instrument, strategy and timeframe. The full records are moved to a retained
// archive, not deleted, so a run can be reversed. Nothing is compacted without an explicit apply.
// Never compacted: any record a NO-TRADE outcome depends on, any EXECUTED or rule decision (NO_TRADE/TRADE), any record
// inside an incident (data-gate block episode for the same instrument), and any record for an instrument with an open position.
const crypto = require('crypto');
const storage = require('../data/storage');
const audit = require('../audit/audit');

const DECISIONS = 'decisions';
const ARCHIVE = 'decisions_compacted';
const ROLLUPS = 'decision_rollups';
const RUNS = 'decision_compaction_runs';
const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION = 1;
const MAX_RETENTION = 365;
const COMPACTABLE_STATE = 'WAIT';
const COMPACTABLE_CODES = new Set(['NOT_QUALIFIED', 'DATA_QUALITY', 'ENTRY_BLOCKED', 'COOLDOWN', 'STALE_ANALYSIS']);

function validRetention(n) {
  if (!Number.isInteger(n) || n < MIN_RETENTION || n > MAX_RETENTION) throw new Error(`retention must be a whole number of days from ${MIN_RETENTION} to ${MAX_RETENTION}`);
  return n;
}

const dayOf = iso => String(iso).slice(0, 10);

// Pure. The set of decision ids that must never be compacted, with the reason for each.
function protectedIds({ decisions, outcomes, trades, gateBlocks }) {
  const why = new Map();
  const add = (id, reason) => { if (id && !why.has(id)) why.set(id, reason); };
  for (const o of outcomes) { add(o.decisionId, 'NO-TRADE outcome'); add(o.collapsedInto, 'NO-TRADE outcome (kept repeat)'); }
  const openSymbols = new Map();
  for (const t of trades) if (t.status === 'OPEN') openSymbols.set(t.symbol, t.openTime || '0');
  for (const d of decisions) {
    if (d.decision === 'EXECUTED') add(d.id, 'trade');
    if (d.state && d.state !== COMPACTABLE_STATE) add(d.id, `state ${d.state}`);
    if (openSymbols.has(d.symbol) && d.timestamp >= openSymbols.get(d.symbol)) add(d.id, 'open position');
    for (const g of gateBlocks) {
      if (g.symbol !== d.symbol) continue;
      const end = g.endedAt || '9999';
      if (d.timestamp >= g.startedAt && d.timestamp <= end) { add(d.id, 'incident (data-gate block)'); break; }
    }
  }
  return why;
}

// Dry run. Changes nothing. Returns exactly what an apply would do.
async function plan({ retentionDays = DEFAULT_RETENTION_DAYS, now = new Date() } = {}) {
  const retention = validRetention(retentionDays);
  const cutoff = new Date(now.getTime() - retention * 86400000).toISOString();
  const [decisions, outcomes, trades, gateBlocks] = await Promise.all([
    storage.load(DECISIONS), storage.load('no_trade_outcomes'), storage.load('trades'), storage.load('data_gate_blocks')
  ]);
  const protectedMap = protectedIds({ decisions, outcomes, trades, gateBlocks });
  const candidates = decisions.filter(d => d.decision === 'SKIPPED' && d.state === COMPACTABLE_STATE && COMPACTABLE_CODES.has(d.reasonCode) && d.timestamp < cutoff);
  const toCompact = candidates.filter(d => !protectedMap.has(d.id));
  const skippedProtected = candidates.filter(d => protectedMap.has(d.id));
  const groups = {};
  for (const d of toCompact) {
    const key = [dayOf(d.timestamp), d.reasonCode, d.symbol, d.strategy || 'none', d.timeframe || 'M1'].join('|');
    groups[key] = (groups[key] || 0) + 1;
  }
  const byReason = {};
  for (const d of toCompact) byReason[d.reasonCode] = (byReason[d.reasonCode] || 0) + 1;
  const protectedByReason = {};
  for (const d of skippedProtected) { const r = protectedMap.get(d.id); protectedByReason[r] = (protectedByReason[r] || 0) + 1; }
  return {
    dryRun: true,
    retentionDays: retention,
    cutoff,
    decisionsTotal: decisions.length,
    compactable: toCompact.length,
    compactableByReason: byReason,
    protectedInWindow: skippedProtected.length,
    protectedByReason,
    rollupGroups: Object.keys(groups).length,
    sampleRollups: Object.entries(groups).slice(0, 5).map(([key, count]) => ({ key, count })),
    estimatedRecordsRemovedFromHotLog: toCompact.length,
    reversibleUntilIfApplied: new Date(now.getTime() + retention * 86400000).toISOString()
  };
}

// Applies a compaction: archives the full records, writes daily rollups, removes the records from the hot log.
// Idempotent: a second apply compacts only records that are still eligible (none, right after a run).
async function apply({ retentionDays = DEFAULT_RETENTION_DAYS, now = new Date(), actor = 'owner' } = {}) {
  const retention = validRetention(retentionDays);
  const cutoff = new Date(now.getTime() - retention * 86400000).toISOString();
  const runId = 'DCR-' + now.getTime() + '-' + crypto.randomBytes(3).toString('hex');
  const compactedIds = [];
  const rollups = {};
  await storage.mutate(DECISIONS, async decisions => {
    const [outcomes, trades, gateBlocks] = await Promise.all([storage.load('no_trade_outcomes'), storage.load('trades'), storage.load('data_gate_blocks')]);
    const protectedMap = protectedIds({ decisions, outcomes, trades, gateBlocks });
    const keep = [];
    for (const d of decisions) {
      const eligible = d.decision === 'SKIPPED' && d.state === COMPACTABLE_STATE && COMPACTABLE_CODES.has(d.reasonCode) && d.timestamp < cutoff && !protectedMap.has(d.id);
      if (!eligible) { keep.push(d); continue; }
      compactedIds.push(d.id);
      const key = [dayOf(d.timestamp), d.reasonCode, d.symbol, d.strategy || 'none', d.timeframe || 'M1'].join('|');
      const r = (rollups[key] ||= { day: dayOf(d.timestamp), reasonCode: d.reasonCode, symbol: d.symbol, strategy: d.strategy || 'none', timeframe: d.timeframe || 'M1', count: 0, firstAt: d.timestamp, lastAt: d.timestamp });
      r.count++;
      if (d.timestamp < r.firstAt) r.firstAt = d.timestamp;
      if (d.timestamp > r.lastAt) r.lastAt = d.timestamp;
    }
    if (!compactedIds.length) return undefined;
    // Full records go to the archive first; only then are they removed from the hot log.
    // A record already archived by an earlier, interrupted run is not archived twice.
    const archivedIds = new Set((await storage.load(ARCHIVE)).map(d => d.id));
    const removed = decisions.filter(d => compactedIds.includes(d.id));
    for (const d of removed) if (!archivedIds.has(d.id)) await storage.append(ARCHIVE, { ...d, runId, compactedAt: now.toISOString() });
    return keep;
  });
  if (compactedIds.length) {
    for (const r of Object.values(rollups)) await storage.append(ROLLUPS, { ...r, runId });
  }
  // The reversal window is the retention period counted from the apply: after it, the archive copies may be purged.
  const reversibleUntil = new Date(now.getTime() + retention * 86400000).toISOString();
  await storage.append(RUNS, { runId, appliedAt: now.toISOString(), actor, retentionDays: retention, cutoff, reversibleUntil, compacted: compactedIds.length, ids: compactedIds, reversed: false });
  audit.record('DECISION_LOG_COMPACTED', { runId, actor, compacted: compactedIds.length, cutoff });
  return { runId, compacted: compactedIds.length };
}

// Reverses one run: restores its records to the hot log. Refused after the run's retention cutoff.
async function reverse(runId, { actor = 'owner', now = new Date() } = {}) {
  const runs = await storage.load(RUNS);
  const run = runs.find(r => r.runId === runId);
  if (!run) throw new Error('unknown compaction run');
  if (run.reversed) throw new Error('this run was already reversed');
  if (now.toISOString() > run.reversibleUntil) throw new Error('the reversal window for this run has closed (past its retention cutoff)');
  const archived = (await storage.load(ARCHIVE)).filter(d => d.runId === runId);
  const ids = new Set(run.ids);
  await storage.mutate(DECISIONS, rows => {
    const present = new Set(rows.map(r => r.id));
    const back = archived.filter(d => ids.has(d.id) && !present.has(d.id)).map(({ runId: _r, compactedAt: _c, ...d }) => d);
    return back.length ? [...rows, ...back] : undefined;
  });
  // Runs are keyed by runId (storage.update matches on id), so the flag is written with a locked read-modify-write.
  await storage.mutate(RUNS, rows => rows.map(r => (r.runId === runId ? { ...r, reversed: true, reversedAt: now.toISOString(), reversedBy: actor } : r)));
  audit.record('DECISION_LOG_COMPACTION_REVERSED', { runId, actor, restored: archived.length });
  return { runId, restored: archived.length };
}

module.exports = { plan, apply, reverse, protectedIds, validRetention, DEFAULT_RETENTION_DAYS, COMPACTABLE_CODES, DECISIONS, ARCHIVE, ROLLUPS, RUNS };
