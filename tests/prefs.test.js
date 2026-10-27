const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AIS_PREFS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ais-prefs-')), 'prefs.json');
const prefs = require('../src/governance/prefs');

test('the dashboard toggles trading on and off and the change persists', async () => {
  await prefs.init();
  assert.equal((await prefs.set({ tradingEnabled: false })).tradingEnabled, false);
  assert.equal((await prefs.set({ tradingEnabled: true })).tradingEnabled, true);
  const saved = JSON.parse(fs.readFileSync(process.env.AIS_PREFS_FILE, 'utf8'));
  assert.equal(saved.tradingEnabled, true);
});

test('live trading cannot be enabled through preferences', async () => {
  await assert.rejects(prefs.set({ liveMode: true }), /live trading is locked/);
  assert.equal((await prefs.get()).liveMode, false);
});

test('unknown keys and non-boolean values are ignored, not stored', async () => {
  const r = await prefs.set({ tradingEnabled: 'yes', somethingElse: 1, autoStart: false });
  assert.equal(r.autoStart, false);
  assert.equal(r.tradingEnabled, true, 'a non-boolean was not applied');
  assert.equal(r.somethingElse, undefined);
});
