const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep the owner token file out of the real data folder.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-auth-'));
process.env.AIS_AUTH_FILE = path.join(dir, 'auth.json');
const auth = require('../src/security/auth');

test('rotation issues a new token and the old token stops working at once', async () => {
  const first = await auth.init();
  assert.ok(first, 'first run creates a token');
  assert.equal(auth.verify(first), true);
  const second = await auth.rotate();
  assert.notEqual(second, first);
  assert.equal(auth.verify(first), false, 'old token refused');
  assert.equal(auth.verify(second), true, 'new token accepted');
});

test('the token file keeps only a hash, never the new token, and records the rotation time', async () => {
  const token = await auth.rotate();
  const raw = fs.readFileSync(auth.AUTH_FILE, 'utf8');
  assert.equal(raw.includes(token), false);
  const saved = JSON.parse(raw);
  assert.ok(saved.rotatedAt);
  assert.ok(saved.createdAt);
});

test('a rotated token survives a restart (the file is reloaded)', async () => {
  const token = await auth.rotate();
  delete require.cache[require.resolve('../src/security/auth')];
  const fresh = require('../src/security/auth');
  assert.equal(await fresh.init(), null, 'no new token is created when one exists');
  assert.equal(fresh.verify(token), true);
});
