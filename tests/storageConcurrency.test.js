const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Real files in a temp folder: these tests are about what happens when writes overlap.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-store-'));
process.env.AIS_DATA_DIR = dir;
const storage = require('../src/data/storage');
const read = c => JSON.parse(fs.readFileSync(path.join(dir, `${c}.json`), 'utf8'));

test('fifty overlapping appends all persist, none lost', async () => {
  await Promise.all(Array.from({ length: 50 }, (_, i) => storage.append('overlap', { id: `A${i}` })));
  const ids = read('overlap').map(x => x.id).sort();
  assert.equal(ids.length, 50);
  assert.equal(new Set(ids).size, 50);
});

test('overlapping saves, appends and updates on one collection do not fail with ENOENT', async () => {
  await storage.save('mixed', []);
  const work = [];
  for (let i = 0; i < 30; i++) {
    work.push(storage.append('mixed', { id: `M${i}`, status: 'OPEN' }));
    work.push(storage.update('mixed', `M${i}`, { status: 'DONE' }));
    work.push(storage.mutate('mixed', rows => rows.map(r => r))); // a locked read-modify-write, no stale snapshot
  }
  await Promise.all(work);
  assert.equal(read('mixed').length, 30);
});

test('a batch update through mutate keeps an append made while it runs', async () => {
  await storage.save('batch', [{ id: 'P1', status: 'PENDING' }]);
  const batch = storage.mutate('batch', async stored => {
    await new Promise(r => setTimeout(r, 30)); // another writer gets a chance to append meanwhile
    return stored.map(o => (o.status === 'PENDING' ? { ...o, status: 'EXPIRED' } : o));
  });
  const append = storage.append('batch', { id: 'NEW', status: 'PENDING' });
  await Promise.all([batch, append]);
  const out = read('batch');
  assert.equal(out.find(o => o.id === 'P1').status, 'EXPIRED');
  assert.ok(out.find(o => o.id === 'NEW'), 'the appended record survives');
});

test('a mutate that returns undefined leaves the file untouched', async () => {
  await storage.save('untouched', [{ id: 'U1' }]);
  const before = fs.statSync(path.join(dir, 'untouched.json')).mtimeMs;
  await storage.mutate('untouched', () => undefined);
  assert.equal(fs.statSync(path.join(dir, 'untouched.json')).mtimeMs, before);
});
