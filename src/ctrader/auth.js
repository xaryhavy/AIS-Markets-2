const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const TOKEN_FILE = path.join(__dirname, '../../data/ctrader_tokens.json');
// Official cTrader Open API token endpoint (GET with query parameters).
const TOKEN_URL = 'https://openapi.ctrader.com/apps/token';
// Grant-access page the owner opens to authorise AIS for their cTrader account.
const GRANT_URL = 'https://id.ctrader.com/my/settings/openapi/grantingaccess/';

function getConfig() {
  return {
    clientId: process.env.CTRADER_CLIENT_ID,
    clientSecret: process.env.CTRADER_CLIENT_SECRET,
    redirectUri: process.env.CTRADER_REDIRECT_URI || 'http://127.0.0.1:37492/callback',
    environment: process.env.CTRADER_ENVIRONMENT || 'demo',
    accountId: process.env.CTRADER_ACCOUNT_ID
  };
}

function buildGrantUrl(clientId, redirectUri, scope = 'trading') {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope, product: 'web' });
  return `${GRANT_URL}?${params}`;
}

// Token response fields are camelCase: accessToken, refreshToken, expiresIn, tokenType, errorCode, description.
async function saveTokens(tokens) {
  await fs.ensureDir(path.dirname(TOKEN_FILE));
  await fs.writeJson(TOKEN_FILE, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + (tokens.expiresIn || 2592000) * 1000,
    tokenType: tokens.tokenType || 'bearer'
  }, { spaces: 2 });
}

async function loadTokens() {
  if (await fs.pathExists(TOKEN_FILE)) return fs.readJson(TOKEN_FILE);
  // Fall back to tokens saved in .env (no expiry known — the API decides validity).
  const accessToken = process.env.CTRADER_ACCESS_TOKEN;
  if (accessToken) {
    return { accessToken, refreshToken: process.env.CTRADER_REFRESH_TOKEN || null, expiresAt: null, tokenType: 'bearer' };
  }
  return null;
}

async function clearTokens() {
  if (await fs.pathExists(TOKEN_FILE)) await fs.remove(TOKEN_FILE);
}

async function requestToken(params) {
  const url = `${TOKEN_URL}?${new URLSearchParams(params)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errorCode || !data.accessToken) {
    const reason = data.errorCode || `HTTP ${res.status}`;
    throw new Error(`Token request failed: ${reason} — ${data.description || ''}`.trim());
  }
  return data;
}

async function exchangeCode(code) {
  const cfg = getConfig();
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('Client ID/Secret not configured');
  const data = await requestToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret
  });
  await saveTokens(data);
  return data;
}

async function refreshAccessToken() {
  const cfg = getConfig();
  const tokens = await loadTokens();
  if (!tokens?.refreshToken) throw new Error('No refresh token — reauthorization required');
  try {
    const data = await requestToken({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret
    });
    await saveTokens(data);
    return { success: true };
  } catch (e) {
    await clearTokens();
    throw new Error(`Refresh failed — reauthorization required (${e.message})`);
  }
}

async function getValidAccessToken() {
  const tokens = await loadTokens();
  if (!tokens) return null;
  if (tokens.expiresAt && Date.now() > tokens.expiresAt - 60000) {
    try { await refreshAccessToken(); return (await loadTokens()).accessToken; }
    catch { return null; }
  }
  return tokens.accessToken;
}

async function isAuthenticated() {
  try { const t = await loadTokens(); return !!t?.accessToken; }
  catch { return false; }
}

module.exports = { getConfig, buildGrantUrl, requestToken, exchangeCode, refreshAccessToken, getValidAccessToken, isAuthenticated, clearTokens, loadTokens, saveTokens };
