// Evidence classes. A record's class is derived from its own fields and is never rewritten in storage.
// Strategy evaluation uses BROKER_DEMO_EXACT only. Nothing here changes what is stored.
const CLASSES = {
  BROKER_DEMO_EXACT: 'BROKER_DEMO_EXACT',           // closed on the demo broker with the broker-reported result
  BROKER_DEMO_ESTIMATED: 'BROKER_DEMO_ESTIMATED',   // closed on the broker outside AIS; the result is an estimate
  FAULT_TEST: 'FAULT_TEST',                         // deliberate broker test trade (fault injection); real demo execution, not a strategy result
  SIMULATED_PAPER: 'SIMULATED_PAPER',               // PAPER mode fills: simulated, never sent to a broker
  SIMULATED_LEGACY: 'SIMULATED_LEGACY',             // paper or simulated trade from before the live connection
  HYPOTHETICAL: 'HYPOTHETICAL'                      // NO-TRADE outcome: never an execution, profit or loss
};

// Pure. Returns one of CLASSES for a trade record.
function classifyTrade(t) {
  if (!t) return null;
  if (t.evidenceMode === 'PAPER') return CLASSES.SIMULATED_PAPER;
  if (t.source !== 'ctrader') return CLASSES.SIMULATED_LEGACY;
  if (/fault-injection/i.test(String(t.closeReason || '')) || /fault-injection/i.test(String(t.reason || ''))) return CLASSES.FAULT_TEST;
  if (t.pnlEstimated) return CLASSES.BROKER_DEMO_ESTIMATED;
  return CLASSES.BROKER_DEMO_EXACT;
}

module.exports = { CLASSES, classifyTrade };
