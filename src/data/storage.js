const fs = require('fs-extra');
const path = require('path');
const DATA_DIR = process.env.AIS_DATA_DIR || path.join(__dirname, '../../data'); // env override is for tests
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;

// Writes to one collection run one at a time inside this process. Without this, two overlapping read-modify-write
// cycles each load the same file and the later save drops the earlier record.
const chains = new Map();
let tmpCounter = 0;
function serial(collection, fn) {
  const prev = chains.get(collection) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  chains.set(collection, run);
  return run;
}

async function load(collection) {
  const file = path.join(DATA_DIR, `${collection}.json`);
  if (!await fs.pathExists(file)) return [];
  try {
    return await fs.readJson(file);
  } catch (e) {
    // A damaged file (e.g. cut off mid-write) must not stop the engine: keep a copy and start fresh.
    await fs.copy(file, `${file}.corrupt-${Date.now()}`);
    console.log(`[storage] ${collection}.json was unreadable (${e.message}) — copied aside, starting empty`);
    return [];
  }
}

// Write to a temp file first, then rename, so a crash mid-write never leaves a truncated file.
async function save(collection, data) {
  return serial(collection, () => writeFile(collection, data));
}

async function writeFile(collection, data) {
  await fs.ensureDir(DATA_DIR);
  const file = path.join(DATA_DIR, `${collection}.json`);
  // Unique per write, so two writes can never share a temp file.
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  await fs.writeJson(tmp, data, { spaces: 2 });
  // On Windows the rename can fail while another handle has the file open (indexers, antivirus, a concurrent read).
  // Retry briefly; if it still fails the error is raised, never silently ignored.
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      if (!RETRYABLE.has(e.code) || attempt >= RENAME_ATTEMPTS) { await fs.remove(tmp).catch(() => {}); throw e; }
      await new Promise(r => setTimeout(r, 50 * attempt));
    }
  }
}

async function append(collection, item) {
  return serial(collection, async () => {
    const data = await load(collection);
    data.push(item);
    await writeFile(collection, data);
    return item;
  });
}

async function update(collection, id, updates) {
  return serial(collection, async () => {
    const data = await load(collection);
    const idx = data.findIndex(i => i.id === id);
    if (idx >= 0) { data[idx] = { ...data[idx], ...updates }; await writeFile(collection, data); }
    return data[idx];
  });
}

// Read-modify-write as one step. `fn` receives the current records and returns the new array, or undefined to leave the file unchanged.
async function mutate(collection, fn) {
  return serial(collection, async () => {
    const data = await load(collection);
    const next = await fn(data);
    if (next !== undefined) await writeFile(collection, next);
    return next;
  });
}

module.exports = { load, save, append, update, mutate };