// One-command Telegram test alert. Reads ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID from the environment only.
// Prints the result without the token. Usage: node scripts/alerts/test-telegram.js
// Loads a local .env if one exists (it is ignored by git), so the variables can live there.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const notify = require('../../src/ops/notify');

(async () => {
  const cfg = notify.telegramConfig();
  if (!cfg) {
    console.log('Telegram is not configured. Set ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID, then run this again.');
    process.exit(2);
  }
  const text = `[AIS TEST] Telegram alert test at ${new Date().toISOString()}. If you can read this, the channel works.`;
  try {
    await notify.sendTelegram(text, {});
    console.log('Telegram test alert sent. Check the chat that owns ALERT_TELEGRAM_CHAT_ID.');
    process.exit(0);
  } catch (e) {
    // The message never contains the token: redact anything that echoes it.
    const msg = String(e.message).split(cfg.token).join('[redacted]');
    console.log('Telegram test alert FAILED: ' + msg);
    console.log('Check the bot token, that the bot was started in the chat (send it /start), and the chat id.');
    process.exit(1);
  }
})();
