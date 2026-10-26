// Decision record formats (item 6). Legacy-format decisions are never compacted. They are tagged legacy/unverified
// (non-destructive, reversible) and left untouched otherwise.
//   CURRENT                   decision is a string, state and reasonCode are present
//   LEGACY_OBJECT_DECISION    decision holds the whole {decision, reason} object (before structured logging)
//   LEGACY_NO_STATE           decision is a string but state is missing
//   LEGACY_NO_REASON_CODE     decision and state are present but reasonCode is missing
//   OTHER                     anything else (flagged, never guessed)
const storage = require('../data/storage');
const audit = require('../audit/audit');

const TAG = 'legacy/unverified';

// Pure.
function classify(d) {
  if (!d || typeof d !== 'object') return 'OTHER';
  if (d.decision !== null && typeof d.decision === 'object') return 'LEGACY_OBJECT_DECISION';
  if (typeof d.decision !== 'string') return 'OTHER';
  if (typeof d.state !== 'string') return 'LEGACY_NO_STATE';
  if (typeof d.reasonCode !== 'string') return 'LEGACY_NO_REASON_CODE';
  return 'CURRENT';
}

// Read-only inventory: counts by format, date range, and links to outcomes.
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

// Dry run of the tagging. Changes nothing.
function tagPlan(decisions) {
  const legacy = decisions.filter(d => classify(d) !== 'CURRENT');
  const byFormat = {};
  for (const d of legacy) byFormat[classify(d)] = (byFormat[classify(d)] || 0) + 1;
  return { dryRun: true, wouldTag: legacy.length, byFormat, alreadyTagged: decisions.filter(d => d.evidenceStatus === TAG).length };
}

// Tags every legacy-format decision with evidenceStatus and the format it was found in. Nothing else changes.
async function tagApply({ actor = 'owner', now = new Date() } = {}) {
  let tagged = 0;
  await storage.mutate('decisions', rows => {
    const next = rows.map(d => {
      if (classify(d) === 'CURRENT' || d.evidenceStatus === TAG) return d;
      tagged++;
      return { ...d, evidenceStatus: TAG, legacyProvenance: { format: classify(d), taggedAt: now.toISOString(), taggedBy: actor } };
    });
    return tagged ? next : undefined;
  });
  audit.record('LEGACY_DECISIONS_TAGGED', { actor, tagged });
  return { tagged };
}

// Removes only the tags this step added.
async function tagRollback({ actor = 'owner' } = {}) {
  let removed = 0;
  await storage.mutate('decisions', rows => {
    const next = rows.map(d => {
      if (d.evidenceStatus !== TAG || !d.legacyProvenance) return d;
      removed++;
      const { evidenceStatus, legacyProvenance, ...rest } = d;
      return rest;
    });
    return removed ? next : undefined;
  });
  audit.record('LEGACY_DECISION_TAGS_ROLLED_BACK', { actor, removed });
  return { removed };
}

module.exports = { classify, inventory, tagPlan, tagApply, tagRollback, TAG };
