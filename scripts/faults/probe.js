// Read-only probe for the demo account: connection, quotes, open positions, minimum order sizes.
// Places no orders. Run with the demo server stopped (one broker session at a time).
const path = require('path');
require('dotenv').config({ path: path.join(process.env.AIS_MAIN_DIR || 'C:/Users/sirju/Documents/AIS Markets 2', '.env') });
const connectionManager = require('../../src/ctrader/connectionManager');
const marketData = require('../../src/data/marketdata');
const marketFeed = require('../../src/ctrader/marketFeed');
const trading = require('../../src/ctrader/trading');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await connectionManager.connect();
  for (let i = 0; i < 60 && !(connectionManager.getStatus().state === 'ACCOUNT_AUTHENTICATED' && marketFeed.isReady()); i++) await sleep(1000);
  const status = connectionManager.getStatus();
  console.log('state', status.state, 'feed', marketFeed.isReady(), 'balance', status.balance);
  for (const s of ['EURUSD', 'BTCUSD', 'XAUUSD']) {
    const info = marketFeed.getInfo(s);
    const q = marketData.getQuote(s);
    console.log(s, 'minVolume', info && info.minVolume, 'stepVolume', info && info.stepVolume,
      'quote', q ? { bid: q.bid, ask: q.ask, ageMs: marketData.quoteAgeMs(s) } : null);
  }
  const open = await trading.openPositions();
  console.log('broker open positions:', open.length);
  open.forEach(p => console.log(' ', p.positionId, p.tradeData.symbolId, p.tradeData.tradeSide, p.tradeData.volume));
  process.exit(0);
})().catch(e => { console.error('probe failed:', e.message); process.exit(1); });
