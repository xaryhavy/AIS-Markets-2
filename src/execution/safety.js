// Conditions that stop NEW entries. Exits and reconciliation keep running regardless.
const limits = require('../risk/limits');
const MAX_QUOTE_AGE_MS = 15000; // default; the live value is maxQuoteAgeSeconds in risk limits

// Pure: returns the list of reasons entries are blocked (empty list = entries allowed).
function entryBlockers({ feedReady, quoteAgeMs, unresolvedIntents = [], unmanagedPositions = [] }) {
  const reasons = [];
  if (!feedReady) reasons.push('live feed not ready');
  const maxAgeMs = limits.value('maxQuoteAgeSeconds') * 1000;
  if (!(quoteAgeMs <= maxAgeMs)) {
    reasons.push(Number.isFinite(quoteAgeMs) ? `quote is stale (${Math.round(quoteAgeMs / 1000)}s old)` : 'quote age unknown');
  }
  if (unresolvedIntents.length) reasons.push(`${unresolvedIntents.length} order outcome(s) not yet confirmed by the broker`);
  if (unmanagedPositions.length) reasons.push(`${unmanagedPositions.length} broker position(s) have no local record`);
  return reasons;
}

module.exports = { entryBlockers, MAX_QUOTE_AGE_MS };
