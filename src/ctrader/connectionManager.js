const path = require('path');
const fs = require('fs-extra');
const auth = require('./auth');
const { OpenApiClient } = require('./openApiClient');
const marketFeed = require('./marketFeed');
const limits = require('../risk/limits');

const STATE = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  APP_AUTHENTICATED: 'APP_AUTHENTICATED',
  ACCOUNT_AUTHENTICATED: 'ACCOUNT_AUTHENTICATED',
  ERROR: 'ERROR'
};

const CHOICE_FILE = path.join(__dirname, '../../data/ctrader_connection.json');
const WATCHDOG_MS = 30000;
const MAX_BACKOFF_MS = 30000;

let state = STATE.DISCONNECTED;
let lastError = null;
let needsAuth = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let watchdogTimer = null;
let authInProgress = false;
let client = null;

// The owner's choice: stay connected (true) or stay disconnected until they connect again (false).
function readAutoConnect() {
  try {
    const saved = fs.readJsonSync(CHOICE_FILE);
    return saved.autoConnect !== false;
  } catch {
    return true;
  }
}

function writeAutoConnect(value) {
  fs.ensureDirSync(path.dirname(CHOICE_FILE));
  fs.writeJsonSync(CHOICE_FILE, { autoConnect: value, updatedAt: new Date().toISOString() }, { spaces: 2 });
}

// Token/authorization problems need the owner to re-authorize; network problems are retried.
function isAuthError(message) {
  return /TOKEN|ACCESS_DENIED|reauthorization|not authorized/i.test(message || '');
}

let balance = null;       // { amount, updatedAt } from the trader record
let balanceAt = 0;

function closeClient() {
  marketFeed.stop();
  if (client) { client.close(); client = null; }
}

function getClient() {
  if (!client) throw new Error('Not connected to cTrader');
  return client;
}

function getBalance() {
  return balance;
}

async function refreshBalance() {
  const cfg = auth.getConfig();
  const trader = await client.getTrader(Number(cfg.accountId));
  const digits = trader.moneyDigits || 2;
  balance = { amount: Math.round(Number(trader.balance) / Math.pow(10, digits) * 100) / 100, updatedAt: new Date().toISOString() };
  balanceAt = Date.now();
  limits.recordEquity(balance.amount).catch(() => {});
}

function toAccountSummary(a) {
  return {
    id: String(a.ctidTraderAccountId),
    isLive: !!a.isLive,
    traderLogin: a.traderLogin,
    broker: a.brokerTitleShort || null
  };
}

// One connection attempt. Does not change the owner's autoConnect choice.
async function attemptConnect() {
  if (authInProgress) return { state, message: 'Authentication already in progress' };
  authInProgress = true;
  closeClient();
  try {
    state = STATE.CONNECTING;
    const cfg = auth.getConfig();
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('Client ID/Secret missing — check .env');

    const accessToken = await auth.getValidAccessToken();
    if (!accessToken) {
      state = STATE.DISCONNECTED;
      needsAuth = true;
      return { state, message: 'Not authorized — complete OAuth setup first', needsAuth: true };
    }

    client = new OpenApiClient(cfg.environment, { onClose: onSocketClosed });
    await client.open();
    await client.applicationAuth(cfg.clientId, cfg.clientSecret);
    state = STATE.APP_AUTHENTICATED;

    const accounts = (await client.getAccounts(accessToken)).map(toAccountSummary);

    if (!cfg.accountId) {
      closeClient();
      state = STATE.DISCONNECTED;
      needsAuth = false;
      return { state, message: 'App authenticated — select an account', accounts };
    }

    const target = accounts.find(a => a.id === String(cfg.accountId));
    if (!target) throw new Error(`Account ${cfg.accountId} is not granted to this access token`);
    const wantLive = cfg.environment === 'live';
    if (target.isLive !== wantLive) {
      throw new Error(`Account ${cfg.accountId} is ${target.isLive ? 'live' : 'demo'} but CTRADER_ENVIRONMENT=${cfg.environment}`);
    }

    await client.accountAuth(Number(cfg.accountId), accessToken);
    const trader = await client.getTrader(Number(cfg.accountId));
    const digits = trader.moneyDigits || 2;
    balance = { amount: Math.round(Number(trader.balance) / Math.pow(10, digits) * 100) / 100, updatedAt: new Date().toISOString() };
    balanceAt = Date.now();
    limits.recordEquity(balance.amount).catch(() => {});
    await marketFeed.start(client, Number(cfg.accountId));
    state = STATE.ACCOUNT_AUTHENTICATED;
    reconnectAttempts = 0;
    lastError = null;
    needsAuth = false;
    return { state, message: `Connected to ${cfg.environment} account ${cfg.accountId}`, account: trader };
  } catch (e) {
    lastError = e.message;
    closeClient();
    if (isAuthError(e.message)) {
      state = STATE.DISCONNECTED;
      needsAuth = true;
      return { state, message: e.message, needsAuth: true };
    }
    state = STATE.ERROR;
    scheduleReconnect();
    return { state, message: e.message, reconnecting: true };
  } finally {
    authInProgress = false;
  }
}

