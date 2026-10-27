const fs = require("fs-extra");
const path = require("path");

const PREFS_FILE = process.env.AIS_PREFS_FILE || path.join(__dirname, "..", "..", "data", "prefs.json"); // env override is for tests
// Only these can be changed from the dashboard. Live trading is locked and is never settable here.
const SETTABLE = new Set(["tradingEnabled", "autoStart"]);
let prefs = {
  tradingEnabled: true,
  autoStart: true,
  liveMode: false
};

async function init() {
  await fs.ensureDir(path.dirname(PREFS_FILE));
  if (await fs.pathExists(PREFS_FILE)) {
    try {
      const saved = await fs.readJson(PREFS_FILE);
      prefs = { ...prefs, ...saved, liveMode: false };
    } catch {}
  }
}

async function isEnabled() { return prefs.tradingEnabled; }
async function setEnabled(val) {
  prefs.tradingEnabled = val;
  await fs.writeJson(PREFS_FILE, prefs, { spaces: 2 });
}
async function get() { return { ...prefs }; }

// Applies dashboard changes. Unknown keys are ignored; liveMode is refused outright.
async function set(updates = {}) {
  if (updates.liveMode !== undefined && updates.liveMode !== false) {
    throw new Error("live trading is locked in this build and cannot be enabled from the dashboard");
  }
  const clean = {};
  for (const [k, v] of Object.entries(updates)) {
    if (SETTABLE.has(k) && typeof v === "boolean") clean[k] = v;
  }
  prefs = { ...prefs, ...clean, liveMode: false };
  await fs.writeJson(PREFS_FILE, prefs, { spaces: 2 });
  return { ...prefs };
}

module.exports = { init, isEnabled, setEnabled, get, set };
