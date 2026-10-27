# Owner alert setup (Telegram first, email fallback)

Status: **Telegram unverified against a live bot.** The code path is tested with a mock transport and a fake token (the live API answered 401, as expected for a fake token). It is not verified until a real bot receives a test message.

## Environment variables (set locally; never commit them)
    ALERT_TELEGRAM_BOT_TOKEN    bot token from @BotFather
    ALERT_TELEGRAM_CHAT_ID      chat id that receives the alerts
    ALERT_EMAIL_SMTP_HOST       SMTP server (fallback; needs the nodemailer package, already declared)
    ALERT_EMAIL_SMTP_PORT       SMTP port, e.g. 587
    ALERT_EMAIL_SMTP_USER       optional
    ALERT_EMAIL_SMTP_PASS       optional
    ALERT_EMAIL_FROM            sender address
    ALERT_EMAIL_TO              recipient address

Alerts stay OFF until at least one channel is configured. `.env` (or `.env.*`) is in `.gitignore`; put the variables there, not in source.

## One-command Telegram test
    node scripts/alerts/test-telegram.js

## Checklist
1. In Telegram, open @BotFather, send /newbot, and copy the token it gives you.
2. Open a chat with your new bot and send it `/start` (a bot cannot message a chat that has not started it).
3. Get your chat id: open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser, find `"chat":{"id": ...}`.
4. Put `ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID` in `.env`.
5. Run `node scripts/alerts/test-telegram.js`. Expect "Telegram test alert sent" and a message in the chat.
6. Record the result in docs/COMPLETION_REGISTER.md: change "unverified against a live bot" to the date you received the message.

## What alerts
RISK_CAP_HIT, ENTRIES_PAUSED, PROTECTION_FAILED, UNMANAGED_POSITION, RECONCILE_FAILED, STALE_DATA, ENGINE_STALLED, OWNER_SHUTDOWN, plus the existing alert codes. Each code is sent at most once while open, at most once per 15 minutes, and at most 20 messages per hour. Delivery is audited (ALERT_NOTIFIED / ALERT_NOTIFY_FAILED); no credential is ever written to the audit log.
