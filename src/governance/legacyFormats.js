// Decision record formats (item 6). READ-ONLY: this module classifies and inventories; it never writes.
// Owner decision: no legacy format is approved. Legacy-format decisions are not compacted, archived or modified.
//   CURRENT                   decision is a string, state and reasonCode are present
//   LEGACY_OBJECT_DECISION    decision holds the whole {decision, reason} object (before structured logging)
//   LEGACY_NO_STATE           decision is a string but state is missing
//   LEGACY_NO_REASON_CODE     decision and state are present but reasonCode is missing
//   OTHER                     anything else (flagged, never guessed)

// Pure.
function classify(d) {
  if (!d || typeof d !== 'object') return 'OTHER';
  if (d.decision !== null && typeof d.decision === 'object') return 'LEGACY_OBJECT_DECISION';
  if (typeof d.decision !== 'string') return 'OTHER';
  if (typeof d.state !== 'string') return 'LEGACY_NO_STATE';
  if (typeof d.reasonCode !== 'string') return 'LEGACY_NO_REASON_CODE';
  return 'CURRENT';
}

// Pure. Read-only inventory: counts by format, date range, and links to outcomes and executed trades.
function inventory(decisions, outcomes) {
  const linked = new Set();
  for (const o of outcomes) { if (o.decisionId) linked.add(o.decisionId); if (o.collapsedInto) linked.add(o.collapsedInto); }
  const byFormat = {};
  for (const d of decisions) {
    const f = classify(d);
    const g = (byFormat[f] ||= { count: 0, first: null, last: null, linkedToOutcomes: 0, linkedToExecutedTrades: 0, symbols: {} });
    g.count++;
    const ts = d.timestamp || null;
    if (ts && (!g.first || ts < g.first)) g.first = ts;
    if (ts && (!g.last || ts > g.last)) g.last = ts;
    if (linked.has(d.id)) g.linkedToOutcomes++;
    if (d.decision === 'EXECUTED') g.linkedToExecutedTrades++;
    g.symbols[d.symbol || 'none'] = (g.symbols[d.symbol || 'none'] || 0) + 1;
  }
  return { total: decisions.length, byFormat };
}

module.exports = { classify, inventory };
