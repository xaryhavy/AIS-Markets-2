const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep the credentials file out of the real data folder.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-auth-'));
process.env.AIS_USERS_FILE = path.join(dir, 'users.json');
process.env.AIS_AUTH_FILE = path.join(dir, 'auth.json');
const auth = require('../src/security/auth');

test('password change: old password stops working, new one works', async () => {
  auth.resetForTests();
  await auth.createUser('rotatetest', 'oldPass123');
  assert.equal(auth.verify('rotatetest', 'oldPass123'), true);
  await auth.changePassword('rotatetest', 'oldPass123', 'newPass456');
  assert.equal(auth.verify('rotatetest', 'oldPass123'), false, 'old password refused');
  assert.equal(auth.verify('rotatetest', 'newPass456'), true, 'new password accepted');
});

test('the credential file keeps only a hash, never the password, and records the change time', async () => {
  auth.resetForTests();
  await auth.createUser('hashtest', 'testPass99');
  await auth.changePassword('hashtest', 'testPass99', 'otherPass99');
  const raw = fs.readFileSync(auth.USERS_FILE, 'utf8');
  assert.equal(raw.includes('otherPass99'), false);
  assert.equal(raw.includes('testPass99'), false);
  const saved = JSON.parse(raw);
  assert.ok(saved.passwordChangedAt);
  assert.ok(saved.createdAt);
});

test('a changed password survives a restart (the file is reloaded)', async () => {
  auth.resetForTests();
  await auth.createUser('persisttest', 'initPass12');
  await auth.changePassword('persisttest', 'initPass12', 'laterPass34');
  delete require.cache[require.resolve('../src/security/auth')];
  const fresh = require('../src/security/auth');
  await fresh.init();
  assert.equal(fresh.verify('persisttest', 'laterPass34'), true);
  assert.equal(fresh.verify('persisttest', 'initPass12'), false);
});

test('rotate() is removed — use changePassword', async () => {
  await assert.rejects(auth.rotate(), /use changePassword/);
});
