const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The audit module reads its file path at load time, so point it at a temp file before requiring it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-audit-'));
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const audit = require('../src/audit/audit');

test('owner connect, disconnect and logout are recorded in the chain with their state change', () => {
  audit.record('OWNER_CONNECT', { from: 'DISCONNECTED', to: 'ACCOUNT_AUTHENTICATED' });
  audit.record('OWNER_DISCONNECT', { from: 'ACCOUNT_AUTHENTICATED', to: 'DISCONNECTED' });
  audit.record('OWNER_LOGOUT', { from: 'DISCONNECTED' });
  const lines = fs.readFileSync(audit.AUDIT_FILE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => l.type), ['OWNER_CONNECT', 'OWNER_DISCONNECT', 'OWNER_LOGOUT']);
  assert.deepEqual(lines[1].fields, { from: 'ACCOUNT_AUTHENTICATED', to: 'DISCONNECTED' });
  assert.equal(audit.verify().ok, true);
});

test('tampering with a recorded owner action breaks verification', () => {
  const lines = fs.readFileSync(audit.AUDIT_FILE, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.fields.to = 'ACCOUNT_AUTHENTICATED';
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(audit.AUDIT_FILE, lines.join('\n') + '\n');
  assert.equal(audit.verify().ok, false);
});
