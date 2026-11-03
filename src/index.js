// Load the .env that sits next to this project, whatever the working directory is (a preview or a service may start elsewhere).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
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
const session = require('express-session');
const auth = require('./security/auth');
const audit = require('./audit/audit');
const mode = require('./governance/mode');
const alerts = require('./ops/alerts');
const readiness = require('./governance/readiness');
const engineHealth = require('./engine/tradingEngine');

const app = express();
// Express 4 does not catch errors from async handlers. Record them and keep the process running.
process.on('unhandledRejection', (err) => {
  console.log('[ERROR] unhandled: ' + (err && err.message ? err.message : String(err)));
  try { audit.record('UNHANDLED_ERROR', { message: String(err && err.message ? err.message : err).slice(0, 300) }); } catch {}
});
const PORT = process.env.PORT || 37492;
const ENV_PATH = path.join(__dirname, '..', '.env');

// A known-default session secret would let anyone who read this file forge a sign-in cookie. Use the
// environment when it is set, else a random secret generated once and kept in the data folder.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // Same data folder rule as the storage layer, so a test run never writes into the live data directory.
  const file = path.join(process.env.AIS_DATA_DIR || path.join(__dirname, '..', 'data'), 'session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const secret = require('crypto').randomBytes(32).toString('hex');
  fs.ensureDirSync(path.dirname(file));
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

app.use(bodyParser.json());
app.use(session({
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 24 * 60 * 60 * 1000 },
}));
// Pages are private except the sign-in page. A static file handed out before the session check would
// expose the dashboard and setup page to anyone who can reach the port.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_PAGES = new Set(['/login.html']);
const serveStatic = express.static(PUBLIC_DIR);
app.use((req, res, next) => {
  if (STATIC_PAGES.has(req.path)) return serveStatic(req, res, next);
  if (req.session && req.session.user) return serveStatic(req, res, next);
  // A page request for a private page lands on sign-in; anything else keeps its normal 404.
  if (req.path === '/' || req.path === '/index.html' || req.path === '/setup.html') {
    return res.redirect('/login.html');
  }
  next();
});
// Session-based sign-in: every API route except health and auth setup/login needs a session.
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (req.path.startsWith('/auth/')) return next();
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Please sign in', needsAuth: true });
});
app.use((req, res, next) => {
  next();
});

// ============ SIGN-IN (session-based) ============
app.get('/api/auth/status', (req, res) => {
  res.json({ configured: auth.configured(), hasUser: auth.configured(), username: auth.getUsername(), loggedIn: !!(req.session && req.session.user) });
});

app.post('/api/auth/setup', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = await auth.createUser(username, password);
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.user = { username: result.username };
      audit.record('USER_CREATED', { username: result.username });
      audit.record('LOGIN_SUCCESS', { username: result.username });
      res.json({ ok: true, username: result.username });
    });
  } catch (e) {
    // createUser throws if already configured — check if it's the "already exists" case
    if (e.message.includes('already exists')) return res.status(409).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const key = auth.failureKey(req.ip, username);
  if (auth.lockedFor(key) > 0) {
    res.set('Retry-After', String(Math.ceil(auth.lockedFor(key) / 1000)));
    return res.status(429).json({ error: 'Too many failed attempts; try again later' });
  }
  if (!auth.configured()) return res.status(400).json({ error: 'No account yet — please create one first' });
  if (!auth.verify(username, password)) {
    const f = auth.recordFailure(key);
    audit.record('LOGIN_FAILED', { username: (username || '').slice(0, 32), ip: req.ip, failures: f.count });
    if (f.count === auth.MAX_FAILURES) audit.record('LOGIN_LOCKED', { minutes: auth.LOCK_MS / 60000 });
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  auth.clearFailures(key);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.user = { username: auth.getUsername() };
    audit.record('LOGIN_SUCCESS', { username: auth.getUsername() });
    res.json({ ok: true, username: auth.getUsername() });
  });
});

