// Automatic cTrader authorization: the browser callback carries the code, the server exchanges it,
// and the setup page polls for the result — no manual copy/paste.
const auth = require('./auth');
const { OpenApiClient } = require('./openApiClient');

const PENDING_TTL_MS = 10 * 60 * 1000;
let pending = null; // { clientId, clientSecret, state, tokens, accounts, error, createdAt }

function expireIfStale() {
  if (pending && Date.now() - pending.createdAt > PENDING_TTL_MS) pending = null;
}

// Called by the setup page before it opens the grant link. Uses saved .env credentials when none are given.
// Returns the URL to open.
function start(clientId, clientSecret) {
  const cfg = auth.getConfig();
  const id = clientId || cfg.clientId;
  const secret = clientSecret || cfg.clientSecret;
  if (!id || !secret) throw new Error('Client ID and Secret are required');
  pending = { clientId: id, clientSecret: secret, state: 'waiting', tokens: null, accounts: [], error: null, createdAt: Date.now() };
  return auth.buildGrantUrl(id, cfg.redirectUri);
}

function hasCredentials() {
  const cfg = auth.getConfig();
  return !!(cfg.clientId && cfg.clientSecret);
}

// Called by the /callback route with the query parameters cTrader sent back.
async function handleCallback({ code, error, error_description: description }) {
  expireIfStale();
  if (error) {
    if (pending) Object.assign(pending, { state: 'error', error: `${error}${description ? ` — ${description}` : ''}` });
    return { ok: false, message: `Authorization was not granted: ${error}` };
  }
  if (!code) return { ok: false, message: 'No authorization code received' };

  // Use the setup session's credentials if one is open, otherwise the saved .env credentials.
  const cfg = auth.getConfig();
  const clientId = pending?.clientId || cfg.clientId;
  const clientSecret = pending?.clientSecret || cfg.clientSecret;
  if (!clientId || !clientSecret) return { ok: false, message: 'Client ID/Secret not set — start setup first' };

  let client = null;
  try {
    const tokens = await auth.requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
      client_id: clientId,
      client_secret: clientSecret
    });
    client = new OpenApiClient('demo');
    await client.open();
    await client.applicationAuth(clientId, clientSecret);
    const accounts = (await client.getAccounts(tokens.accessToken)).map(a => ({
      id: String(a.ctidTraderAccountId),
      isLive: !!a.isLive,
      traderLogin: a.traderLogin,
      broker: a.brokerTitleShort || null
    }));
    if (!pending) pending = { clientId, clientSecret, createdAt: Date.now() };
    Object.assign(pending, { state: 'ready', tokens, accounts, error: null });
    return { ok: true, message: 'Authorization received' };
  } catch (e) {
    if (!pending) pending = { clientId, clientSecret, createdAt: Date.now() };
    Object.assign(pending, { state: 'error', tokens: null, accounts: [], error: e.message });
    return { ok: false, message: e.message };
  } finally {
    if (client) client.close();
  }
}

function getStatus() {
  expireIfStale();
  if (!pending) return { state: 'idle' };
  return { state: pending.state, accounts: pending.accounts, error: pending.error };
}

// Returns the pending tokens and credentials once the owner has picked an account.
function takeResult(accountId) {
  expireIfStale();
  if (!pending || pending.state !== 'ready') throw new Error('No completed authorization — start setup again');
  if (!pending.accounts.some(a => a.id === String(accountId))) throw new Error(`Account ${accountId} was not granted to this authorization`);
  const result = {
    clientId: pending.clientId,
    clientSecret: pending.clientSecret,
    accessToken: pending.tokens.accessToken,
    refreshToken: pending.tokens.refreshToken,
    expiresIn: pending.tokens.expiresIn,
    accountId: String(accountId)
  };
  pending = null;
  return result;
}

module.exports = { start, hasCredentials, handleCallback, getStatus, takeResult };
