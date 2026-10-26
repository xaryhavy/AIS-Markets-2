require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs-extra');
const fetch = require('node-fetch');
const prefs = require('./governance/prefs');
const engine = require('./engine/tradingEngine');
const marketData = require('./data/marketdata');
const storage = require('./data/storage');
const signalEngine = require('./intelligence/signalEngine');
const reportGenerator = require('./reports/reportGenerator');
const shadowTracker = require('./governance/shadowTracker');
const riskManager = require('./risk/riskManager');
const backtest = require('./backtest/engine');
const optimizer = require('./intelligence/optimizer');
const adaptiveLearner = require('./intelligence/adaptiveLearner');
const { listStrategies } = require('./intelligence/strategies');
const regimeDetector = require('./intelligence/regimeDetector');
const candlestickPatterns = require('./intelligence/candlestickPatterns');
const supplyDemand = require('./intelligence/supplyDemand');
const ctraderAuth = require('./ctrader/auth');
const ctraderConn = require('./ctrader/connectionManager');
const { OpenApiClient } = require('./ctrader/openApiClient');
const setupFlow = require('./ctrader/setupFlow');
const forecaster = require('./intelligence/forecaster');
const analytics = require('./analytics/performance');
const guardrails = require('./governance/guardrails');
const patternMiner = require('./intelligence/patternMiner');
const realBacktest = require('./backtest/realBacktest');
const mlModel = require('./intelligence/mlModel');
const limits = require('./risk/limits');
const auth = require('./security/auth');
const audit = require('./audit/audit');
const mode = require('./governance/mode');
const alerts = require('./ops/alerts');
const readiness = require('./governance/readiness');
const engineHealth = require('./engine/tradingEngine');

const app = express();
const PORT = process.env.PORT || 37492;
const ENV_PATH = path.join(__dirname, '..', '.env');

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
// Owner authentication: every API route needs the owner token, except the health check.
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.ip || 'unknown';
  if (auth.verify(req.get('X-Owner-Token'))) { auth.clearFailures(key); return next(); }
  const locked = auth.lockedFor(key);
  if (locked > 0) {
    res.set('Retry-After', String(Math.ceil(locked / 1000)));
    return res.status(429).json({ error: 'too many failed attempts; try again later' });
  }
  const f = auth.recordFailure(key);
  audit.record('AUTH_FAILED', { method: req.method, path: req.path, failures: f.count });
  if (f.count === auth.MAX_FAILURES) audit.record('AUTH_LOCKED', { minutes: auth.LOCK_MS / 60000 });
  res.status(401).json({ error: 'owner token required (X-Owner-Token header)' });
});
app.use((req, res, next) => {
  next();
});

