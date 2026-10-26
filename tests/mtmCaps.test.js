const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-mtm-'));
process.env.AIS_DATA_DIR = dir;
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const audit = require('../src/audit/audit');
const caps = require('../src/risk/mtmCaps');
const entryPause = require('../src/engine/entryPause');

const types = () => fs.existsSync(audit.AUDIT_FILE)
  ? fs.readFileSync(audit.AUDIT_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).type) : [];
const at = iso => new Date(iso);

test('defaults are the demo values 2% daily, 5% weekly, 10% drawdown', async () => {
  assert.deepEqual(caps.DEFAULTS, { dailyLossPct: 2, weeklyLossPct: 5, maxDrawdownPct: 10 });
  assert.deepEqual(await caps.getCaps(), caps.DEFAULTS);
});

test('caps are validated: numbers between 0.1 and 50 only', () => {
  for (const bad of [0, 0.05, 51, NaN, '2', null, Infinity]) {
    assert.throws(() => caps.validateCaps({ dailyLossPct: bad }), /dailyLossPct must be a number from 0.1 to 50/, `rejects ${bad}`);
  }
  assert.deepEqual(caps.validateCaps({ dailyLossPct: 1.5 }), { dailyLossPct: 1.5, weeklyLossPct: 5, maxDrawdownPct: 10 });
});

test('a change is persisted and audited with before and after values', async () => {
  const next = await caps.setCaps({ dailyLossPct: 1.5, weeklyLossPct: 4, maxDrawdownPct: 8 }, 'owner');
  assert.equal(next.dailyLossPct, 1.5);
  assert.deepEqual(await caps.getCaps(), next);
  assert.ok(types().includes('MTM_CAPS_CHANGED'));
  await caps.setCaps(caps.DEFAULTS, 'owner');
});

test('breaches are measured against the baselines, with the caps inclusive', () => {
  const state = { dayStartEquity: 1000, weekStartEquity: 1000, peakEquity: 1000 };
  const c = caps.DEFAULTS;
  assert.deepEqual(caps.breaches({ equity: 980, state, caps: c }), [{ code: 'DAILY_MTM_LOSS', message: 'daily mark-to-market loss 2.00% reached the 2% cap' }]);
  assert.equal(caps.breaches({ equity: 981, state, caps: c }).length, 0, 'under the cap');
  assert.equal(caps.breaches({ equity: null, state, caps: c })[0].code, 'EQUITY_UNKNOWN');
});

test('a daily loss cap latches: entries are paused, the cap is audited, and later cycles stay blocked', async () => {
  const t0 = at('2026-10-26T10:00:00Z');
  assert.equal((await caps.checkCycle(1000, t0)).block, false, 'baseline set');
  const hit = await caps.checkCycle(975, at('2026-10-26T11:00:00Z'));
  assert.equal(hit.block, true);
  assert.equal(hit.latched, true);
  assert.equal(entryPause.status().active, true, 'new entries paused');
  assert.ok(types().includes('MTM_CAP_HIT'));
  const recovered = await caps.checkCycle(1000, at('2026-10-26T12:00:00Z'));
  assert.equal(recovered.block, true, 'recovery does not clear a latched cap');
  assert.equal((await caps.status()).tripped, true);
});

test('the latch survives a restart', async () => {
  delete require.cache[require.resolve('../src/risk/mtmCaps')];
  const fresh = require('../src/risk/mtmCaps');
  assert.equal((await fresh.status()).tripped, true);
  assert.equal((await fresh.checkCycle(1000, at('2026-10-26T13:00:00Z'))).block, true);
});

test('resume is refused without a successful reconciliation, then clears the latch and the pause', async () => {
  const refused = await caps.resume({ reconcileOk: false });
  assert.equal(refused.resumed, false);
  assert.match(refused.reason, /successful broker reconciliation/);
  const ok = await caps.resume({ actor: 'owner', reconcileOk: true });
  assert.equal(ok.resumed, true);
  assert.equal((await caps.status()).tripped, false);
  assert.equal(entryPause.status().active, false);
  assert.ok(types().includes('MTM_CAP_RESUMED'));
  assert.equal((await caps.checkCycle(1000, at('2026-10-26T14:00:00Z'))).block, false, 'trading may resume');
});

test('unknown equity blocks new entries for the cycle but does not latch the owner lock', async () => {
  const r = await caps.checkCycle(null, at('2026-10-26T15:00:00Z'));
  assert.equal(r.block, true);
  assert.equal(r.latched, false);
  assert.equal((await caps.status()).tripped, false);
  assert.equal((await caps.checkCycle(1000, at('2026-10-26T15:01:00Z'))).block, false);
});

test('a new UTC day resets the daily baseline, so yesterday losses do not count today', async () => {
  await caps.setCaps(caps.DEFAULTS, 'owner');
  await caps.checkCycle(1000, at('2026-10-27T00:05:00Z'));
  const r = await caps.checkCycle(985, at('2026-10-27T09:00:00Z'));
  assert.equal(r.block, false, '1.5% from the new day baseline is under the 2% cap');
});

test('the weekly cap counts across days within the same Monday-based week', async () => {
  // Week of Monday 2026-10-26: baseline 1000 on Monday, drops to 950 on Wednesday (5%), each day below its daily cap.
  await caps.checkCycle(1000, at('2026-10-26T06:00:00Z'));
  await caps.checkCycle(975, at('2026-10-27T06:00:00Z'));
  const r = await caps.checkCycle(950, at('2026-10-28T06:00:00Z'));
  assert.equal(r.block, true);
  assert.ok(r.breaches.some(b => b.code === 'WEEKLY_MTM_LOSS'));
});

test('a drawdown from peak latches even when the daily and weekly figures are fine', async () => {
  await caps.resume({ reconcileOk: true });
  await caps.setCaps({ dailyLossPct: 50, weeklyLossPct: 50, maxDrawdownPct: 10 }, 'owner');
  await caps.checkCycle(1000, at('2026-11-02T08:00:00Z'));
  await caps.checkCycle(1100, at('2026-11-02T09:00:00Z'));
  const r = await caps.checkCycle(985, at('2026-11-02T10:00:00Z'));
  assert.equal(r.block, true);
  assert.ok(r.breaches.some(b => b.code === 'MAX_DRAWDOWN'), '1100 to 985 is 10.45% drawdown');
});
