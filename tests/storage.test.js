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
