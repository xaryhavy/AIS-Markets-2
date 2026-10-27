// Legacy simulated trades (decision 1). Archive, don't reclassify or delete.
//   - Each legacy record gets evidenceStatus 'legacy/unverified' and a legacyProvenance block with its original source and status.
//   - Nothing is deleted or rewritten: original fields stay exactly as they were.
//   - A full copy of the trade store is written first (data/archive/), so the step can always be checked.
//   - Rollback removes only the tags this step added. Trades recorded after the archive are untouched.
//   - Legacy records are excluded from learning, strategy metrics and owner performance (see evidence.js, performance.js,
//     engine learning filter), and are shown only in the reports' legacy disclosure.
const fs = require('fs-extra');
const path = require('path');
const storage = require('./storage');
const audit = require('../audit/audit');
const { CLASSES, classifyTrade } = require('../analytics/evidence');

const ARCHIVE_DIR = process.env.AIS_ARCHIVE_DIR || path.join(__dirname, '../../data/archive'); // env override is for tests
const STATE = 'legacy_archive_state';
const TAG = 'legacy/unverified';

// Pure. Which trade records are legacy (simulated before the live connection, not PAPER).
function isLegacy(t) {
  return classifyTrade(t) === CLASSES.SIMULATED_LEGACY;
}

async function state() {
  const rows = await storage.load(STATE);
  return rows[0] || { applied: false };
}

// Dry run. Changes nothing.
async function plan() {
  const trades = await storage.load('trades');
  const legacy = trades.filter(isLegacy);
  const byStatus = {};
  for (const t of legacy) byStatus[t.status || 'UNKNOWN'] = (byStatus[t.status || 'UNKNOWN'] || 0) + 1;
  return {
    dryRun: true,
    tradesTotal: trades.length,
    legacyCount: legacy.length,
    byStatus,
    sampleIds: legacy.slice(0, 5).map(t => t.id),
    alreadyApplied: (await state()).applied === true,
    wouldTag: { evidenceStatus: TAG, legacyProvenance: 'source, environment, original status, archivedAt' }
  };
}

// Applies the archive tags. Refused if already applied (use rollback first to reverse it).
async function apply({ actor = 'owner', now = new Date() } = {}) {
  if ((await state()).applied === true) throw new Error('legacy archive is already applied; roll it back first if needed');
  const trades = await storage.load('trades');
  await fs.ensureDir(ARCHIVE_DIR);
  const backup = path.join(ARCHIVE_DIR, `trades.before-legacy-archive.${now.getTime()}.json`);
  await fs.writeJson(backup, trades, { spaces: 2 });
  const archivedAt = now.toISOString();
  let count = 0;
  const ids = [];
  await storage.mutate('trades', rows => rows.map(t => {
    if (!isLegacy(t)) return t;
    count++;
    ids.push(t.id);
    return { ...t, evidenceStatus: TAG, legacyProvenance: { source: t.source ?? null, environment: t.environment ?? null, originalStatus: t.status ?? null, archivedAt } };
  }));
  await storage.save(STATE, [{ applied: true, appliedAt: archivedAt, appliedBy: actor, backup, count, ids }]);
  audit.record('LEGACY_ARCHIVED', { actor, count, backup });
  return { applied: true, count, backup };
}

// Removes only the tags this step added. Records appended after the archive are not touched.
async function rollback({ actor = 'owner' } = {}) {
  const s = await state();
  if (s.applied !== true) throw new Error('no legacy archive is applied');
  const ids = new Set(s.ids || []);
  let removed = 0;
  await storage.mutate('trades', rows => rows.map(t => {
    if (!ids.has(t.id) || t.evidenceStatus !== TAG) return t;
    removed++;
    const { evidenceStatus, legacyProvenance, ...rest } = t;
    return rest;
  }));
  await storage.save(STATE, [{ ...s, applied: false, rolledBackAt: new Date().toISOString(), rolledBackBy: actor }]);
  audit.record('LEGACY_ARCHIVE_ROLLED_BACK', { actor, removed });
  return { rolledBack: true, removed };
}

module.exports = { plan, apply, rollback, isLegacy, state, TAG, ARCHIVE_DIR };
