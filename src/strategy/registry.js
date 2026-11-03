// The strategy registry: every strategy the engine could run is a versioned, immutable record.
//
// An approval binds to a content hash, not to a name. Change the rules or the strategy's own code and the
// hash changes, so the approved version is no longer the one on disk — the new one starts at DRAFT and the
// owner has to approve it before the engine can act on it again.
//
// The state machine is enforced here rather than in the routes, so no caller — route, script or test —
// can move a version somewhere the owner did not authorise.
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

const REGISTRY_FILE = process.env.AIS_REGISTRY_FILE || path.join(__dirname, '../../data/strategy-registry.json'); // env override is for tests

// Only DEPLOYED versions may run. APPROVED means "the owner accepted this exact content"; DEPLOYED means
// "and it is armed". Splitting the two keeps the arming step a separate, deliberate action.
const STATES = ['DRAFT', 'APPROVED', 'DEPLOYED', 'RETIRED'];

// A material change never edits a record in place — it registers a new version. So the only way a version
// leaves a state is a transition the owner could have meant, and RETIRED has no route back except re-approval.
const TRANSITIONS = {
  DRAFT: ['APPROVED', 'RETIRED'],
  APPROVED: ['DEPLOYED', 'RETIRED'],
  DEPLOYED: ['RETIRED'],
  RETIRED: ['APPROVED']
};

// A transition is an owner decision, so it carries a reason the owner can read back later. Same floor the
// unmanaged-position resolutions use, for the same reason: a one-word reason records nothing.
const MIN_REASON = 10;

let cache = null; // { records: { 'name@version': record }, adopted: bool }

// Writes are read-modify-write over one file; two owner actions at once must not lose one of them.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.catch(() => {}).then(fn);
  chain = run;
  return run;
}

// Deterministic JSON, so two records with the same rules always produce the same hash regardless of the
// order the caller happened to write the keys in.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Hashes what actually decides a signal: the declared rules and the strategy's own source. A code change
// therefore invalidates the approval too. That is deliberately strict — a refactor costs a re-approval,
// whereas running unreviewed logic the owner believes they approved costs more.
function hashRules(rules) {
  return `sha256:${crypto.createHash('sha256').update(canonical(rules)).digest('hex')}`;
}

async function load() {
  if (cache) return cache;
  const read = await fs.readJson(REGISTRY_FILE).catch(() => null);
  cache = { records: (read && read.records) || {}, adopted: Boolean(read && read.adopted) };
  return cache;
}

async function save() {
  await fs.ensureDir(path.dirname(REGISTRY_FILE));
  await fs.writeJson(REGISTRY_FILE, cache, { spaces: 2 });
}

function key(strategy, version) { return `${strategy}@${version}`; }

// Every read loads first, so a caller can never see an empty registry just because nothing had been
// loaded yet in this process — which would read as "nothing is registered" when the file says otherwise.
function versionsOf(strategy) {
  return Object.values(cache.records)
    .filter((r) => r.strategy === strategy)
    .sort((a, b) => a.version - b.version);
}

// The newest version of a strategy, whatever its state. Registration compares against this one.
async function latest(strategy) {
  await load();
  const versions = versionsOf(strategy);
  return versions.length ? versions[versions.length - 1] : null;
}

async function all() {
  await load();
  return Object.values(cache.records).sort((a, b) =>
    a.strategy === b.strategy ? a.version - b.version : a.strategy.localeCompare(b.strategy));
}

async function get(strategy, version) {
  await load();
  return cache.records[key(strategy, version)] || null;
}

function requireReason(reason) {
  const text = String(reason || '').trim();
  if (text.length < MIN_REASON) throw new Error(`A recorded reason of at least ${MIN_REASON} characters is required`);
  return text;
}

// Registers rules as a new version, or returns the existing one when nothing material changed.
// Idempotent on purpose: the engine re-registers its baseline on every start, and that must not grow history.
async function register(strategy, rules, { actor = 'system', reason = 'registered' } = {}) {
  await load();
  const hash = hashRules(rules);
  const current = await latest(strategy);
  if (current && current.hash === hash) return { record: current, created: false };

  const record = {
    strategy,
    version: current ? current.version + 1 : 1,
    hash,
    rules,
    state: 'DRAFT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // The rules themselves are on the record, so an approval can be checked against what it covered.
    history: [{ state: 'DRAFT', at: new Date().toISOString(), actor, reason: String(reason) }]
  };
  cache.records[key(strategy, record.version)] = record;
  await save();
  return { record, created: true };
}

