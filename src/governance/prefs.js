const fs = require("fs-extra");
const path = require("path");

const PREFS_FILE = path.join(__dirname, "..", "..", "data", "prefs.json");
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
      prefs = { ...prefs, ...saved };
    } catch {}
  }
}

async function isEnabled() { return prefs.tradingEnabled; }
async function setEnabled(val) {
  prefs.tradingEnabled = val;
  await fs.writeJson(PREFS_FILE, prefs, { spaces: 2 });
}
async function get() { return { ...prefs }; }

module.exports = { init, isEnabled, setEnabled, get };