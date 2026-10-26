// Counts failed broker requests by kind, so a degraded provider shows up in status before it causes a missed trade.
// Counts reset when the process restarts. Only the kind and a short message are kept, never request contents.
const counts = {};
let last = null;

function record(kind, message) {
  counts[kind] = (counts[kind] || 0) + 1;
  last = { kind, message: String(message || '').slice(0, 200), at: new Date().toISOString() };
}

function snapshot() {
  return { total: Object.values(counts).reduce((a, b) => a + b, 0), byKind: { ...counts }, last };
}

function reset() {
  for (const k of Object.keys(counts)) delete counts[k];
  last = null;
}

module.exports = { record, snapshot, reset };
