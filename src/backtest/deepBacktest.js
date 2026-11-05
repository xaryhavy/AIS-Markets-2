// Multi-year backtest. The live backtest reads the minutes-to-days the feed holds; this one reads years from
// the history store, so the model can see more than one market regime and every weekday of the week.
//
// It runs as a background job: fetching five years of bars is thousands of broker requests and the backtest
// itself is minutes of CPU, neither of which belongs inside an HTTP request. start() returns at once and
// status() reports progress.
const marketData = require('../data/marketdata');
const historyStore = require('../data/historyStore');
const marketFeed = require('../ctrader/marketFeed');
const backtest = require('./engine');
const realBacktest = require('./realBacktest');
const adaptiveLearner = require('../intelligence/adaptiveLearner');
const { listStrategies } = require('../intelligence/strategies');

const DEFAULT_YEARS = 5;
const DEFAULT_TIMEFRAME = 'M5';
const MIN_BARS = 500;

const state = {
  running: false, phase: 'idle', years: DEFAULT_YEARS, timeframe: DEFAULT_TIMEFRAME,
  symbol: null, symbolsDone: 0, symbolsTotal: 0, strategiesDone: 0, strategiesTotal: 0,
  bars: 0, trades: 0, startedAt: null, finishedAt: null, error: null, summary: null
};

function status() { return { ...state }; }

function reset(opts) {
  Object.assign(state, {
    running: true, phase: 'starting', years: opts.years, timeframe: opts.timeframe,
    symbol: null, symbolsDone: 0, symbolsTotal: 0, strategiesDone: 0, strategiesTotal: 0,
    bars: 0, trades: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null, summary: null
  });
}

// The three context frames, derived from the backtest series itself so they are exactly aligned with the
// bars the strategies traded. A frame at or below the backtest timeframe is the series itself.
function framesFor(bars, timeframe) {
  const base = historyStore.TF_MINUTES[timeframe];
  const frames = {};
  for (const frame of ['M5', 'M15', 'H1']) {
    const factor = Math.round(historyStore.TF_MINUTES[frame] / base);
    frames[frame] = factor <= 1 ? bars : historyStore.aggregate(bars, factor, base);
  }
  return frames;
}

async function run({ years = DEFAULT_YEARS, timeframe = DEFAULT_TIMEFRAME } = {}) {
  const conn = require('../ctrader/connectionManager');
  const client = conn.getClient();
  if (!client) throw new Error('not connected to cTrader — a multi-year backtest needs the broker for history');
  const accountId = Number(process.env.CTRADER_ACCOUNT_ID);
  const info = marketFeed.getInfo();
  const symbols = marketData.wantedSymbols().filter(s => info[s] && info[s].symbolId);
  if (!symbols.length) throw new Error('no broker symbol is available for a backtest');

  const barMs = historyStore.TF_MINUTES[timeframe] * 60000;
  const strategies = listStrategies();
  const stored = await realBacktest.loadTrades();
  const summary = [];

  state.symbolsTotal = symbols.length;
  state.strategiesTotal = symbols.length * strategies.length;

  for (const symbol of symbols) {
    state.symbol = symbol;
    state.phase = 'history';
    const { bars, fetched, cached } = await historyStore.load(symbol, timeframe, {
      years, client, accountId, symbolId: info[symbol].symbolId
    });
    if (bars.length < MIN_BARS) {
      summary.push({ symbol, error: `only ${bars.length} bars of ${timeframe} history available` });
      state.symbolsDone++;
      continue;
    }
    state.bars += bars.length;
    const frames = framesFor(bars, timeframe);
    state.phase = 'backtest';

    for (const strategy of strategies) {
      const r = backtest.runBacktest(strategy, {}, { history: bars, dataSource: 'CTRADER_BARS', includeTrades: true });
      state.strategiesDone++;
      if (r.error) continue;
      const trades = r.allTrades.map(t => ({
        symbol,
        action: t.action,
        pnl: t.pnl,
        timeframe,
        openTime: new Date(bars[t.openBar].time).toISOString(),
        features: realBacktest.featuresAt(bars, t.openBar, strategy, frames, barMs)
      }));
      await adaptiveLearner.recordBacktest(strategy, symbol, trades.map(t => ({ pnl: t.pnl, regime: t.features.regime })));
      // Keyed by timeframe so a multi-year run and the live run can both be kept, and the model can tell
      // which one a trade came from.
      stored[`${strategy}|${symbol}|${timeframe}`] = trades;
      state.trades += trades.length;
      summary.push({ symbol, strategy, bars: bars.length, fetched, cached, trades: trades.length, pnl: r.totalPnl, winRate: r.winRate });
    }
    state.symbolsDone++;
    // Saved per symbol: a run that dies halfway still leaves the symbols it finished.
    await realBacktest.saveTrades(stored);
  }

  state.phase = 'retraining';
  const report = await require('../intelligence/mlModel').retrain();
  state.summary = { symbols: summary, model: report };
  return state.summary;
}

// Starts the job and returns immediately. A second start while one is running is refused rather than queued.
function start(opts = {}) {
  if (state.running) return { started: false, reason: 'a deep backtest is already running', status: status() };
  const options = { years: Number(opts.years) || DEFAULT_YEARS, timeframe: opts.timeframe || DEFAULT_TIMEFRAME };
  if (!historyStore.TF_MINUTES[options.timeframe]) return { started: false, reason: `unknown timeframe ${options.timeframe}` };
  reset(options);
  run(options)
    .then(() => { state.running = false; state.phase = 'done'; state.finishedAt = new Date().toISOString(); })
    .catch((e) => {
      state.running = false; state.phase = 'failed'; state.error = e.message;
      state.finishedAt = new Date().toISOString();
      console.log(`[DEEP BACKTEST] failed: ${e.message}`);
    });
  return { started: true, status: status() };
}

module.exports = { start, status, run, framesFor, DEFAULT_YEARS, DEFAULT_TIMEFRAME };
