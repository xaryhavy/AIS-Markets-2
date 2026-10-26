const fs = require('fs-extra');
const path = require('path');
const PREF_FILE = path.join(__dirname, '../../data/preferences.json');
const DEFAULT = {
  autoStartTrading: true,
  tradingEnabled: true,
  liveTradingApproved: false,
  lastCleanShutdown: true,
  lastUpdated: new Date().toISOString()
};

async function init() {
  await fs.ensureDir(path.dirname(PREF_FILE));
  if (!await fs.pathExists(PREF_FILE)) {
    await fs.writeJson(PREF_FILE, DEFAULT, { spaces: 2 });
  }
}

async function get() {
  await init();
  return fs.readJson(PREF_FILE);
}

async function set(updates) {
  const current = await get();
  const merged = { ...current, ...updates, lastUpdated: new Date().toISOString() };
  await fs.writeJson(PREF_FILE, merged, { spaces: 2 });
  return merged;
}

async function isTradingEnabled() {
  const prefs = await get();
  if (!prefs.lastCleanShutdown) return false;
  return prefs.tradingEnabled;
}

module.exports = { init, get, set, isTradingEnabled };