// Owner-initiated connect: also records that the owner wants to stay connected.
async function connect() {
  writeAutoConnect(true);
  cancelReconnect();
  needsAuth = false;
  return attemptConnect();
}

function onSocketClosed(err) {
  if (!readAutoConnect()) return;
  lastError = err.message;
  if (isAuthError(err.message)) { needsAuth = true; state = STATE.DISCONNECTED; return; }
  state = STATE.ERROR;
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer || !readAutoConnect()) return;
  reconnectAttempts++;
  const delay = Math.min(MAX_BACKOFF_MS, 5000 * Math.pow(2, reconnectAttempts - 1));
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (readAutoConnect()) await attemptConnect();
  }, delay);
}

function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;
}

// Safety net: if the owner wants a connection and we are not connected, keep trying.
async function watchdog() {
  if (!readAutoConnect() || needsAuth) return;
  if (state === STATE.ACCOUNT_AUTHENTICATED) {
    if (Date.now() - balanceAt > 60000) await refreshBalance().catch(() => {});
    return;
  }
  if (state === STATE.CONNECTING || authInProgress || reconnectTimer) return;
  await attemptConnect();
}

// Called once at server start.
function start() {
  if (!watchdogTimer) watchdogTimer = setInterval(() => { watchdog().catch(() => {}); }, WATCHDOG_MS);
  if (readAutoConnect()) return attemptConnect();
  return Promise.resolve({ state, message: 'Owner disconnected — not connecting automatically' });
}

// Returns the live trader/account record for the configured account.
async function getTrader() {
  const cfg = auth.getConfig();
  if (state !== STATE.ACCOUNT_AUTHENTICATED || !client) throw new Error('Not connected to cTrader');
  return client.getTrader(Number(cfg.accountId));
}

// Owner pauses the connection. Tokens are kept; the connection stays off until the owner connects again.
function disconnect() {
  writeAutoConnect(false);
  cancelReconnect();
  closeClient();
  state = STATE.DISCONNECTED;
  authInProgress = false;
}

// Called after the tokens are cleared: the owner must authorize again before anything connects.
function forgetAuthorization() {
  disconnect();
  needsAuth = true;
}

function getStatus() {
  return {
    state,
    lastError,
    reconnectAttempts,
    needsAuth,
    autoConnect: readAutoConnect(),
    balance: balance ? balance.amount : null,
    liveFeed: marketFeed.isReady(),
    authenticated: state === STATE.ACCOUNT_AUTHENTICATED
  };
}

module.exports = { connect, disconnect, forgetAuthorization, getStatus, getTrader, getClient, getBalance, start, STATE };
