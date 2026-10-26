// Readiness and health, computed from backend state only. The dashboard shows these; it never decides them.
//   executionState: 'uncertain' (orders may have reached the broker, or positions are unmanaged)
//                 | 'disabled'  (AIS will not place orders now, for a stated reason)
//                 | 'enabled'   (AIS may place orders within the risk limits)
// Uncertainty outranks everything: it is never shown as ready.

const ENGINE_MAX_AGE_MS = 30000;

// Pure. `s` is the backend state snapshot.
function readiness(s) {
  const reasons = [];
  let executionState = 'enabled';
  if (s.unresolved > 0) reasons.push(`${s.unresolved} order outcome(s) not confirmed by the broker`);
  if (s.unmanaged > 0) reasons.push(`${s.unmanaged} broker position(s) with no local record`);
  if (reasons.length) executionState = 'uncertain';
  else {
    if (!s.allowsOrders) reasons.push(`mode ${s.mode} does not place broker orders`);
    if (s.emergencyOn) reasons.push('emergency stop is on');
    if (s.fenceActive) reasons.push('recovery review required after an unclean shutdown');
    if (s.entriesPaused) reasons.push(s.entriesPausedReason ? `new entries paused: ${s.entriesPausedReason}` : 'new entries paused (owner resume needed)');
    if (!s.tradingEnabled) reasons.push('automatic trading switched off by owner');
    if (s.brokerState !== 'ACCOUNT_AUTHENTICATED') reasons.push(`broker state ${s.brokerState}`);
    if (!s.feedReady) reasons.push('live price feed not ready');
    if (reasons.length) executionState = 'disabled';
  }
  const ready = executionState === 'enabled';
  return { executionState, ready, autonomous: ready && s.mode === 'DEMO_AUTONOMOUS', mode: s.mode, reasons };
}

// Pure. Each component is 'ok' or names what is wrong. Overall 'healthy' only when every component is ok.
function health(s) {
  const components = {
    broker: s.brokerState === 'ACCOUNT_AUTHENTICATED' ? 'ok' : `not connected (${s.brokerState})`,
    feed: s.feedReady ? 'ok' : 'not ready',
    engine: s.engineAgeMs === null || s.engineAgeMs === undefined ? 'not running'
      : s.engineAgeMs <= ENGINE_MAX_AGE_MS ? 'ok' : `stale (${Math.round(s.engineAgeMs / 1000)}s since last cycle)`,
    reconciliation: s.lastReconcileOk === true ? 'ok' : s.lastReconcileOk === false ? 'last reconciliation failed' : 'never run',
    auth: s.authConfigured ? 'ok' : 'owner token not configured',
    audit: s.auditOk ? 'ok' : `chain broken at entry ${s.auditBrokenAt}`
  };
  const healthy = Object.values(components).every(v => v === 'ok');
  return { status: healthy ? 'healthy' : 'degraded', components, at: new Date().toISOString() };
}

module.exports = { readiness, health, ENGINE_MAX_AGE_MS };
