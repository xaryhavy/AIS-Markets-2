// Owner alert channels (decision 9). Telegram first; email as the fallback. Alerts are OFF until a channel is configured.
// Credentials come only from environment variables and are never written to source, logs or audit records.
//   Telegram: ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID
//   Email:    ALERT_EMAIL_SMTP_HOST, ALERT_EMAIL_SMTP_PORT, ALERT_EMAIL_SMTP_USER, ALERT_EMAIL_SMTP_PASS,
//             ALERT_EMAIL_FROM, ALERT_EMAIL_TO      (needs the nodemailer package installed; see status())
// Rate limit: at most one message per alert code every MIN_INTERVAL_MS, and at most MAX_PER_HOUR in total.
// Dedupe: a code that is still open is not sent again until it resolves and reopens.
const audit = require('../audit/audit');

const MIN_INTERVAL_MS = 15 * 60000;
const MAX_PER_HOUR = 20;
const sentOpen = new Set();
const lastSentAt = {};
const sentTimes = [];

function telegramConfig(env = process.env) {
  const token = env.ALERT_TELEGRAM_BOT_TOKEN, chatId = env.ALERT_TELEGRAM_CHAT_ID;
  return token && chatId ? { token, chatId } : null;
}

function emailConfig(env = process.env) {
  const keys = ['ALERT_EMAIL_SMTP_HOST', 'ALERT_EMAIL_SMTP_PORT', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO'];
  return keys.every(k => env[k]) ? {
    host: env.ALERT_EMAIL_SMTP_HOST, port: Number(env.ALERT_EMAIL_SMTP_PORT),
    user: env.ALERT_EMAIL_SMTP_USER, pass: env.ALERT_EMAIL_SMTP_PASS,
    from: env.ALERT_EMAIL_FROM, to: env.ALERT_EMAIL_TO
  } : null;
}

function emailLibraryPresent() {
  try { require.resolve('nodemailer'); return true; } catch { return false; }
}

// What is configured, without any secret value.
function status(env = process.env) {
  const tg = !!telegramConfig(env);
  const em = !!emailConfig(env);
  return {
    telegram: tg ? 'configured' : 'not configured',
    email: !em ? 'not configured' : (emailLibraryPresent() ? 'configured' : 'configured, but the nodemailer package is not installed'),
    alertsEnabled: tg || (em && emailLibraryPresent())
  };
}

// Sends through Telegram. Uses the injected fetch in tests.
async function sendTelegram(text, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const cfg = telegramConfig(env);
  if (!cfg) throw new Error('telegram not configured');
  const res = await fetchImpl(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true })
  });
  if (!res.ok) throw new Error(`telegram responded ${res.status}`);
  return { channel: 'telegram' };
}

// Sends through email. Needs nodemailer; reports clearly when it is missing.
async function sendEmail(subject, text, { env = process.env, transport = null } = {}) {
  const cfg = emailConfig(env);
  if (!cfg) throw new Error('email not configured');
  let t = transport;
  if (!t) {
    if (!emailLibraryPresent()) throw new Error('email fallback unavailable: the nodemailer package is not installed');
    const nodemailer = require('nodemailer');
    t = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined });
  }
  await t.sendMail({ from: cfg.from, to: cfg.to, subject, text });
  return { channel: 'email' };
}

// Called when an alert opens. Never throws: notification failure must not break the engine.
async function onOpened(alert, { now = Date.now(), env = process.env, fetchImpl, transport } = {}) {
  const st = status(env);
  if (!st.alertsEnabled) return { sent: false, reason: 'alerts off: no channel configured' };
  if (sentOpen.has(alert.code)) return { sent: false, reason: 'duplicate of an open alert' };
  if (lastSentAt[alert.code] && now - lastSentAt[alert.code] < MIN_INTERVAL_MS) return { sent: false, reason: 'rate limited for this alert code' };
  const hour = sentTimes.filter(t => now - t < 3600000);
  if (hour.length >= MAX_PER_HOUR) return { sent: false, reason: 'hourly alert limit reached' };
  const subject = `[AIS ${String(alert.severity).toUpperCase()}] ${alert.code}`;
  const text = `${subject}\n${alert.message}\nAt ${new Date(now).toISOString()}`;
  let delivered = null;
  const errors = [];
  try { delivered = await sendTelegram(text, { env, fetchImpl }); } catch (e) { errors.push(e.message); }
  if (!delivered) {
    try { delivered = await sendEmail(subject, text, { env, transport }); } catch (e) { errors.push(e.message); }
  }
  if (!delivered) {
    audit.record('ALERT_NOTIFY_FAILED', { code: alert.code, reason: errors.join('; ') });
    return { sent: false, reason: errors.join('; ') };
  }
  sentOpen.add(alert.code);
  lastSentAt[alert.code] = now;
  sentTimes.push(now);
  audit.record('ALERT_NOTIFIED', { code: alert.code, channel: delivered.channel });
  return { sent: true, channel: delivered.channel };
}

// Called when an alert resolves. Clears dedupe so a later reopening is sent again.
function onResolved(code) {
  sentOpen.delete(code);
}

function resetForTests() {
  sentOpen.clear();
  for (const k of Object.keys(lastSentAt)) delete lastSentAt[k];
  sentTimes.length = 0;
}

module.exports = { status, sendTelegram, sendEmail, onOpened, onResolved, telegramConfig, emailConfig, resetForTests, MIN_INTERVAL_MS, MAX_PER_HOUR };