app.post('/api/auth/logout', (req, res) => {
  const username = req.session && req.session.user ? req.session.user.username : null;
  req.session.destroy(err => {
    if (username) audit.record('LOGOUT', { username });
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) return res.json({ loggedIn: true, username: req.session.user.username });
  res.json({ loggedIn: false });
});

app.post('/api/auth/change-password', async (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Please sign in' });
  try {
    const { oldPassword, newPassword } = req.body || {};
    await auth.changePassword(req.session.user.username, oldPassword, newPassword);
    audit.record('PASSWORD_CHANGED', { username: req.session.user.username });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============ SETUP & AUTH ============
app.get('/', async (req, res) => {
  try {
    const hasEnv = await fs.pathExists(ENV_PATH);
    const hasTokens = await ctraderAuth.isAuthenticated();
    // Sign-in is the gate for every page. No account yet, or no session, means the sign-in page.
    if (!auth.configured() || !(req.session && req.session.user)) return res.redirect('/login.html');
    // With a session in hand, a missing cTrader connection leads to the setup page.
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
  try {
    const result = await prefs.set(req.body || {});
    if (req.body.tradingEnabled === true) engine.start(5000);
    if (req.body.tradingEnabled === false) engine.stop();
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
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
// Live trading is locked in this build. The request is refused and audited; it cannot switch anything on.
app.post('/api/live/approve', async (req, res) => {
  audit.record('LIVE_APPROVAL_REFUSED', { requested: req.body && req.body.approved === true });
  res.status(409).json({ error: 'live trading is locked in this build; it needs a separate readiness review and explicit authorisation' });
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

// ============ STRATEGY REGISTRY ============
// The engine runs a strategy only when its current version is APPROVED and DEPLOYED. Approval names the
// content hash it covers, so a change to the rules or the strategy's own code needs a new approval.
const strategyRegistry = require('./strategy/registry');
const baseline = require('./strategy/baseline');

app.get('/api/strategies/registry', async (req, res) => {
  try {
    res.json(await strategyRegistry.all());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// What the engine would and would not run right now, with the reason for each.
app.get('/api/strategies/registry/gate', async (req, res) => {
  try {
    await baseline.ensure();
    const gates = {};
    for (const name of listStrategies()) gates[name] = await strategyRegistry.gate(name);
    res.json({ runnable: await strategyRegistry.runnableNames(), gates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Registers rules as a new version. Identical content returns the existing version and changes nothing.
app.post('/api/strategies/registry/register', async (req, res) => {
  const { strategy, rules, reason } = req.body || {};
  if (!strategy || !rules) return res.status(400).json({ error: 'strategy and rules are required' });
  try {
    const result = await strategyRegistry.register(strategy, rules, { actor: 'owner', reason: reason || 'registered by owner' });
    audit.record('STRATEGY_REGISTERED', { strategy, version: result.record.version, hash: result.record.hash, created: result.created });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/strategies/registry/approve', async (req, res) => {
  const { strategy, version, hash, reason } = req.body || {};
  try {
    const record = await strategyRegistry.approve(strategy, version, hash, { actor: 'owner', reason });
    audit.record('STRATEGY_APPROVED', { strategy, version, hash: record.hash, reason });
    res.json(record);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/strategies/registry/deploy', async (req, res) => {
  const { strategy, version, reason } = req.body || {};
  try {
    const record = await strategyRegistry.deploy(strategy, version, { actor: 'owner', reason });
    audit.record('STRATEGY_DEPLOYED', { strategy, version, hash: record.hash, reason });
    signalEngine.resetBaseline();
    res.json(record);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/strategies/registry/retire', async (req, res) => {
  const { strategy, version, reason } = req.body || {};
  try {
    const record = await strategyRegistry.retire(strategy, version, { actor: 'owner', reason });
    audit.record('STRATEGY_RETIRED', { strategy, version, reason });
    signalEngine.resetBaseline();
    res.json(record);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/adaptive/stats', async (req, res) => res.json(await adaptiveLearner.getStats()));
// Synthetic development runs. Every result carries dataSource: 'SYNTHETIC' and its cost model, so it can
// never be read as broker evidence. Costs and the ambiguity policy may be supplied explicitly.
app.post('/api/backtest/run', (req, res) => {
  const { strategy, params, options, costs, ambiguityPolicy } = req.body || {};
  const opts = { ...(options || {}), ...(costs ? { costs } : {}), ...(ambiguityPolicy ? { ambiguityPolicy } : {}) };
  try {
    if (strategy) res.json(backtest.runBacktest(strategy, params || {}, opts));
    else res.json(backtest.backtestAll(opts));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// Real cTrader bars instead of synthetic history; results feed the adaptive learner.
app.post('/api/backtest/live', async (req, res) => {
  try {
    const { options, learn, costs, ambiguityPolicy } = req.body || {};
    const opts = { ...(options || {}), ...(costs ? { costs } : {}), ...(ambiguityPolicy ? { ambiguityPolicy } : {}) };
    const results = await realBacktest.runOnLiveHistory(opts, { learn: learn !== false });
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
  const { strategy, paramGrid, options, costs, ambiguityPolicy } = req.body || {};
  const opts = { ...(options || {}), ...(costs ? { costs } : {}), ...(ambiguityPolicy ? { ambiguityPolicy } : {}) };
  try {
    if (strategy) res.json(optimizer.gridSearch(strategy, paramGrid || {}, opts));
    else res.json(optimizer.optimizeAll(opts));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/reports/generate', async (req, res) => res.json(await reportGenerator.generateAll()));
app.post('/api/shadows/evaluate', async (req, res) => res.json(await shadowTracker.evaluateShadows()));

// ============ SAFETY GUARDRAILS ============
app.get('/api/guardrails', async (req, res) => {
  const check = await guardrails.allowTrade('demo');
  res.json({ ...guardrails.fenceStatus(), limits: await guardrails.getLimits(), tradingAllowed: check.allow, blockReason: check.reason || null });
});
// Password change lives with the other sign-in routes, above.
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
// Legacy simulated trades: dry run, archive (tag, never delete), and rollback of the tags.
app.get('/api/legacy/plan', async (req, res) => res.json(await require('./data/legacyArchive').plan()));
app.post('/api/legacy/archive', async (req, res) => {
  try { res.json(await require('./data/legacyArchive').apply({ actor: 'owner' })); } catch (e) { res.status(409).json({ error: e.message }); }
});
app.post('/api/legacy/archive/rollback', async (req, res) => {
  try { res.json(await require('./data/legacyArchive').rollback({ actor: 'owner' })); } catch (e) { res.status(409).json({ error: e.message }); }
});
// Decision records (item 6): read-only inventory, legacy tag plan, compaction dry run and its log. No apply route exists.
app.get('/api/decisions/formats', async (req, res) => {
  const lf = require('./governance/legacyFormats');
  res.json(lf.inventory(await storage.load('decisions'), await storage.load('no_trade_outcomes')));
});
app.get('/api/decisions/compaction/plan', async (req, res) => res.json(await require('./governance/compaction').plan({ retentionDays: Number(req.query.retentionDays) || 30 })));
app.get('/api/decisions/compaction/log', async (req, res) => res.json(await storage.load('decision_compaction_dryrun_log')));
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
    const { key, decision, reason } = req.body || {};
    res.json(await patternMiner.decide(key, decision, reason));
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
    authConfigured: auth.configured(), // sign-in account configured
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
    entriesPaused: require('./engine/entryPause').status().active,
    entriesPausedReason: require('./engine/entryPause').status().reason,
    entriesPausedCause: require('./engine/entryPause').status().cause
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
  await auth.init();
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