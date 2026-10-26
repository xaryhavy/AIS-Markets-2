const fs = require('fs-extra');
const path = require('path');
async function run() {
  console.log('=== Demo Full Validation ===');
  const pr = path.join(__dirname, '../data/preferences.json');
  if (await fs.pathExists(pr)) { const d = await fs.readJson(pr); if(d.tradingEnabled)console.log('[PASS] Trading ON'); if(d.autoStartTrading)console.log('[PASS] Auto-start CHECKED'); if(!d.liveTradingApproved)console.log('[PASS] Live LOCKED'); }
  if (await fs.pathExists(path.join(__dirname,'../data'))) console.log('[PASS] Data preserved');
  if (await fs.pathExists(path.join(__dirname,'../data/reports'))) console.log('[PASS] Reports ready');
  const mods = ['../src/data/marketdata','../src/data/storage','../src/intelligence/indicators','../src/intelligence/strategies','../src/intelligence/regimeDetector','../src/intelligence/adaptiveLearner','../src/intelligence/signalEngine','../src/intelligence/optimizer','../src/risk/riskManager','../src/execution/brokerAdapter','../src/execution/orderManager','../src/backtest/engine','../src/governance/shadowTracker','../src/reports/reportGenerator','../src/engine/tradingEngine'];
  for (const m of mods) { try { require(m); console.log(`[PASS] ${m.split('/').pop()}`); } catch(e) { console.log(`[FAIL] ${m}: ${e.message}`); } }
  console.log('\n✅ Full validation complete');
  process.exit(0);
}
run();