// ============ SETUP & AUTH ============
app.get('/', async (req, res) => {
  try {
    const hasEnv = await fs.pathExists(ENV_PATH);
    const hasTokens = await ctraderAuth.isAuthenticated();
    if (!hasEnv || !hasTokens) return res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  } catch {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

// cTrader redirects here with ?code=... — the code is exchanged server-side, no copy/paste needed.
// cTrader redirects here with ?code=... — the code is exchanged server-side and the browser goes straight back to setup.
app.get('/callback', async (req, res) => {
  const result = await setupFlow.handleCallback(req.query);
  if (result.ok) return res.redirect('/setup.html?authorized=1');
  res.redirect(`/setup.html?error=${encodeURIComponent(result.message)}`);
});

app.get('/api/setup/config', (req, res) => res.json({ hasCredentials: setupFlow.hasCredentials() }));

app.post('/api/setup/start', (req, res) => {
  try {
    const { clientId, clientSecret } = req.body || {};
    res.json({ grantUrl: setupFlow.start(clientId, clientSecret) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/setup/status', (req, res) => res.json(setupFlow.getStatus()));

app.post('/api/setup/finish', async (req, res) => {
  try {
    const r = setupFlow.takeResult(req.body.accountId);
    await fs.writeFile(ENV_PATH, `CTRADER_CLIENT_ID=${r.clientId}
CTRADER_CLIENT_SECRET=${r.clientSecret}
CTRADER_REDIRECT_URI=http://127.0.0.1:37492/callback
CTRADER_ACCESS_TOKEN=${r.accessToken}
CTRADER_REFRESH_TOKEN=${r.refreshToken || ''}
CTRADER_ACCOUNT_ID=${r.accountId}
CTRADER_ENVIRONMENT=demo
`);
    await ctraderAuth.saveTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken, expiresIn: r.expiresIn });
    Object.assign(process.env, {
      CTRADER_CLIENT_ID: r.clientId,
      CTRADER_CLIENT_SECRET: r.clientSecret,
      CTRADER_ACCESS_TOKEN: r.accessToken,
      CTRADER_REFRESH_TOKEN: r.refreshToken || '',
      CTRADER_ACCOUNT_ID: r.accountId,
      CTRADER_ENVIRONMENT: 'demo'
    });
    // Connect right away so the owner never has to press a second button.
    const conn = await ctraderConn.connect();
    res.json({ success: true, state: conn.state, message: conn.message });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/ctrader-token', async (req, res) => {
  const { clientId, clientSecret, code, redirectUri } = req.body;
  let client = null;
  try {
    const tokenData = await ctraderAuth.requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret
    });
    client = new OpenApiClient('demo');
    await client.open();
    await client.applicationAuth(clientId, clientSecret);
    const accounts = (await client.getAccounts(tokenData.accessToken)).map(a => ({
      id: String(a.ctidTraderAccountId),
      isLive: !!a.isLive,
      traderLogin: a.traderLogin,
      broker: a.brokerTitleShort || null
    }));
    res.json({ ...tokenData, accounts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    if (client) client.close();
  }
});

app.post('/api/save-env', async (req, res) => {
  const { clientId, clientSecret, accessToken, refreshToken, expiresIn, accountId } = req.body;
  const envContent = `CTRADER_CLIENT_ID=${clientId}
CTRADER_CLIENT_SECRET=${clientSecret}
CTRADER_REDIRECT_URI=http://127.0.0.1:37492/callback
CTRADER_ACCESS_TOKEN=${accessToken}
CTRADER_REFRESH_TOKEN=${refreshToken || ''}
CTRADER_ACCOUNT_ID=${accountId}
CTRADER_ENVIRONMENT=demo
`;
  await fs.writeFile(ENV_PATH, envContent);
  await ctraderAuth.saveTokens({ accessToken, refreshToken, expiresIn });
  // Apply the new credentials to this running process without a restart.
  Object.assign(process.env, {
    CTRADER_CLIENT_ID: clientId,
    CTRADER_CLIENT_SECRET: clientSecret,
    CTRADER_ACCESS_TOKEN: accessToken,
    CTRADER_REFRESH_TOKEN: refreshToken || '',
    CTRADER_ACCOUNT_ID: String(accountId),
    CTRADER_ENVIRONMENT: 'demo'
  });
  res.json({ success: true });
});

// ============ CTRADER CONNECTION MANAGER ============
app.get('/api/ctrader/status', async (req, res) => {
  const status = ctraderConn.getStatus();
  status.authenticated = await ctraderAuth.isAuthenticated();
  status.providerErrors = require('./ctrader/providerErrors').snapshot();
  res.json(status);
});
app.post('/api/ctrader/connect', async (req, res) => {
  const from = ctraderConn.getStatus().state;
  const result = await ctraderConn.connect();
  audit.record('OWNER_CONNECT', { from, to: ctraderConn.getStatus().state });
  res.json(result);
});
app.post('/api/ctrader/disconnect', (req, res) => {
  const from = ctraderConn.getStatus().state;
  ctraderConn.disconnect();
  audit.record('OWNER_DISCONNECT', { from, to: ctraderConn.getStatus().state });
  res.json({ success: true });
});
app.post('/api/ctrader/logout', async (req, res) => {
  audit.record('OWNER_LOGOUT', { from: ctraderConn.getStatus().state });
  ctraderConn.forgetAuthorization();
  await ctraderAuth.clearTokens();
  res.json({ success: true, message: 'Tokens cleared — reauthorization required' });
});
app.get('/api/ctrader/account', async (req, res) => {
  try {
    const cfg = ctraderAuth.getConfig();
    if (!cfg.accountId) return res.status(400).json({ error: 'No account selected' });
    res.json(await ctraderConn.getTrader());
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});
app.get('/api/ctrader/open', (req, res) => {
  res.json({ url: 'https://ctrader.com/', message: 'Opening official cTrader platform — log in normally if required' });
});

// ============ AI FORECASTING ============
app.get('/api/forecast/:symbol', (req, res) => {
  const history = marketData.getHistory(req.params.symbol, 60);
  const f = forecaster.forecast(history);
  res.json({ symbol: req.params.symbol, ...f, accuracy: forecaster.getAccuracy() });
});

// ============ PERFORMANCE ANALYTICS ============
app.get('/api/analytics', async (req, res) => {
  res.json(await analytics.summary());
});

// ============ PREFERENCES & STATUS ============
app.get('/api/preferences', async (req, res) => res.json(await prefs.get()));
app.post('/api/preferences', async (req, res) => {
  const result = await prefs.set(req.body);
  if (req.body.tradingEnabled === true) engine.start(5000);
  if (req.body.tradingEnabled === false) engine.stop();
  res.json(result);
});
app.get('/api/status', async (req, res) => {
  const p = await prefs.get();
  res.json({
    tradingEnabled: p.tradingEnabled,
    autoStart: p.autoStart,
    liveMode: p.liveMode,
    engineStats: engine.getStats(),
    marketConnected: marketData.isConnected ? marketData.isConnected() : false
  });
});
app.post('/api/live/approve', async (req, res) => {
  res.json(await prefs.set({ liveMode: req.body.approved === true }));
});

// ============ MARKET DATA & SIGNALS ============
app.get('/api/prices', (req, res) => {
  const prices = {};
  marketData.getSymbols().forEach(s => prices[s] = marketData.getPrice(s));
  res.json(prices);
});
app.get('/api/signals', async (req, res) => res.json(await signalEngine.scanAll()));
app.get('/api/regimes', (req, res) => {
  const out = {};
  marketData.getSymbols().forEach(s => { out[s] = regimeDetector.classify(marketData.getHistory(s, 60)); });
  res.json(out);
});

// ============ CANDLESTICK PATTERNS & SUPPLY/DEMAND ============
app.get('/api/patterns/:symbol', (req, res) => {
  const history = marketData.getHistory(req.params.symbol, 60);
  const patterns = candlestickPatterns.detectAll(history);
  const strongest = patterns.filter(p => p.direction !== 'NEUTRAL').sort((a, b) => b.strength - a.strength)[0] || null;
  let confluence = null;
  if (strongest) {
    const confEngine = require('./intelligence/confluenceEngine');
    confluence = confEngine.scoreConfluence(history, strongest.direction, strongest.strength);
  }
  res.json({ symbol: req.params.symbol, patterns, strongest, confluence });
});
app.get('/api/zones/:symbol', (req, res) => {
  const history = marketData.getHistory(req.params.symbol, 60);
  const zones = supplyDemand.detectZones(history);
  res.json({ symbol: req.params.symbol, zones });
});

// ============ TRADES, POSITIONS, DECISIONS ============
app.get('/api/trades', async (req, res) => res.json(await storage.load('trades')));
app.get('/api/decisions', async (req, res) => res.json(await storage.load('decisions')));
app.get('/api/positions', async (req, res) => res.json(await riskManager.getOpenPositions()));

// ============ INTELLIGENCE TOOLS ============
app.get('/api/strategies', (req, res) => res.json(listStrategies()));
app.get('/api/adaptive/stats', async (req, res) => res.json(await adaptiveLearner.getStats()));
app.post('/api/backtest/run', (req, res) => {
  const { strategy, params, options } = req.body || {};
  if (strategy) res.json(backtest.runBacktest(strategy, params || {}, options || {}));
  else res.json(backtest.backtestAll(options || {}));
});
// Real cTrader bars instead of synthetic history; results feed the adaptive learner.
app.post('/api/backtest/live', async (req, res) => {
  try {
    const { options, learn } = req.body || {};
    const results = await realBacktest.runOnLiveHistory(options || {}, { learn: learn !== false });
    // The ML model learns from the new trades and reports whether it is good enough to act on.
    const model = await mlModel.retrain();
    res.json({ results, model });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.get('/api/ml/status', (req, res) => res.json(mlModel.status()));
app.post('/api/ml/retrain', async (req, res) => res.json(await mlModel.retrain()));
app.post('/api/optimize/run', (req, res) => {
  const { strategy, paramGrid, options } = req.body || {};
  if (strategy) res.json(optimizer.gridSearch(strategy, paramGrid || {}, options || {}));
  else res.json(optimizer.optimizeAll(options || {}));
});
app.post('/api/reports/generate', async (req, res) => res.json(await reportGenerator.generateAll()));
app.post('/api/shadows/evaluate', async (req, res) => res.json(await shadowTracker.evaluateShadows()));

// ============ SAFETY GUARDRAILS ============
app.get('/api/guardrails', async (req, res) => {
  const check = await guardrails.allowTrade('demo');
  res.json({ ...guardrails.fenceStatus(), limits: await guardrails.getLimits(), tradingAllowed: check.allow, blockReason: check.reason || null });
});
// Owner token rotation: the request itself needs the current token. The old token stops working immediately.
app.post('/api/auth/rotate', async (req, res) => {
  const token = await auth.rotate();
  audit.record('AUTH_ROTATED', {});
  res.json({ token, note: 'Store this token now. It is shown once and the previous token no longer works.' });
});
// Owner resumes new entries after a pause. Refused unless the last broker reconciliation succeeded.
app.post('/api/engine/entries/resume', async (req, res) => {
  const r = await require('./engine/entryPause').resume({ reconcileOk: engineHealth.reconcileStatus().lastReconcileOk === true, actor: 'owner' });
  res.status(r.resumed ? 200 : 409).json(r);
});
// Mark-to-market loss caps: owner reads and sets them; a latched cap is cleared only by an owner resume after reconciliation.
app.get('/api/risk/mtm', async (req, res) => res.json(await require('./risk/mtmCaps').status()));
// Unmanaged broker positions: read-only list with protection status, and owner resolutions (adopt, close, ignore).
app.get('/api/positions/unmanaged', async (req, res) => {
  const unmanagedMod = require('./execution/unmanaged');
  const trades = await storage.load('trades');
  const tracked = new Set(trades.filter(t => t.status === 'OPEN' && t.positionId !== undefined).map(t => Number(t.positionId)));
  let open = [];
  try { open = await require('./ctrader/trading').openPositions(); } catch (e) { return res.status(503).json({ error: e.message }); }
  const ignored = await unmanagedMod.ignoredIds();
  const list = open.filter(p => !tracked.has(Number(p.positionId))).map(p => ({ ...unmanagedMod.describe(p, id => require('./ctrader/marketFeed').nameForSymbolId(id)), ignored: ignored.has(String(p.positionId)) }));
  res.json({ unmanaged: list, resolutions: await unmanagedMod.resolutions() });
});
app.post('/api/positions/unmanaged/:positionId/resolve', async (req, res) => {
  const unmanagedMod = require('./execution/unmanaged');
  const trading = require('./ctrader/trading');
  const orderManager = require('./execution/orderManager');
  try {
    const open = await trading.openPositions();
    const trades = await storage.load('trades');
    const tracked = new Set(trades.filter(t => t.status === 'OPEN' && t.positionId !== undefined).map(t => Number(t.positionId)));
    const current = open.filter(p => !tracked.has(Number(p.positionId)));
    const { action, reason } = req.body || {};
    const r = await unmanagedMod.resolve({ positionId: req.params.positionId, action, reason, actor: 'owner', current, deps: { symbolFor: id => require('./ctrader/marketFeed').nameForSymbolId(id), recordAdopted: orderManager.recordAdopted, closeMarket: trading.closeMarket } });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Data gate: how many unexplained missing candles inside the lookback are tolerated before a block (default 0).
app.get('/api/data/gate', (req, res) => res.json({ gapTolerance: require('./data/quality').getGapTolerance() }));
app.post('/api/data/gate', async (req, res) => {
  try { res.json(await require('./data/quality').setGapTolerance((req.body || {}).gapTolerance, 'owner')); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/risk/mtm', async (req, res) => {
  try { res.json(await require('./risk/mtmCaps').setCaps(req.body || {}, 'owner')); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/risk/mtm/resume', async (req, res) => {
  const r = await require('./risk/mtmCaps').resume({ actor: 'owner', reconcileOk: engineHealth.reconcileStatus().lastReconcileOk === true });
  res.status(r.resumed ? 200 : 409).json(r);
});
// Owner shutdown: disables all new entries at once and records who, when, why and the system state. Positions are not closed.
app.get('/api/system/shutdown', async (req, res) => res.json({ active: await require('./governance/shutdown').current() }));
app.post('/api/system/shutdown', async (req, res) => {
  const rs = engineHealth.reconcileStatus();
  const snapshot = { at: new Date().toISOString(), brokerState: ctraderConn.getStatus().state, feedReady: require('./ctrader/marketFeed').isReady(), unresolved: rs.unresolved, unmanaged: rs.unmanaged, cycles: engineHealth.getStats().cycles };
  try {
    const r = await require('./governance/shutdown').request({ actor: 'owner', reason: (req.body || {}).reason, snapshot });
    res.status(r.alreadyActive ? 200 : 201).json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/system/shutdown/resume', async (req, res) => {
  const r = await require('./governance/shutdown').resume({ actor: 'owner', reconcileOk: engineHealth.reconcileStatus().lastReconcileOk === true });
  res.status(r.resumed ? 200 : 409).json(r);
});
app.post('/api/guardrails/acknowledge', async (req, res) => {
  const r = await guardrails.acknowledgeFence();
  audit.record('RECOVERY_ACKNOWLEDGED', {});
  res.json(r);
});

// ============ RISK LIMITS (owner-controlled, validated, proposal-based) ============
app.get('/api/risk', async (req, res) => res.json({ ...limits.describe(), emergency: await limits.emergencyState() }));
app.post('/api/risk/propose', async (req, res) => {
  try {
    const { key, value, enabled, rationale } = req.body || {};
    const p = await limits.propose({ key, value, enabled, rationale });
    audit.record('LIMIT_PROPOSED', { id: p.id, key, value, enabled: !!enabled });
    res.json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/risk/approve', async (req, res) => {
  try { const p = await limits.approve(req.body.id); audit.record('LIMIT_APPROVED', { id: p.id, key: p.key, value: p.value, enabled: p.enabled }); res.json(p); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/risk/reject', async (req, res) => {
  try { const p = await limits.reject(req.body.id); audit.record('LIMIT_REJECTED', { id: p.id, key: p.key }); res.json(p); } catch (e) { res.status(400).json({ error: e.message }); }
});
// Emergency stop: blocks every new entry at once. Exits and reconciliation continue.
app.post('/api/risk/emergency-stop', async (req, res) => {
  const { on, reason } = req.body || {};
  if (on === true && !(reason && reason.length >= 5)) return res.status(400).json({ error: 'Give a reason of at least 5 characters' });
  const s = await limits.setEmergencyStop(on === true, reason || '');
  audit.record(on === true ? 'EMERGENCY_STOP_ON' : 'EMERGENCY_STOP_OFF', { reason: reason || '' });
  res.json(s);
});
app.post('/api/guardrails/limits', async (req, res) => {
  try {
    res.json(await guardrails.setLimits(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============ PATTERN PROPOSALS ============
app.get('/api/proposals', (req, res) => res.json(patternMiner.list()));
app.post('/api/proposals/mine', async (req, res) => {
  const live = await patternMiner.liveClosedTrades();
  const backtested = await realBacktest.storedTrades();
  res.json(await patternMiner.mine(live, backtested));
});
app.post('/api/proposals/decide', async (req, res) => {
  try {
    const { key, decision } = req.body || {};
    res.json(await patternMiner.decide(key, decision));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/reports/generate', async (req, res) => res.json(await reportGenerator.generateAll()));
app.post('/api/shadows/evaluate', async (req, res) => res.json(await shadowTracker.evaluateShadows()));

// ============ OPERATIONS: HEALTH, READINESS, MODE, ALERTS, AUDIT ============
// Health is open so an external monitor can reach it; it reveals component states only, no secrets.
app.get('/api/health', (req, res) => {
  const rs = engineHealth.reconcileStatus();
  const v = audit.verify();
  res.json(readiness.health({
    brokerState: ctraderConn.getStatus().state,
    feedReady: require('./ctrader/marketFeed').isReady(),
    engineAgeMs: engineHealth.engineAgeMs(),
    lastReconcileOk: rs.lastReconcileOk,
    authConfigured: auth.configured(),
    auditOk: v.ok,
    auditBrokenAt: v.brokenAt
  }));
});

// Readiness: what AIS will and will not do right now, and why. The dashboard displays this.
app.get('/api/readiness', async (req, res) => {
  const em = await limits.emergencyState();
  const pref = await prefs.get();
  const rs = engineHealth.reconcileStatus();
  res.json(readiness.readiness({
    mode: mode.current(),
    allowsOrders: mode.allowsBrokerOrders(),
    emergencyOn: !!em.on,
    fenceActive: guardrails.fenceStatus().fenceActive,
    tradingEnabled: !!pref.tradingEnabled,
    brokerState: ctraderConn.getStatus().state,
    feedReady: require('./ctrader/marketFeed').isReady(),
    unresolved: rs.unresolved,
    unmanaged: rs.unmanaged,
    entriesPaused: require('./engine/entryPause').status().active
  }));
});

app.get('/api/mode', (req, res) => res.json(mode.describe()));
// DEMO_SUPERVISED: owner enables a session for a fixed number of hours (1 to 8). Expires back to OBSERVATION.
app.post('/api/mode/supervised', async (req, res) => {
  try {
    const { hours, confirm } = req.body || {};
    res.json(await mode.enableSupervised({ hours, confirm, actor: 'owner (API)' }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/mode', async (req, res) => {
  try {
    const { mode: target, confirm } = req.body || {};
    res.json(await mode.setMode(target, { confirm, source: 'owner (API)' }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/alerts', (req, res) => res.json(alerts.list()));
app.get('/api/audit/verify', (req, res) => res.json(audit.verify()));
app.get('/api/audit/recent', (req, res) => res.json(audit.recent(Math.min(500, Number(req.query.limit) || 50))));

// ============ START SERVER ============
let shuttingDown = false;
function requestShutdown() {
  shuttingDown = true;
  audit.record('SHUTDOWN_REQUESTED', {});
  process.exit(0);
}
// Only a deliberate stop counts as a clean shutdown; a crash leaves the recovery fence in place.
process.on('exit', () => { if (shuttingDown) guardrails.markCleanShutdown(); });
process.on('SIGINT', requestShutdown);
process.on('SIGTERM', requestShutdown);

(async () => {
  await prefs.init();
  await guardrails.init();
  await require('./engine/entryPause').init();
  await require('./data/quality').initGate();
  await patternMiner.init();
  await mlModel.init();
  await limits.init();
  const newToken = await auth.init();
  if (newToken) {
    console.log('[AUTH] Owner token created. It is shown ONCE. Copy it now; only a hash is stored:');
    console.log('[AUTH] ' + newToken);
    audit.record('OWNER_TOKEN_CREATED', {});
  }
  await mode.init();
  await alerts.init();
  audit.record('STARTUP', { mode: mode.current() });
  // Connects automatically and keeps the connection alive (unless the owner disconnected).
  ctraderConn.start().then(r => console.log(`[cTrader] ${r.state}: ${r.message || ''}`)).catch(() => {});
  if (await prefs.isEnabled()) {
    engine.start(5000);
  }
  app.listen(PORT, () => {
    console.log(`AIS Markets running → http://127.0.0.1:${PORT}`);
  });
})();