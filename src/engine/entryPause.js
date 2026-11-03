// Entry pause after repeated engine cycle failures (owner decision 4).
// Pauses NEW entries only. Exits, the NO-TRADE monitor and protection checks keep running; open positions are never touched.
// Resuming needs a successful broker reconciliation AND an owner action. The state is persisted, so a restart keeps it.
const storage = require('../data/storage');
const audit = require('../audit/audit');

const COLLECTION = 'entry_pause';
const DEFAULT_THRESHOLD = 3;
const MIN_THRESHOLD = 1;
const MAX_THRESHOLD = 20;

let state = { active: false, reason: null, cause: null, since: null, threshold: DEFAULT_THRESHOLD, resumedAt: null };

// Pure. Returns the validated threshold or throws.
function validThreshold(n) {
  if (!Number.isInteger(n) || n < MIN_THRESHOLD || n > MAX_THRESHOLD) {
    throw new Error(`threshold must be a whole number from ${MIN_THRESHOLD} to ${MAX_THRESHOLD}`);
  }
  return n;
}

async function save() {
  await storage.save(COLLECTION, [state]);
}

// Loads the persisted state at startup. A missing file means not paused.
async function init() {
  const rows = await storage.load(COLLECTION);
  if (rows.length && rows[0] && typeof rows[0].active === 'boolean') {
    state = { ...state, ...rows[0], threshold: validThreshold(rows[0].threshold ?? DEFAULT_THRESHOLD) };
    // Records written before the wording fix carry the status inside the reason, which every surface then
    // repeated back at the owner. The status is the surfaces' job, so the stored text is reduced to the cause.
    if (state.reason) state.reason = state.reason.replace(/;\s*new entries paused\s*$/i, '').trim();
    if (!('cause' in state)) state.cause = null;
  }
  return status();
}

function status() {
  return { ...state };
}

// Called after each failed cycle with the current run of consecutive failures. Trips the pause once.
// `cause` is the failing cycle's own error message. Without it the owner is told only how many cycles failed,
// never why, and the reason exists nowhere they can read — it is the difference between a count and a defect.
async function tripOnFailures(consecutiveFailures, cause = null) {
  if (state.active || consecutiveFailures < state.threshold) return false;
  state = {
    ...state,
    active: true,
    reason: `${consecutiveFailures} consecutive engine cycles failed`,
    cause: cause ? String(cause) : null,
    since: new Date().toISOString(),
    resumedAt: null
  };
  await save();
  audit.record('ENTRIES_PAUSED', { reason: state.reason, cause: state.cause, threshold: state.threshold });
  return true;
}

// Pauses entries for a stated reason (used by the owner shutdown). Resuming still goes through resume().
async function pauseEntries(reason, cause = null) {
  state = { ...state, active: true, reason, cause: cause ? String(cause) : null, since: new Date().toISOString(), resumedAt: null };
  await save();
  audit.record('ENTRIES_PAUSED', { reason, cause: state.cause });
  return status();
}

// Owner action. Refused unless the last broker reconciliation succeeded.
async function resume({ reconcileOk, actor = 'owner' }) {
  if (!state.active) return { resumed: false, reason: 'entries are not paused' };
  if (reconcileOk !== true) return { resumed: false, reason: 'a successful broker reconciliation is required before resuming' };
  state = { ...state, active: false, reason: null, cause: null, resumedAt: new Date().toISOString() };
  await save();
  audit.record('ENTRIES_RESUMED', { actor });
  return { resumed: true };
}

async function setThreshold(n) {
  state = { ...state, threshold: validThreshold(n) };
  await save();
  audit.record('ENTRY_PAUSE_THRESHOLD_SET', { threshold: state.threshold });
  return status();
}

module.exports = { init, status, tripOnFailures, pauseEntries, resume, setThreshold, validThreshold, DEFAULT_THRESHOLD, MIN_THRESHOLD, MAX_THRESHOLD };
