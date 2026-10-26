const fs = require('fs-extra');
const path = require('path');
async function run() {
  console.log('=== AIS Markets Full System Verification ===');
  const checks = [
    ['Preferences','src/governance/preferences.js'],['Governance','src/governance/index.js'],['Shadow tracker','src/governance/shadowTracker.js'],
    ['Market data','src/data/marketData.js'],['Storage','src/data/storage.js'],
    ['Indicators','src/intelligence/indicators.js'],['Strategies','src/intelligence/strategies.js'],['Regime detector','src/intelligence/regimeDetector.js'],
    ['Adaptive learner','src/intelligence/adaptiveLearner.js'],['Signal engine','src/intelligence/signalEngine.js'],['Optimizer','src/intelligence/optimizer.js'],
    ['Risk manager','src/risk/riskManager.js'],['Broker adapter','src/execution/brokerAdapter.js'],['Order manager','src/execution/orderManager.js'],
    ['Backtest engine','src/backtest/engine.js'],['Trading engine','src/engine/tradingEngine.js'],['Report generator','src/reports/reportGenerator.js'],
    ['Main server','src/index.js'],['Dashboard','public/index.html'],['Reports folder','data/reports']
  ];
  let allPass = true;
  for (const [n, f] of checks) { const ok = await fs.pathExists(path.join(__dirname, '..', f)); console.log(`[${ok?'PASS':'FAIL'}] ${n}`); if(!ok) allPass=false; }
  const html = await fs.readFile(path.join(__dirname, '../public/index.html'), 'utf8');
  if (html.includes('Same-origin JSON required')) { console.log('[FAIL] Debug text present'); allPass=false; } else console.log('[PASS] No debug text');
  console.log(allPass ? '\n✅ All checks passed' : '\n❌ Some checks failed');
  process.exit(allPass?0:1);
}
run();