// The one place a version changes state. Everything else goes through here.
async function transition(strategy, version, to, { actor = 'owner', reason } = {}) {
  await load();
  const record = await get(strategy, version);
  if (!record) throw new Error(`Unknown strategy version ${strategy}@${version}`);
  if (!STATES.includes(to)) throw new Error(`Unknown state ${to}`);
  if (!TRANSITIONS[record.state].includes(to)) {
    throw new Error(`Cannot move ${strategy}@${version} from ${record.state} to ${to}`);
  }
  const why = requireReason(reason);
  record.state = to;
  record.updatedAt = new Date().toISOString();
  record.history.push({ state: to, at: record.updatedAt, actor, reason: why });
  await save();
  return record;
}

// Approval names the hash it covers. If the rules were changed after the owner read them, this fails
// rather than silently approving whatever is on disk now.
async function approve(strategy, version, hash, { actor = 'owner', reason } = {}) {
  await load();
  const record = await get(strategy, version);
  if (!record) throw new Error(`Unknown strategy version ${strategy}@${version}`);
  if (hash !== record.hash) {
    throw new Error(`Approval hash does not match ${strategy}@${version}: the rules changed after they were read`);
  }
  return transition(strategy, version, 'APPROVED', { actor, reason });
}

async function deploy(strategy, version, opts = {}) {
  return transition(strategy, version, 'DEPLOYED', opts);
}

async function retire(strategy, version, opts = {}) {
  return transition(strategy, version, 'RETIRED', opts);
}

// The gate. The engine may run a strategy only when its current version is DEPLOYED. A newer DRAFT sitting
// above a deployed version does not revoke the deployment — but it does mean unreviewed rules are waiting.
async function gate(strategy) {
  await load();
  const versions = versionsOf(strategy);
  if (!versions.length) return { allowed: false, reason: `${strategy} is not registered`, version: null, hash: null };
  const current = versions[versions.length - 1];

  // What runs is the deployed version, not the newest one. A draft waiting above it does not disarm
  // anything by itself — it only means unreviewed rules are queued.
  const deployed = versions.filter((r) => r.state === 'DEPLOYED').pop();
  if (!deployed) {
    return {
      allowed: false,
      reason: `${strategy}@${current.version} is ${current.state}, not DEPLOYED`,
      version: current.version,
      hash: current.hash
    };
  }
  if (deployed.version !== current.version) {
    return {
      allowed: true,
      reason: `${strategy}@${deployed.version} is deployed; ${current.version} is ${current.state} and not in use`,
      version: deployed.version,
      hash: deployed.hash
    };
  }
  return { allowed: true, reason: `${strategy}@${deployed.version} is deployed`, version: deployed.version, hash: deployed.hash };
}

async function isRunnable(strategy) {
  return (await gate(strategy)).allowed;
}

// The names the engine may run. Empty means the engine has nothing it is allowed to act on.
async function runnableNames() {
  await load();
  return [...new Set(
    Object.values(cache.records).filter((r) => r.state === 'DEPLOYED').map((r) => r.strategy)
  )].sort();
}

// First run only: adopt whatever was already in service as version 1, already deployed.
//
// This is a migration, not an approval. Without it the gate would halt a running system the moment it
// shipped. It runs once — `adopted` is written to the file — after which every change needs the owner.
async function adoptBaseline(descriptors, { reason = 'initial adoption: in service before the registry existed' } = {}) {
  await load();
  if (cache.adopted) return { adopted: false, records: [] };
  const now = new Date().toISOString();
  const records = [];
  for (const { strategy, rules } of descriptors) {
    if (await latest(strategy)) continue;
    const record = {
      strategy,
      version: 1,
      hash: hashRules(rules),
      rules,
      state: 'DEPLOYED',
      createdAt: now,
      updatedAt: now,
      history: [
        { state: 'DRAFT', at: now, actor: 'system-migration', reason: String(reason) },
        { state: 'APPROVED', at: now, actor: 'system-migration', reason: String(reason) },
        { state: 'DEPLOYED', at: now, actor: 'system-migration', reason: String(reason) }
      ]
    };
    cache.records[key(strategy, 1)] = record;
    records.push(record);
  }
  cache.adopted = true;
  await save();
  return { adopted: true, records };
}

// Tests get a clean slate without touching the real file.
function resetCache() { cache = null; }

module.exports = {
  REGISTRY_FILE, STATES, TRANSITIONS, MIN_REASON,
  hashRules, canonical,
  load, all, get, versionsOf, latest,
  register, approve, deploy, retire, transition,
  gate, isRunnable, runnableNames, adoptBaseline, resetCache
};
