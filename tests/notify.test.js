const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-notify-'));
process.env.AIS_AUDIT_FILE = path.join(dir, 'audit.log');
const audit = require('../src/audit/audit');
const notify = require('../src/ops/notify');

const TOKEN = 'TEST_TOKEN_123456:ABCDEF';
const TG_ENV = { ALERT_TELEGRAM_BOT_TOKEN: TOKEN, ALERT_TELEGRAM_CHAT_ID: '42' };
const EMAIL_ENV = { ALERT_EMAIL_SMTP_HOST: 'smtp.example.test', ALERT_EMAIL_SMTP_PORT: '587', ALERT_EMAIL_FROM: 'ais@example.test', ALERT_EMAIL_TO: 'owner@example.test' };
const alert = (code = 'RISK_CAP_HIT', severity = 'critical') => ({ code, severity, message: 'daily cap hit' });
const okFetch = calls => async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; };
const failFetch = async () => ({ ok: false, status: 500 });
const transportOk = sent => ({ sendMail: async m => { sent.push(m); } });
const transportFail = { sendMail: async () => { throw new Error('smtp refused'); } };
const types = () => fs.readFileSync(audit.AUDIT_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('alerts are off until a channel is configured: nothing is sent', async () => {
  notify.resetForTests();
  assert.equal(notify.status({}).alertsEnabled, false);
  const r = await notify.onOpened(alert(), { env: {} });
  assert.equal(r.sent, false);
  assert.match(r.reason, /alerts off/);
});

test('Telegram is used first, with the token only in the request URL, never in the audit log', async () => {
  notify.resetForTests();
  const calls = [];
  const r = await notify.onOpened(alert('ENTRIES_PAUSED', 'high'), { env: TG_ENV, fetchImpl: okFetch(calls), now: 1000 });
  assert.equal(r.sent, true);
  assert.equal(r.channel, 'telegram');
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].body.chat_id, '42');
  assert.match(calls[0].body.text, /\[AIS HIGH\] ENTRIES_PAUSED/);
  const logged = fs.readFileSync(audit.AUDIT_FILE, 'utf8');
  assert.equal(logged.includes(TOKEN), false, 'the bot token is never in the audit log');
  assert.ok(types().some(e => e.type === 'ALERT_NOTIFIED' && e.fields.channel === 'telegram'));
});

test('when Telegram fails, email is the fallback', async () => {
  notify.resetForTests();
  const sent = [];
  const env = { ...TG_ENV, ...EMAIL_ENV };
  const r = await notify.onOpened(alert('STALE_DATA', 'high'), { env, fetchImpl: failFetch, transport: transportOk(sent), now: 2000 });
  assert.equal(r.sent, true);
  assert.equal(r.channel, 'email');
  assert.equal(sent[0].to, 'owner@example.test');
});

test('when both channels fail, the failure is audited and nothing is marked as sent', async () => {
  notify.resetForTests();
  const env = { ...TG_ENV, ...EMAIL_ENV };
  const r = await notify.onOpened(alert('UNMANAGED_POSITION'), { env, fetchImpl: failFetch, transport: transportFail, now: 3000 });
  assert.equal(r.sent, false);
  assert.match(r.reason, /telegram responded 500/);
  assert.ok(types().some(e => e.type === 'ALERT_NOTIFY_FAILED' && e.fields.code === 'UNMANAGED_POSITION'));
});

test('an alert that is still open is not sent again; after it resolves and reopens it is', async () => {
  notify.resetForTests();
  const calls = [];
  const f = okFetch(calls);
  const first = await notify.onOpened(alert('RECONCILE_FAILED', 'high'), { env: TG_ENV, fetchImpl: f, now: 10 * 60000 });
  assert.equal(first.sent, true);
  const dup = await notify.onOpened(alert('RECONCILE_FAILED', 'high'), { env: TG_ENV, fetchImpl: f, now: 40 * 60000 });
  assert.equal(dup.sent, false);
  assert.match(dup.reason, /duplicate/);
  notify.onResolved('RECONCILE_FAILED');
  const again = await notify.onOpened(alert('RECONCILE_FAILED', 'high'), { env: TG_ENV, fetchImpl: f, now: 60 * 60000 });
  assert.equal(again.sent, true);
});

test('the same code is rate-limited to one message per interval, even after resolving', async () => {
  notify.resetForTests();
  const f = okFetch([]);
  const t = 5 * 3600000;
  assert.equal((await notify.onOpened(alert('ENGINE_STALLED', 'high'), { env: TG_ENV, fetchImpl: f, now: t })).sent, true);
  notify.onResolved('ENGINE_STALLED');
  const soon = await notify.onOpened(alert('ENGINE_STALLED', 'high'), { env: TG_ENV, fetchImpl: f, now: t + 5 * 60000 });
  assert.equal(soon.sent, false);
  assert.match(soon.reason, /rate limited/);
  notify.onResolved('ENGINE_STALLED');
  const later = await notify.onOpened(alert('ENGINE_STALLED', 'high'), { env: TG_ENV, fetchImpl: f, now: t + notify.MIN_INTERVAL_MS + 1 });
  assert.equal(later.sent, true);
});

test('no more than twenty messages in any hour, across all codes', async () => {
  notify.resetForTests();
  const f = okFetch([]);
  const t = 9 * 3600000;
  for (let i = 0; i < notify.MAX_PER_HOUR; i++) {
    const r = await notify.onOpened(alert('CODE_' + i), { env: TG_ENV, fetchImpl: f, now: t + i * 1000 });
    assert.equal(r.sent, true, `message ${i + 1} sent`);
  }
  const over = await notify.onOpened(alert('CODE_OVER'), { env: TG_ENV, fetchImpl: f, now: t + 60000 });
  assert.equal(over.sent, false);
  assert.match(over.reason, /hourly alert limit/);
});

test('with nodemailer installed, email alone enables alerts, and sends through the configured transport', async () => {
  notify.resetForTests();
  const s = notify.status({ ...EMAIL_ENV });
  assert.equal(s.email, 'configured');
  assert.equal(s.alertsEnabled, true);
  const sent = [];
  const r = await notify.onOpened(alert('ENGINE_STALLED', 'high'), { env: EMAIL_ENV, fetchImpl: failFetch, transport: transportOk(sent), now: 7000 });
  assert.equal(r.sent, true);
  assert.equal(r.channel, 'email');
  assert.equal(sent[0].from, 'ais@example.test');
});

test('email without a transport and without SMTP settings is refused, not faked', async () => {
  await assert.rejects(notify.sendEmail('subject', 'text', { env: {} }), /email not configured/);
});

test('status never shows a credential value', () => {
  const s = JSON.stringify(notify.status({ ...TG_ENV, ...EMAIL_ENV, ALERT_EMAIL_SMTP_PASS: 'secret-pass' }));
  assert.equal(s.includes(TOKEN), false);
  assert.equal(s.includes('secret-pass'), false);
});

test('a network error that echoes the request URL never leaks the bot token into the audit log', async () => {
  notify.resetForTests();
  const leaky = async url => { throw new Error(`request to ${url} failed`); };
  const r = await notify.onOpened(alert('LEAK_TEST', 'high'), { env: TG_ENV, fetchImpl: leaky, transport: null, now: 8000 });
  assert.equal(r.sent, false);
  assert.equal(fs.readFileSync(audit.AUDIT_FILE, 'utf8').includes(TOKEN), false, 'the token is not in the audit log');
  assert.equal(String(r.reason).includes(TOKEN), false, 'nor in the returned reason');
});
