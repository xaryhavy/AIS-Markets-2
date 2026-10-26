const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Temporary files for auth and audit: the real data folder is never touched by these tests.
const tmp = name => path.join(os.tmpdir(), `ais-test-${process.pid}-${name}`);
process.env.AIS_AUTH_FILE = tmp('auth.json');
process.env.AIS_AUDIT_FILE = tmp('audit.log');
for (const f of [process.env.AIS_AUTH_FILE, process.env.AIS_AUDIT_FILE]) { try { fs.unlinkSync(f); } catch {} }

const auth = require('../src/security/auth');
const audit = require('../src/audit/audit');
const mode = require('../src/governance/mode');
const readiness = require('../src/governance/readiness');
const alerts = require('../src/ops/alerts');
const preTrade = require('../src/risk/preTrade');
const limits = require('../src/risk/limits');

test('owner token: created once, verified in constant time, never stored in plain text', async () => {
  const token = await auth.init();
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 40);
  assert.equal(auth.verify(token), true);
  assert.equal(auth.verify(token + 'x'), false);
  assert.equal(auth.verify('wrong'), false);
  assert.equal(auth.verify(undefined), false);
  assert.equal(auth.verify(''), false);
  assert.equal(await auth.init(), null, 'second start does not create another token');
  assert.equal(fs.readFileSync(process.env.AIS_AUTH_FILE, 'utf8').includes(token), false, 'token must not be on disk');
});

test('audit: a clean chain verifies, and the count is right', () => {
  audit.record('TEST_A', { n: 1 });
  audit.record('TEST_B', { n: 2 });
  audit.record('TEST_C', { n: 3 });
  const v = audit.verify();
  assert.equal(v.ok, true);
  assert.equal(v.count, 3);
});

test('audit: an altered record is detected at the exact entry', () => {
  const lines = fs.readFileSync(process.env.AIS_AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
  const e = JSON.parse(lines[1]);
  e.fields.n = 999;
  lines[1] = JSON.stringify(e);
  fs.writeFileSync(process.env.AIS_AUDIT_FILE, lines.join('\n') + '\n');
  const v = audit.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
  assert.equal(v.reason, 'content altered');
});

test('audit: a deleted record is detected', () => {
  audit.record('RESET', {});
  const lines = fs.readFileSync(process.env.AIS_AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
  lines.splice(1, 1); // remove the entry at position 2 (already altered above; restore the chain first)
  fs.writeFileSync(process.env.AIS_AUDIT_FILE, lines.join('\n') + '\n');
  const v = audit.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
});

test('operating mode: the default is the existing behaviour and LIVE cannot be selected', async () => {
  assert.equal(mode.current(), 'DEMO_AUTONOMOUS');
  assert.equal(mode.allowsBrokerOrders(), true);
  assert.equal(mode.MODES.LIVE.available, false);
  await assert.rejects(mode.setMode('LIVE', { confirm: 'CONFIRM LIVE' }), /not available/);
});

test('operating mode: unbuilt modes are refused, not silently accepted', async () => {
  await assert.rejects(mode.setMode('PAPER', {}), /not available/);
  await assert.rejects(mode.setMode('DEMO_SUPERVISED', {}), /not available/);
});

test('operating mode: order-placing modes need the exact confirmation phrase', async () => {
  await assert.rejects(mode.setMode('DEMO_AUTONOMOUS', {}), /CONFIRM DEMO_AUTONOMOUS/);
  await assert.rejects(mode.setMode('DEMO_AUTONOMOUS', { confirm: 'yes' }), /CONFIRM DEMO_AUTONOMOUS/);
});

const base = { mode: 'DEMO_AUTONOMOUS', allowsOrders: true, emergencyOn: false, fenceActive: false, tradingEnabled: true,
  brokerState: 'ACCOUNT_AUTHENTICATED', feedReady: true, unresolved: 0, unmanaged: 0 };

test('readiness: enabled only when every condition holds, and autonomous only in DEMO_AUTONOMOUS', () => {
  const r = readiness.readiness(base);
  assert.equal(r.executionState, 'enabled');
  assert.equal(r.ready, true);
  assert.equal(r.autonomous, true);
  assert.equal(readiness.readiness({ ...base, mode: 'OBSERVATION', allowsOrders: false }).autonomous, false);
});

test('readiness: uncertainty outranks everything and is never shown as ready', () => {
  const r = readiness.readiness({ ...base, unresolved: 1 });
  assert.equal(r.executionState, 'uncertain');
  assert.equal(r.ready, false);
  assert.match(r.reasons.join(' '), /not confirmed/);
  assert.equal(readiness.readiness({ ...base, unmanaged: 2 }).executionState, 'uncertain');
});

test('readiness: each stop condition disables execution and gives a reason', () => {
  for (const [patch, phrase] of [
    [{ emergencyOn: true }, /emergency/],
    [{ fenceActive: true }, /recovery review/],
    [{ tradingEnabled: false }, /switched off/],
    [{ brokerState: 'DISCONNECTED' }, /broker state/],
    [{ feedReady: false }, /feed/]
  ]) {
    const r = readiness.readiness({ ...base, ...patch });
    assert.equal(r.executionState, 'disabled', JSON.stringify(patch));
    assert.match(r.reasons.join(' '), phrase);
  }
});

test('health: healthy only when every component is ok', () => {
  const ok = { brokerState: 'ACCOUNT_AUTHENTICATED', feedReady: true, engineAgeMs: 1000, lastReconcileOk: true, authConfigured: true, auditOk: true };
  assert.equal(readiness.health(ok).status, 'healthy');
  const h = readiness.health({ ...ok, engineAgeMs: null, lastReconcileOk: null });
  assert.equal(h.status, 'degraded');
  assert.equal(h.components.engine, 'not running');
  assert.equal(h.components.reconciliation, 'never run');
  assert.match(readiness.health({ ...ok, auditOk: false, auditBrokenAt: 4 }).components.audit, /entry 4/);
});

test('alerts: diff reports new, cleared and changed conditions', () => {
  const current = { A: { code: 'A', message: 'x' }, B: { code: 'B', message: 'y' } };
  const d = alerts.diff(current, [{ code: 'A', message: 'x2', severity: 'high' }, { code: 'C', message: 'z', severity: 'info' }]);
  assert.deepEqual(d.opened.map(o => o.code), ['C']);
  assert.deepEqual(d.resolved.map(o => o.code), ['B']);
  assert.deepEqual(d.updated.map(o => o.code), ['A']);
});

test('the order boundary refuses broker orders in a mode that places none', () => {
  const cfg = limits.active();
  const order = { symbol: 'EURUSD', action: 'BUY', units: 1000, price: 1.1, stopLoss: 1.097, takeProfit: 1.109 };
  const ctx = { cfg, balance: 10000, bid: 1.09999, ask: 1.10001, openPositions: [], emergency: false, consecutiveLosses: 0, drawdownPct: 0,
    nowMs: Date.parse('2026-10-26T12:00:00Z'), mode: 'OBSERVATION', allowsOrders: false };
  const r = preTrade.check(order, ctx);
  assert.equal(r.allow, false);
  assert.match(r.reasons.join(' '), /OBSERVATION does not place broker orders/);
  assert.equal(preTrade.check(order, { ...ctx, allowsOrders: true, mode: 'DEMO_AUTONOMOUS' }).allow, true);
});

test.after(() => {
  for (const f of [process.env.AIS_AUTH_FILE, process.env.AIS_AUDIT_FILE]) { try { fs.unlinkSync(f); } catch {} }
});
