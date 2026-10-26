// Alerts: an open condition raises one alert; clearing the condition resolves it. Both transitions are audited.
// The engine supplies the current conditions each cycle; this module only tracks what changed.
const fs = require('fs-extra');
const path = require('path');
const audit = require('../audit/audit');

const ALERTS_FILE = path.join(__dirname, '../../data/alerts.json');
const SEVERITIES = ['critical', 'high', 'medium', 'info'];

let open = {}; // code -> { code, severity, message, since }

// Pure: which conditions are new and which have cleared.
function diff(current, wanted) {
  const opened = [], resolved = [], updated = [];
  for (const w of wanted) {
    const c = current[w.code];
    if (!c) opened.push(w);
    else if (c.message !== w.message) updated.push(w);
  }
  for (const code of Object.keys(current)) if (!wanted.some(w => w.code === code)) resolved.push(current[code]);
  return { opened, resolved, updated };
}

async function init() {
  open = await fs.readJson(ALERTS_FILE).catch(() => ({}));
  return open;
}

async function sync(conditions, nowIso = new Date().toISOString()) {
  for (const c of conditions) if (!SEVERITIES.includes(c.severity)) throw new Error(`bad severity ${c.severity}`);
  const { opened, resolved, updated } = diff(open, conditions);
  for (const w of opened) {
    open[w.code] = { code: w.code, severity: w.severity, message: w.message, since: nowIso };
    audit.record('ALERT_OPENED', { code: w.code, severity: w.severity, message: w.message });
  }
  for (const w of updated) {
    open[w.code] = { ...open[w.code], message: w.message };
  }
  for (const r of resolved) {
    delete open[r.code];
    audit.record('ALERT_RESOLVED', { code: r.code, since: r.since });
  }
  if (opened.length || resolved.length || updated.length) {
    await fs.ensureDir(path.dirname(ALERTS_FILE));
    await fs.writeJson(ALERTS_FILE, open, { spaces: 2 });
  }
  return { opened: opened.length, resolved: resolved.length };
}

function list() {
  return Object.values(open).sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

module.exports = { init, sync, list, diff, SEVERITIES };
