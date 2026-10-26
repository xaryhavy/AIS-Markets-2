// Owner emergency shutdown (decision 11). Disables all NEW entries at once and records who, when, why and the system state.
// Open positions are NOT closed: they stay managed and protected by exits, monitoring and reconciliation.
// Idempotent: a repeat request while a shutdown is active returns that shutdown and writes nothing new.
// Resuming needs a successful broker reconciliation and an owner action. The record survives restarts.
const crypto = require('crypto');
const storage = require('../data/storage');
const audit = require('../audit/audit');
const limits = require('../risk/limits');
const entryPause = require('../engine/entryPause');

const COLLECTION = 'shutdown_records';
const MIN_REASON = 5;

function findActive(rows) {
  return rows.slice().reverse().find(r => r.status === 'ACTIVE') || null;
}

async function current() {
  return findActive(await storage.load(COLLECTION));
}

// Returns { alreadyActive, record }. Throws when the reason is missing or too short.
async function request({ actor = 'owner', reason, snapshot = {} } = {}) {
  if (typeof reason !== 'string' || reason.trim().length < MIN_REASON) {
    throw new Error(`a reason of at least ${MIN_REASON} characters is required`);
  }
  let created = null;
  let existing = null;
  // Check and write in one locked step, so two overlapping requests cannot both create a shutdown.
  await storage.mutate(COLLECTION, rows => {
    existing = findActive(rows);
    if (existing) return undefined;
    created = {
      id: 'SD-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
      status: 'ACTIVE',
      requestedAt: new Date().toISOString(),
      actor,
      reason: reason.trim(),
      snapshot
    };
    return [...rows, created];
  });
  if (existing) return { alreadyActive: true, record: existing };
  await limits.setEmergencyStop(true, `OWNER SHUTDOWN: ${created.reason}`);
  await entryPause.pauseEntries(`owner shutdown: ${created.reason}`);
  audit.record('OWNER_SHUTDOWN_REQUESTED', { id: created.id, actor, reason: created.reason });
  return { alreadyActive: false, record: created };
}

// Owner action. Refused unless the last broker reconciliation succeeded.
async function resume({ actor = 'owner', reconcileOk } = {}) {
  const active = await current();
  if (!active) return { resumed: false, reason: 'no active shutdown' };
  if (reconcileOk !== true) return { resumed: false, reason: 'a successful broker reconciliation is required before resuming' };
  await storage.mutate(COLLECTION, rows => rows.map(r => (r.id === active.id && r.status === 'ACTIVE'
    ? { ...r, status: 'RESUMED', resumedAt: new Date().toISOString(), resumedBy: actor }
    : r)));
  await limits.setEmergencyStop(false, '');
  await entryPause.resume({ reconcileOk: true, actor });
  audit.record('OWNER_SHUTDOWN_RESUMED', { id: active.id, actor });
  return { resumed: true, id: active.id };
}

module.exports = { current, request, resume, COLLECTION, MIN_REASON };
