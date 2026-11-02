const test = require('node:test');
const assert = require('node:assert/strict');
const fsx = require('fs-extra');
const storage = require('../src/data/storage');

// Fake file operations so the test never touches the real data folder.
const real = { rename: fsx.rename, writeJson: fsx.writeJson, ensureDir: fsx.ensureDir, remove: fsx.remove };
function fake({ renameErrors = [] }) {
  const calls = { rename: 0, removed: 0 };
  fsx.writeJson = async () => {};
  fsx.ensureDir = async () => {};
  fsx.remove = async () => { calls.removed++; };
  fsx.rename = async () => {
    calls.rename++;
    const e = renameErrors.shift();
    if (e) { const err = new Error(e); err.code = e; throw err; }
  };
  return calls;
}
function restore() {
  fsx.rename = real.rename; fsx.writeJson = real.writeJson; fsx.ensureDir = real.ensureDir; fsx.remove = real.remove;
}

test('a transient Windows rename failure is retried and the save succeeds', async () => {
  const calls = fake({ renameErrors: ['EPERM', 'EPERM'] });
  try {
    await storage.save('test_collection', []);
    assert.equal(calls.rename, 3);
  } finally { restore(); }
});

test('a rename that keeps failing raises the error and removes the temp file', async () => {
  const calls = fake({ renameErrors: Array(10).fill('EPERM') });
  try {
    await assert.rejects(storage.save('test_collection', []), { code: 'EPERM' });
    assert.equal(calls.rename, 6);
    assert.equal(calls.removed, 1);
  } finally { restore(); }
});

test('errors that are not transient are raised at once, not retried', async () => {
  const calls = fake({ renameErrors: ['ENOENT'] });
  try {
    await assert.rejects(storage.save('test_collection', []), { code: 'ENOENT' });
    assert.equal(calls.rename, 1);
  } finally { restore(); }
});

// A damaged file is loaded again every engine cycle; the evidence copy must be taken once, not per load.
const realRead = { pathExists: fsx.pathExists, readJson: fsx.readJson, copy: fsx.copy };
function fakeDamaged({ copyFails = false } = {}) {
  const calls = { copied: 0 };
  fsx.pathExists = async () => true;
  fsx.readJson = async () => { throw new SyntaxError('Unexpected token'); };
  fsx.copy = async () => {
    calls.copied++;
    if (copyFails) throw new Error('EPERM: operation not permitted');
  };
  return calls;
}
function restoreRead() {
  fsx.pathExists = realRead.pathExists; fsx.readJson = realRead.readJson; fsx.copy = realRead.copy;
}

test('a file that stays unreadable is copied aside once, not once per load', async () => {
  const calls = fakeDamaged();
  try {
    for (let i = 0; i < 5; i++) assert.deepEqual(await storage.load('test_corrupt_once'), []);
    assert.equal(calls.copied, 1);
  } finally { restoreRead(); }
});

test('a load after a successful save copies the damage aside again', async () => {
  const calls = fakeDamaged();
  try {
    await storage.load('test_corrupt_rearm');
    await storage.load('test_corrupt_rearm');
    assert.equal(calls.copied, 1);
    const writes = fake({ renameErrors: [] });
    await storage.save('test_corrupt_rearm', []);
    assert.equal(writes.rename, 1);
    await storage.load('test_corrupt_rearm');
    assert.equal(calls.copied, 2);
  } finally { restore(); restoreRead(); }
});

test('a failed evidence copy does not stop the load', async () => {
  const calls = fakeDamaged({ copyFails: true });
  try {
    assert.deepEqual(await storage.load('test_corrupt_copy_fails'), []);
    assert.equal(calls.copied, 1);
  } finally { restoreRead(); }
});
