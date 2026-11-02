# AIS Markets — Implementation Status Against the Master Mission

**Status document created:** 2026-11-02
**Branch inspected:** `claude/ais-markets-ctrader-f6a11a` (worktree `ais-markets-ctrader-f6a11a`)
**Working tree at inspection:** clean, HEAD `5e81470`
**Test baseline run:** `npm test` → **339 tests, 339 pass, 0 fail** (11.4 s)
**Last code change:** P1 backtest honesty fix (2026-11-02) — see §11

> This is an audit-and-status document only. It records what exists, what does not, and what the
> evidence actually supports. It does not claim any requirement is met without a file, test or
> command backing it.

---

## 1. Mission source

| Field | Value |
|---|---|
| Filename | `AIS_MARKETS_MASTER_MISSION.md.txt` |
| Location | `C:\Users\sirju\Documents\AIS Markets 2\docs\` (main checkout) |
| Size | 1,276 lines / 55,596 bytes |
| Git status | **Untracked** (`git status` → `?? docs/AIS_MARKETS_MASTER_MISSION.md.txt`) |
| Present in this worktree? | **No** — see §9, finding N-1 |

The project's documentation folder is `docs/` (lowercase), not `Docs/`. The mission file also
carries a doubled `.md.txt` extension. Neither affects readability; both are noted because scripts
and tooling that assume `Docs/` will silently miss every document.

The mission was read in full directly from disk. Its contents are summarised below.

---

## 2. Mission summary

### 2.1 Primary objective (§2)

A **unified, integrated** multiscale, multi-market intelligence and trading system, not a set of
disconnected modules, capable of:

1. Acquiring and validating real historical and live market data.
2. Understanding market behaviour across multiple timeframes.
3. Identifying structures, waves, repeated behaviours and patterns.
4. Discovering candidate strategies from historical observations.
5. Quantifying how often behaviours occur and what follows them.
6. Determining whether a behaviour has statistically supported trading potential.
7. Testing candidates on historical and unseen data.
8. Testing operational execution on a demo account.
9. Maintaining a versioned catalogue of discovered and approved strategies.
10. Recommending qualified strategies for **explicit human approval**.
11. Automatically executing **approved and deployed** strategies under independent risk controls.
12. Monitoring deployed strategies and detecting deterioration.
13. Investigating improvements and proposing **versioned amendments** without silently changing an
    approved strategy.
14. Recording research, decisions, approvals, executions, outcomes and changes in an auditable history.

The system must be able to conclude that **no strategy qualifies**. It must never manufacture a
strategy to satisfy an acceptance criterion.

### 2.2 Mandatory safety restrictions (§3, §10, §12.2, §17)

- Inspect before changing; do not overwrite uncommitted work; no destructive git operations.
- **No superficial completion**: no unused modules, no dead endpoints, no hard-coded analysis, no
  predetermined scores, no simulated backtest presented as broker execution, no order request
  presented as a fill, no unrun test claimed as passing, no mock presented as a real integration.
- **Never expose, print or commit secrets** (API keys, passwords, OAuth/owner tokens, broker
  credentials).
- **Do not weaken authentication, authorisation, risk checks or execution safeguards** to make tests pass.
- **No real-money orders** during implementation, research or testing. Research on historical data;
  operational testing on a **demo** account only.
- **Do not enable live trading automatically.** Live deployment stays disabled until an authorised
  human completes approval and configuration.
- **Do not bypass explicit human approval** for strategy deployment.
- **Verify the configured environment** before any test order — a connected account is not assumed
  to be demo.
- If a service, credential or broker capability is unavailable, report the limitation accurately and
  implement everything else safely.
- Mock/synthetic data is allowed only for unit tests and **explicitly labelled** simulations, never
  represented as market observation, historical validation or broker evidence.

### 2.3 Required implementation phases (§18)

| Phase | Content |
|---|---|
| 1 | Repository inspection and baseline (git state, tests, flows, missing capabilities) |
| 2 | Core data and intelligence (validation/provenance, unified representation, multiscale + structure detection, reproducible pattern recognition, integration) |
| 3 | Research and discovery (historical search, occurrence counting, candidate generation, entry/SL/TP + R:R, costs/metrics/qualification, bias controls + OOS, evidence reports) |
| 4 | Strategy registry and approval (versioned persistence, lifecycle enforcement, evidence-based recommendations, version-specific human approval, deployment authorisation, negative-path verification) |
| 5 | Demo execution and reconciliation (broker path, eligible strategies, orders/fills/protection/positions/closures, timeout/duplicate/restart/recovery, reconciliation) |
| 6 | Automatic execution and monitoring (deployed approved strategies, independent risk, performance monitoring, deterioration + amendment proposals, preserve approved version) |
| 7 | UI, documentation, final verification (integrate into existing UI, config/visibility, full test programme, log inspection, persistence/restart, security review, completion report) |

### 2.4 Acceptance criteria (§17)

**A.** Repository and architecture — inspected, integrated, user work preserved, no unused critical
component.
**B.** Market intelligence — real ingestion, data-quality controls, multi-instrument/multi-timeframe,
reproducible multiscale/wave analysis, confirmed vs provisional detections, no future leakage.
**C.** Pattern and strategy discovery — historical search, occurrence counting, explicit candidate
definitions, correct planned R:R, rejection reasons recorded, qualify/reject/defer, no fabrication.
**D.** Research integrity — reproducible results, separated validation periods, costs and realistic
fills, OOS implemented, bias addressed and documented, uncertainty not hidden.
**E.** Strategy management — versions and lifecycle persist, backend-enforced approval, **approval
applies to a specific version**, material amendments need fresh approval, evidence/audit accessible.
**F.** Demo execution — real demo integration exercised, orders/fills/protection/positions/closures
verified against broker state, failure/timeout/duplicate/recovery tested, simulated distinguished
from broker.
**G.** Automatic execution — approved+deployed strategies execute, risk independent of strategy,
unapproved cannot run live, order state reconciled, restart tested, **live trading stays disabled**.
**H.** Monitoring and amendments — performance vs defined expectations, deterioration triggers
investigation, amendments versioned and evidenced, approved version never silently modified, new
versions need fresh approval.
**I.** Operational quality — tests run, failures addressed/documented, documentation matches
behaviour, final report separates complete/partial/blocked/unverified.

### 2.5 Definition of done (§20)

A functioning, integrated path from real historical data → repeatable pattern discovery →
quantitative validation → versioned recommendations → explicit human approval → demo-tested
execution → automatic execution of approved/deployed strategies, with independent risk, broker
reconciliation, performance monitoring and evidence-based amendment proposals — and honesty about
what is known, measured, uncertain and authorised.

---

## 3. Baseline evidence at inspection

| Item | Evidence |
|---|---|
| Repo size | `src/` 7,152 LOC across 60 JS files; `tests/` 3,571 LOC across 47 test files; `public/` 762 LOC across 3 pages |
| Test run | `npm test` → `tests 320 / pass 320 / fail 0` (exit 0) |
| Runtime | Node, Express 4, JSON-file persistence, cTrader Open API over WebSocket + protobuf |
| Market-data source | cTrader only (`src/data/marketdata.js:1-3` — "Prices come only from the cTrader live feed… Nothing is simulated") |
| Broker integration | Real cTrader Open API client (`src/ctrader/openApiClient.js`) with trendbars, market orders, SL/TP amendment, position close |
| Instruments | `EURUSD, GBPUSD, USDJPY, XAUUSD, BTCUSD` (`src/data/marketdata.js:4`) |
| Timeframes | `M1, M5, M15, H1` (`src/data/marketdata.js:5`) |
| Persistence | Atomic serialized JSON writer (`src/data/storage.js`) + SHA-256 hash-chained audit log (`src/audit/audit.js`) |

---

## 4. Requirement-by-requirement checklist

Legend: **MET** = implemented and evidenced · **PARTIAL** = some real implementation, material gaps ·
**MISSING** = no implementation · **CONFLICT** = existing behaviour contradicts the mission.

### 4.1 Market-data foundation (§4.1)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 4.1.1 | Historical OHLCV | **PARTIAL** | `src/ctrader/marketFeed.js:15-50` fetches real cTrader trendbars (M1/M5/M15/H1) and seeds `marketdata.setBars`. Bars are held **in memory only** (`src/data/marketdata.js:9`); nothing is persisted, so a historical dataset is not reproducible across restarts or referenceable by a dataset ID. |
| 4.1.2 | Live/streaming prices | **MET** | `src/ctrader/marketFeed.js` subscription + `marketdata.setQuote` (`src/data/marketdata.js:37-53`) rolls live quotes into every timeframe. |
| 4.1.3 | Multiple timeframes | **MET** | `M1/M5/M15/H1` with per-frame caps (`src/data/marketdata.js:5-6`). |
| 4.1.4 | Multiple asset classes | **PARTIAL** | Config lists FX majors, gold and BTC (`marketdata.js:4`); no asset-class model, no per-class trading-calendar logic beyond generic sessions. |
| 4.1.5 | Session / trading-calendar awareness | **MET** | `src/data/sessions.js` used by the gap detector to distinguish scheduled closures from missing candles (`src/data/quality.js:94-96`). Per-instrument calendars are generic, not broker-sourced. |
| 4.1.6 | Instrument metadata (tick size, contract size, pip value, volume constraints) | **PARTIAL** | Only what is needed to place orders: `unitsToVolume`, `roundPrice`, `symbolId` (`src/ctrader/marketFeed.js:117-134`). No persisted trading-specification table (tick size, contract size, pip value, margin). |
| 4.1.7 | Bid/ask and spread | **MET** | `marketdata.getQuote` returns `{bid, ask, price, time}`; spread is enforced pre-trade when enabled (`src/risk/preTrade.js:60-65`). |
| 4.1.8 | Timestamps, source ID, provenance | **PARTIAL** | Timestamps and a per-frame data fingerprint exist (`quality.fingerprint`, `src/data/quality.js:66-69`). No source/dataset provenance record carried into research artefacts. |
| 4.1.9 | Data-quality validation | **MET** | `src/data/quality.js:55-105` — finite/positive prices, OHLC coherence, period-aligned timestamps, duplicate removal, out-of-order sorting, future exclusion. |
| 4.1.10 | Missing/duplicate/malformed/out-of-order detection | **MET** | `validateBars` counts `invalid, duplicates, future, incomplete, gaps, missingBars, unexplainedMissing`. Covered by `tests/dataQuality.test.js`, `tests/dataGate.test.js`. |
| 4.1.11 | Timezone normalisation | **PARTIAL** | Everything is UTC epoch milliseconds; session windows are UTC (`src/risk/limits.js:187-197`). No explicit timezone conversion layer because none is needed for cTrader epochs. |
| 4.1.12 | Stale prices / incomplete candles | **MET** | Per-frame `STALE_MS` (`quality.js:20`); forming candles excluded from every analysis (`quality.js:84-88`, `completedBars`); quote-age gate `MAX_QUOTE_AGE_MS` (`src/execution/safety.js:3,9-12`). |
| 4.1.13 | Gaps / closures / unavailable periods handled explicitly | **MET** | Session-aware gap counting plus a configurable tolerance, **fail-closed by default (0)** (`quality.js:30,114-149`); block episodes persisted (`quality.js:155-174`). |
| 4.1.14 | Reproducible historical datasets or references | **MISSING** | No dataset snapshots, no pinned bar ranges, no dataset ID on backtest configuration or results. |
| 4.1.15 | Safe caching / efficient retrieval | **PARTIAL** | In-memory ring buffers with caps; no disk cache, no incremental historical fetch strategy beyond the bounded seeding fetch. |
| 4.1.16 | No silent interpolation that creates opportunities | **MET** | No interpolation exists anywhere. Missing candles block rather than fill. |
| 4.1.17 | Completed vs forming candles distinguished everywhere | **MET** | `quality.completedBars`, `timeframes.completedBars`, and `signalEngine.evaluateSymbol` all use completed bars only (`src/intelligence/signalEngine.js:11-12`). |
| 4.1.18 | Stop actionable signals on stale/invalid data | **MET** | `tradingEngine.runCycle` assesses every symbol before scanning (`src/engine/tradingEngine.js:156-159`), skips on `!assessment.ok` (`:195-198`), and re-checks data fingerprint before dispatch (`:250-254`). |

### 4.2 Unified market-intelligence engine (§4.2)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 4.2.1 | Common analytical framework across timeframes | **PARTIAL** | `src/intelligence/*` provides indicators, regime, candlestick patterns, confluence, supply/demand, price action, ensemble (`signalEngine.js`), MTF context (`timeframes.js`). It is an **ensemble of indicator strategies**, which §4.2 explicitly warns against ("must not be implemented as an arbitrary list of indicators whose values are combined without a defensible reason"). |
| 4.2.2 | Direction/trend, range, volatility, momentum | **MET** | `indicators.js`, `regimeDetector.js`, `timeframes.js`. |
| 4.2.3 | Swing highs/lows | **PARTIAL** | Implicit inside price-action strategies (`supplyDemand.js`, `priceActionStrategies.js`); there is no first-class swing detector that records scale, start/end, duration and amplitude. |
| 4.2.4 | Market structure | **PARTIAL** | `priceActionStrategies.js` / `supplyDemand.js` encode breakouts and zones; no explicit structure state machine (HH/HL/LH/LL) with recorded transitions. |
| 4.2.5 | Breakouts and failed breakouts | **PARTIAL** | Breakout strategy exists (`strategies.js:39-50`); "failed breakout" is not detected or labelled. |
| 4.2.6 | Pullbacks / reversals | **PARTIAL** | RSI mean-reversion and candlestick reversal patterns only; no pullback-in-trend detection. |
| 4.2.7 | Support/resistance zones | **MET** | `src/intelligence/supplyDemand.js:detectZones`, exposed at `GET /api/zones/:symbol`. |
| 4.2.8 | Repeated behaviours | **PARTIAL** | `patternMiner.js` mines recurring *trade-outcome* conditions, not recurring *price* structures. |
| 4.2.9 | Multi-timeframe alignment/conflict | **MET** | `timeframes.allows` — H1/M15 must not oppose and at least one must confirm (`timeframes.js:58-63`), enforced at `tradingEngine.js:201-204`. |
| 4.2.10 | Liquidity/spread constraints | **PARTIAL** | Spread is available and enforceable (`preTrade.js:60-65`); no liquidity measure. |
| 4.2.11 | Session-dependent behaviour | **PARTIAL** | Session windows exist for blocking (`limits.inBlockedSession`) and for gap classification; session is **not** a research feature (only `hour` and `dayOfWeek` in `patternMiner.tokensOf`). |
| 4.2.12 | Regime change detection | **MET** | `regimeDetector.classify` → TRENDING_UP / TRENDING_DOWN / RANGING / VOLATILE, re-evaluated each cycle and stored on every trade (`tradingEngine.buildFeatures`). |
| 4.2.13 | Structural breaks / behavioural deterioration | **MISSING** | No deterioration detector; see §4.12. |
| 4.2.14 | Context before/after a detected event | **MISSING** | No event-centric context window is captured. |
| 4.2.15 | Explainable representation | **PARTIAL** | Every signal carries `reason`, `score`, per-strategy `strategySignals`, `regime`, `regimeConfidence` (`signalEngine.js:54-61`) and every skip is recorded with a reason (`shadowTracker`). No structured "supporting vs contradicting vs uncertain" evidence model. |
| 4.2.16 | Raw observations vs derived features vs events vs findings kept distinct | **PARTIAL** | Raw bars are separate from derived signals; `evidence.js` cleanly classifies record provenance. But "detected events" and "validated findings" have no schema. |

### 4.3 Multiscale and wave analysis (§4.3)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 4.3.1 | Wavelet / multiresolution decomposition | **MISSING** | `grep -rln "wavelet\|multiscale\|multi-scale" src/` → no matches. |
| 4.3.2 | Scale-aware swing detection with explicit definitions | **MISSING** | No swing detector with scale parameter, confirmation rule or start/end/duration/amplitude record. |
| 4.3.3 | Confirmed vs provisional structures | **MISSING** | Only candles have a completed/forming distinction; structures do not. |
| 4.3.4 | No future candles used to confirm a historical signal | **MET** (for what exists) | All analysis slices history up to the decision bar (`realBacktest.featuresAt` uses `slice(0, openBar+1)`, `timeframes.trendsAt` filters on bar end time). No leakage test exists yet (§4.16). |
| 4.3.5 | Measure how detection changes as candles arrive | **MISSING** | Not implemented. |
| 4.3.6 | Parameter/regime sensitivity testing | **PARTIAL** | `optimizer.gridSearch` varies parameters but against synthetic history by default (see finding N-3). No regime-stratified sensitivity. |
| 4.3.7 | Boundary/artefact handling | **MISSING** | N/A — no decomposition exists yet. |
| 4.3.8 | Computationally efficient | **N/A** | No multiscale workload exists yet. |

**Assessment:** §4.3 is the largest unimplemented analytical requirement. Acceptance criterion B
bullet 3 (reproducible multiscale/wave analysis) cannot pass.

### 4.4 Pattern recognition and discovery (§4.4, §5.1)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 4.4.1 | Search historical periods for repeated behaviours | **PARTIAL** | `patternMiner.findRules` mines closed trades (live + real-data backtests) for recurring token combinations in-sample/out-of-sample (`src/intelligence/patternMiner.js:59-85`). It does not search price history independently of trades that happened to be taken. |
| 4.4.2 | Search across timeframes | **MISSING** | Mining is per-trade; timeframe is not a search dimension (MTF trend is a feature only). |
| 4.4.3 | Examine market regimes | **MET** | `regime=…` is a mined token (`patternMiner.js:32`). |
| 4.4.4 | Group similar observations by defensible similarity | **PARTIAL** | Exact token-set equality only; no clustering or distance metric. |
| 4.4.5 | Precise, reproducible pattern definition | **PARTIAL** | Each proposal is a token conjunction (`regime=… AND hour=…`), which is precise, but has no version, hash or formal definition record. |
| 4.4.6 | Occurrence counting accurate; no double counting | **PARTIAL** | Counts are per-trade, so one trade = one occurrence. No handling of overlapping windows or correlated instruments (each trade is treated as independent). |
| 4.4.7 | Exclusion reasons recorded | **MISSING** | Rejected rules are simply dropped before the `TOP_N` cut (`patternMiner.js:84`); no exclusion ledger. |
| 4.4.8 | Contradicting evidence / confidence limitations | **MISSING** | Proposals carry in-sample/out-of-sample stats but no limitations or contradicting-evidence section. |
| 4.4.9 | Bonus-mining controls (deposit/frequency) | **MISSING** | See §5.3 below. |
| 4.4.10 | Research driven by predefined hypotheses **and** exploratory discovery | **PARTIAL** | Exploratory only (token mining). Predefined strategy families exist as code (`strategies.js`) but are not run as a research hypothesis pipeline. |
| 4.4.11 | ML used only where justified, with training/validation/inference/versioning/monitoring | **PARTIAL / CONFLICT** | `src/intelligence/mlModel.js` is a small L2 logistic model with walk-forward validation and an `active` flag (`mlModel.js:107-129`) — good practice. But the model has **no version ID, no lineage record and no drift monitoring**, and it silently gates live entries (`tradingEngine.js:230-237`). |
| 4.4.12 | Discovered pattern ≠ fully specified strategy | **MISSING** | A proposal is a token filter, not a strategy with entry/SL/TP/exit. No intermediate object exists. |

### 4.5 Automated strategy discovery (§5)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 5.1.1 | Unique candidate ID, name, instrument, timeframe, period, dataset ref | **MISSING** | Proposals are keyed by their token string; no ID, no dataset reference, no version. |
| 5.1.2 | Detection conditions + version | **PARTIAL** | Conditions are the token list; no version. |
| 5.1.3 | Occurrence counts, exclusions, overlap, same-event grouping | **PARTIAL** | Counts only. No overlap or dependency handling (§5.1: "do not inflate the count"). |
| 5.1.4 | Distribution of subsequent moves, time-to-outcome, regime breakdown | **PARTIAL** | Only `avgPnl` and `winRate` per sample (`patternMiner.stats`). No distribution, no time-to-outcome, no regime breakdown of *outcomes*. |
| 5.2.1 | Exact setup/entry/SL/TP/exit/sizing/invalidation rules per candidate | **PARTIAL** | The nine hard-coded strategies fully specify rules. Imported candidate *strategies* do not exist. |
| 5.2.2 | Order type, assumed fill price | **PARTIAL (live) / MISSING (research)** | Live execution is market-order only (`trading.js:99`); the backtest assumes fill at bar close with no order type. |
| 5.2.3 | Control for multiple-experimentation risk | **PARTIAL** | `evaluation.significanceAfterMultipleTesting` implements an alpha/k correction (`src/analytics/evaluation.js:71-82`) — genuinely good — but it is **not wired into the discovery path**; nothing calls it outside tests. |
| 5.3.1 | 1:3 planned reward-to-risk convention | **MET** | `riskManager.calculateStops` sets TP at `max(3, minRewardRisk) × stop distance` (`riskManager.js:56-64`); `limits.minRewardRisk` has `min: 3` (`limits.js:19`); recomputed independently at the order boundary (`preTrade.js:47-49`). |
| 5.3.2 | R:R computed from actual proposed prices | **MET** | `riskManager.riskReward(stops, price)`; `preTrade.check` recomputes from the real order. |
| 5.3.3 | Plausibility of the target vs historical path | **MISSING** | No check that a 3R target is reachable within a plausible horizon. |
| 5.3.4 | Which of SL/TP was reached first; ambiguous same-candle outcome handled conservatively | **MET (2026-11-02)** | `resolveExit` checks each bar's high/low and returns `hit: 'BOTH'` when both levels are touched (`backtest/engine.js:104-121`). Ambiguity is never resolved silently: the policy is named in the result (`stop-first` conservative default, `target-first`, or `exclude`) and every ambiguous trade is counted in `ambiguousTrades`. Gaps through a level fill at the bar open, which is worse than the level. |
| 5.3.5 | Transaction costs, spread, commission, financing, slippage | **PARTIAL (2026-11-02)** | `backtest/engine.js` now applies a validated cost model — spread per round trip, slippage per fill, commission per trade — with adverse fills on entry and exit, and reports `grossPnl`, `netPnl`, `totalCosts` and a plain-language `costAssumption`. Financing/swap and tiered broker commission are still not modelled. |
| 5.3.6 | Failing candidates recorded with reasons | **PARTIAL** | The mining loop drops non-qualifying rules silently (`patternMiner.js:79-81`). |
| 5.4.1 | Qualification metrics (win rate, expectancy, drawdown, profit factor, R:R, consecutive losses, ruin proxy, duration, sensitivity, stability, regime, cross-instrument, OOS, uncertainty intervals) | **PARTIAL** | `evaluation.evaluate` covers sample size, win rate + Wilson CI, avg win/loss, expectancy, profit factor, net P&L, max drawdown, t-statistic (`evaluation.js:19-49`). Missing: consecutive losses, ruin proxy, exposure/duration, parameter stability, regime breakdown, cross-instrument, sensitivity. |
| 5.4.2 | Explicit, configurable minimum sample/evidence thresholds | **MET** | `MIN_SAMPLE = 30`, `MIN_IN_SAMPLE = 30`, `MIN_OUT_OF_SAMPLE = 10`, win-rate floors (`evaluation.js:7`, `patternMiner.js:9-13`). |
| 5.4.3 | System can reject for insufficient/inconclusive evidence | **MET** | `evaluation` returns `sufficientSample: false` + explanatory flag; mining enforces both sample floors. |

### 4.6 Historical validation and research integrity (§6)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 6.1 | Lookahead-bias controls | **PARTIAL** | Decisions use `slice(0, i+1)` and completed-bar filters. **No automated leakage test** (§16.2 requires one). |
| 6.2 | Chronological train/validation/test separation | **PARTIAL** | 70/30 chronological splits in `patternMiner` and `evaluation.outOfSample` and `mlModel.validate`. Only two-way; no separate validation *and* test periods. |
| 6.3 | Walk-forward, purging, embargo | **MISSING** | `grep -rln "walk.?forward\|purge\|embargo" src/` → only `governance/compaction.js` (unrelated). No purging/embargo between dependent observations. |
| 6.4 | Data-snooping / many-hypotheses control | **PARTIAL** | Correction function exists (`evaluation.significanceAfterMultipleTesting`) but is **unused** in the production path. |
| 6.5 | Realistic fills (timing, spread, commission, slippage, SL/TP behaviour, trading rules) | **MISSING** | Close-only fills, no costs, no intrabar SL/TP ordering, no volume constraints in the backtest. |
| 6.6 | Overlapping trades/observations handled | **PARTIAL** | A single backtest holds at most one open position (`backtest/engine.js:63`). Occurrence overlap in mining is not addressed. |
| 6.7 | Test data never used for model selection | **PARTIAL** | `mlModel.validate` trains on the earliest 70% and tests on the latest 30% (`mlModel.js:107-129`); the *production* refit (`retrain`) trains on everything (`mlModel.js:142-156`) — acceptable only if the activation decision was made on held-back data, which it is, but this is not documented in one place. |
| 6.8 | Record of all hypotheses evaluated including failures | **MISSING** | No hypothesis/experiment ledger. |
| 6.9 | Seven evidence categories never merged | **MET** | `src/analytics/evidence.js` defines `BROKER_DEMO_EXACT`, `BROKER_DEMO_ESTIMATED`, `FAULT_TEST`, `SIMULATED_PAPER`, `SIMULATED_LEGACY`, `HYPOTHETICAL`; `evaluation.exactResults` uses only exact demo results; reports separate simulated results; `analytics/performance.js` filters `source === 'ctrader' && evidenceMode !== 'PAPER'`. This is one of the strongest parts of the build. |
| 6.10 | Strategy not labelled validated merely for positive backtest | **MET** | No "validated" label exists; `evaluation` refuses conclusions below n=30 and reports uncertainty. |

### 4.7 Strategy catalogue and lifecycle (§7)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 7.1 | Persistent strategy registry with stable ID + version | **MISSING** | No registry module. `grep -rln "catalogue\|registry" src/` → no matches. Strategies are an in-code object keyed by name (`strategies.js:65-68`). |
| 7.2 | Full lifecycle state machine (RESEARCH_CANDIDATE → … → RETIRED) | **MISSING** | No strategy lifecycle. The nearest analogue is `patternMiner` PROPOSED/APPROVED/REJECTED and `risk/limits` PENDING/APPROVED/REJECTED — neither is a strategy lifecycle. |
| 7.3 | Transitions enforced in backend, not UI | **MISSING** | Nothing to enforce. (The pattern-mining and risk-limit transitions *are* backend-enforced, which is the right pattern to copy.) |
| 7.4 | Per-version persisted record (rules, data refs, results, approval, deployment, change history) | **MISSING** | No such record. |

### 4.8 Evidence-based strategy reports (§8)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 8.1 | Readable, reproducible per-candidate report with sections A–I | **MISSING** | `reports/reportGenerator.js` produces **period** reports (daily/weekly/monthly/yearly) and `reports/ownerReport.js` produces owner summaries. Neither is a per-strategy evidence report. |
| 8.2 | Visual evidence charts from real observations, success **and** failure | **MISSING** | No chart generation anywhere. |

### 4.9 Demo execution validation (§9)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 9.1 | Real demo broker integration used | **MET** | `src/ctrader/*` speaks the real Open API; orders go through `trading.openWith`. Fault-injection scripts exist (`scripts/faults/run.js`) with recorded results in `scripts/faults/results/`. |
| 9.2 | Order admission + risk path | **MET** | Engine checks → `preTrade.check` inside `trading.openWith` → broker (`trading.js:71-100`). The check cannot be bypassed by a caller. |
| 9.3 | Entry/SL/TP/size calculation | **MET** | `riskManager.calculateStops` / `calculatePositionSize`; volume conversion by broker constraints (`marketFeed.unitsToVolume`). |
| 9.4 | Broker accept/reject/partial-fill | **PARTIAL** | Accept/reject handled (`REJECTED`, broker-refusal detection). **Partial fills are not handled** — a fill without a position is treated as `UNKNOWN` (`trading.js:123-127`). |
| 9.5 | Confirm actual broker position/order state | **MET** | `trading.reconcile`, `resolveIntents`, `openPositionIds` (`trading.js:199-293`). |
| 9.6 | Verify protective SL/TP | **MET** | `amendSltp` after fill; on failure the position is closed, and if closing also fails it is recorded as `PROTECTION_FAILED` and alerted (`trading.js:129-145`). |
| 9.7 | Manage/close per strategy rules | **MET** | `orderManager.checkAndClosePositions` + broker-side SL/TP + `syncWithBroker`. |
| 9.8 | Reconcile final outcome vs broker | **PARTIAL** | `syncWithBroker` detects broker-closed positions but **estimates** P&L from the current price (`orderManager.js:142-152`) and flags `pnlEstimated`. `evaluation` then excludes estimated results from strategy evidence — correct, but the estimate itself is not a broker-reported result. |
| 9.9 | Auditable record of signal → decision → order → fills → position → closure | **MET** | `shadowTracker` decisions, `order_intents.json` intents with full status history, hash-chained audit log. |
| 9.10 | Failure/adverse cases (stale data, missing candles, duplicates, repeated submissions, disconnect, reconnect, rejection, partial fill, invalid volume, invalid SL/TP, margin, restarts, unknown status, state mismatch, missing protection, closures, suspension with open position) | **PARTIAL** | Covered in code and tests: stale data (data gate), duplicate submission (unresolved intents block entries), unknown outcome (`UnknownOutcomeError` + reconciliation), restart (`intents` persisted, `recordAdopted`), unmanaged positions, missing protection (`PROTECTION_FAILED` + emergency close), invalid volume (`unitsToVolume` null check), invalid SL/TP (geometry check). **Partial fill and explicit margin-insufficient handling are absent.** |
| 9.11 | No fabricated demo results | **MET** | Fault-injection results are real files with timestamps; trade evidence classes prevent simulated results from being counted. |
| 9.12 | Uncertain broker state reconciled before retry | **MET** | `safety.entryBlockers` blocks new entries while any intent is unresolved or any broker position is unmanaged. |
| 9.13 | Tested recovery policy when protection cannot be verified | **MET** | Emergency close, then `PROTECTION_FAILED` + critical alert; entries blocked. |

### 4.10 Human approval and live deployment (§10)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 10.1 | No strategy deployable live without explicit human approval of that exact version | **MISSING (mechanism) / TRIVIALLY MET (outcome)** | Live mode is **hard-locked**: `MODES.LIVE.available = false` (`mode.js:25`), `POST /api/live/approve` always returns 409 (`index.js:358-361`). Live cannot happen, so nothing unapproved can go live — but the *approval mechanism* the mission asks to build does not exist. |
| 10.2 | Approval workflow: present version, display evidence/limits, record decision + identity + timestamp | **MISSING** | Not implemented for strategies. |
| 10.3 | Prevent unapproved versions entering the live path | **MISSING (by absence of the path)** | Works only because the live path does not exist. |
| 10.4 | Material changes need a new version + fresh approval | **MISSING** | Strategies have no versions. |
| 10.5 | Approval withdrawable; suspension/emergency disablement | **PARTIAL** | Emergency stop, owner shutdown, mode changes, entry pause and suspension of new entries all exist and are backend-enforced (`risk/limits.js:151-163`, `governance/shutdown.js`, `engine/entryPause.js`, `mode.js`). Approval withdrawal in the strategy sense does not exist. |
| 10.6 | No self-approval / no strategy changing its own live config | **CONFLICT (partial)** | `adaptiveLearner` continuously rewrites strategy weights from outcomes, changing ensemble behaviour with **no version, no approval and no notification** (`src/intelligence/adaptiveLearner.js:19-45`). Under §12.2 this is a silent behavioural amendment. It is bounded and degraded-only (weights shrink on losses), but the mission's rule is strict. |

### 4.11 Automatic execution of approved strategies (§11)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 11.1 | Load only eligible, deployed strategy versions | **MISSING** | The engine runs **all** strategies in the ensemble unconditionally (`signalEngine.js:21-31`). There is no eligibility or deployment concept. |
| 11.2 | Evaluate per strategy definition | **PARTIAL** | Each strategy's `generate()` runs with its default params; params are not per-strategy persisted per deployment. |
| 11.3 | Prevent trading on stale/invalid data | **MET** | Data gate + fingerprint + quote age (see 4.1.18). |
| 11.4 | Prevent trading on unreliable broker state | **MET** | `!trading.isReady()` returns early; reconciliation failure blocks entries. |
| 11.5 | Prevent duplicate orders per actionable event | **MET** | Unresolved intents block entries; per-symbol order cooldown (`tradingEngine.js:216,263`). |
| 11.6 | Respect broker volume/price/order-type constraints | **PARTIAL** | Volume conversion + price rounding; order type is market-only and nothing else is supported or claimed. |
| 11.7 | Separate signal generation from execution | **MET** | `signalEngine` → `tradingEngine` gates → `orderManager` → `trading`. |
| 11.8 | Record why each signal was accepted/rejected/delayed | **MET** | `shadowTracker.recordDecision` records `EXECUTED` or `SKIPPED` with a reason at every gate; decision records persist. |
| 11.9 | Reconcile local vs broker state | **MET** | See 9.5/9.8. |
| 11.10 | Independent risk controls (per-trade, aggregate, max positions, instrument, daily loss, drawdown, consecutive losses, margin/leverage, correlated exposure, slippage, spread, session, stale data, disconnect, emergency stop) | **PARTIAL / strong** | `risk/limits.js` — risk per trade, max open positions, max exposure, R:R floor, stop ATR, cooldown, quote age, total open risk (disabled), drawdown (disabled), max spread (disabled), consecutive losses (disabled), positions per instrument (disabled), blocked sessions (disabled) — all validated, bounded, proposal-gated, versioned in history. `preTrade.check` enforces them **inside** the order path. **Missing: correlated-exposure control and maximum-slippage control.** |
| 11.11 | Risk evaluated immediately before submission | **MET** | `preTrade.check` runs inside `trading.openWith` after the engine's checks. |
| 11.12 | Strategy cannot override risk limits | **MET** | No strategy has access to the order path; `preTrade` is called by the broker adapter, not the strategy. |
| 11.13 | Breach blocks new entries and triggers configured response | **MET** | Emergency stop, entry pause, MTM caps, owner shutdown, recovery fence. |
| 11.14 | Do not blanket-close positions on every error | **MET** | Exits run independently; only unprotected positions are emergency-closed. |
| 11.15 | Order submission vs verification separated; timeouts don't duplicate; broker IDs persisted; restart reconstruction; unknown → reconcile; unexpected positions detected; auditable failures; emergency disable | **MET** | `trading.js` intents + `reconcile` + `execution/unmanaged.js` + `audit`. Covered by `tests/execution.test.js`, `tests/recoveryFence.test.js`, `tests/unmanagedPositions.test.js`, `tests/adoptionAndCloseAudit.test.js`. |
| 11.16 | Never report a position closed while the broker still holds it | **MET** | `syncWithBroker` only closes locally when the broker no longer lists the position (`orderManager.js:141-142`). |
| 11.17 | Distinguish unit / integration / simulated / demo broker / live evidence | **MET** | `evidence.js` classes; `docs/FAULT_INJECTION_RESULTS.md`; report generator separates. |

### 4.12 Monitoring and amendments (§12)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 12.1 | Monitor deployed strategies against documented expectations | **MISSING** | No deployed strategies and no documented expectations to compare against. `analytics/performance.summary` reports outcomes but does not compare to an expectation. |
| 12.2 | Detect deteriorating expectancy, win rate, drawdown, slippage, execution failure, duration, regime shift | **MISSING** | No detector. `adaptiveLearner` reacts to individual losses by shrinking weights — a crude response, not detection with evidence. |
| 12.3 | Do not suspend on small random fluctuation; distinguish variance vs evidence vs execution problems | **MISSING** | No statistical thresholding for deterioration. (Entry pause triggers on *cycle failures*, not performance — correct separation, but not the required monitor.) |
| 12.4 | Amendment discovery: identify version, describe deterioration, investigate causes, test alternatives, OOS, demo, compare, propose | **MISSING** | No amendment proposal object or workflow. |
| 12.5 | Proposal states existing version, new version, exact rule changes, evidence, risks, recommendation | **MISSING** | — |
| 12.6 | Never silently modify a live-approved strategy; preserve old version + approval + results | **CONFLICT (partial)** | `adaptiveLearner` (weights) and `mlModel` (entry gate) alter trading behaviour continuously without versioning. Neither is presented as a strategy amendment, and both are visible in `data/adaptive_weights.json` / `data/ml_model.json`, but under §12.2 they are unversioned behavioural changes. |

### 4.13 User interface and operational visibility (§13)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 13.0 | Extend the existing UI, do not create an unrelated one | **MET** | `public/index.html` extended in place; `login.html` and `setup.html` added for access control. |
| 13.1 | Market intelligence view (instruments, timeframes, data health, context, structures, MTF, timestamps, confirmed/provisional) | **PARTIAL** | Shows prices, regimes, signals, zones, forecasts (`index.html:147-171`). **Does not** show data health, bar timestamps, or confirmed/provisional status — even though the backend exposes all of it via `GET /api/data/gate` and the readiness payload. |
| 13.2 | Strategy discovery view (jobs, periods, patterns, counts, candidates, R:R, validation, rejections, errors) | **PARTIAL** | "Safety & Proposed Patterns" shows proposals and approve/reject (`index.html:106-120`, `:417-446`) plus a "Mine proposals" button. No discovery job status, no historical period, no occurrence/validation detail, no rejection reasons. |
| 13.3 | Strategy catalogue view (name, version, scope, state, rules, IS/OOS/demo, risk, limitations, reports, approval history) | **MISSING** | No catalogue concept exists. |
| 13.4 | Approval and deployment view | **MISSING** | No such view. (Readiness/alerts view exists but covers system state, not strategy approval.) |
| 13.5 | Trading operations view (broker env, feed, active strategies, signals, rejects, orders, positions, protection, P&L, risk status, reconciliation, suspended strategies, warnings) | **PARTIAL** | Strong on broker status, positions, trades, decisions, unmanaged positions, readiness, alerts. Missing: per-order status timeline, protective-order status per position, explicit demo/live labelling on the page, suspended-strategy list. |
| 13.6 | Backend independently validates permissions and transitions | **MET** | Session auth on all `/api` except health and auth (`index.js:89-94`); every state change re-validated server-side. |

### 4.14 Persistence, auditability, recovery (§14)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 14.1 | Durable records for the listed artefact set | **PARTIAL** | Present: trades, decisions, order intents, audit log, risk config + proposal history, emergency state, shutdown records, run state, proposals, ML model, adaptive weights, reports. **Absent:** strategy versions, approval records, deployment state, backtest configurations, research jobs, pattern definitions with versions, dataset provenance. |
| 14.2 | Transaction boundaries / idempotency / constraints | **PARTIAL** | Per-collection serialize + atomic rename (`storage.js:11-53`); `mutate` gives read-modify-write atomicity. No cross-collection transactions, no DB constraints. |
| 14.3 | Migration practices | **MISSING** | No migrations, no schema version field in any store. |
| 14.4 | No credentials in reports/audit | **MET** | Audit `record()` docstring: "fields must not contain secrets". `.env` holds credentials and is git-ignored; session secret is generated and stored `0600`. |
| 14.5 | Failed persistence must not claim deployed state | **PARTIAL** | No deployment state exists. Writes throw rather than silently succeed, which is the right foundation. |

### 4.15 Performance and scalability (§15)

| # | Status | Evidence / gap |
|---|---|---|
| Long jobs not blocking execution/safety | **PARTIAL** | The engine cycle is `setInterval`-driven and the monitor runs separately (`tradingEngine.js:275-298`). But `/api/backtest/live` runs synchronously inside the HTTP handler and blocks the process for the duration, which **does** delay engine cycles. No job queue, cancellation or progress reporting. |
| Caching, incremental calcs, concurrency limits, retries, logging volume | **PARTIAL** | Bounded in-memory bars with caps; no incremental feature cache; no job scheduler. |

### 4.16 Testing programme (§16)

| # | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 16.1 | Unit tests for the listed areas | **PARTIAL / strong** | 320 passing tests covering data quality, timeframes, risk, execution, storage concurrency, audit, reports, no-trade, recovery. **Missing by feature:** swing/wave detection, pattern matching against price history, occurrence counting, reward-to-risk *research screening*, lifecycle transitions, approval enforcement, monitoring thresholds, amendment generation. |
| 16.2 | Historical research tests (dataset identity, multi-period, reproducible counts, overlap, lookahead-leak detection, OOS discipline, cost effect, ambiguous candles, rejection, no fabrication) | **MISSING** | None of these exist. The lookahead-leak test is explicitly required and is absent. |
| 16.3 | Integration tests across the full chain | **PARTIAL** | `engineCycleWiring`, `paperEngineWiring`, `execution`, `dashboardUnmanaged`, `entryPauseWiring` cover real wiring. No integration test spans discovery → validation → approval → deployment. |
| 16.4 | End-to-end lifecycle test + 10 named negative tests | **PARTIAL** | Existing negative tests cover: duplicate signal → no duplicate order, uncertain state → no blind resubmission, stale data → no order, risk failure → no order, unmanaged position blocks entries. **Absent:** unapproved strategy cannot enter live execution, stale approval cannot authorise a changed version, unauthorised user cannot approve/deploy, amendment cannot silently replace, suspended strategy cannot enter, persistence failure cannot fake deployment. |
| 16.5 | Run existing suite, no weakening of tests | **MET** | 320/320 pass, unmodified. |

---

## 5. Acceptance criteria matrix (§17)

| Criterion | Verdict | Basis |
|---|---|---|
| **A. Repository and architecture** | **PASS** | Inspected; new work integrated into the existing Express/engine/storage architecture; user work preserved; no unused critical modules found. |
| **B. Market intelligence** | **PARTIAL** | Real ingestion ✔, quality controls ✔, multi-instrument/timeframe ✔, no-leak in what exists ✔; **reproducible multiscale/wave analysis ✘**, confirmed vs provisional structures ✘. |
| **C. Pattern and strategy discovery** | **PARTIAL** | Trade-condition mining ✔ with sample floors and OOS; **price-pattern search ✘**, candidate IDs/versions ✘, exclusion ledger ✘, overlap handling ✘. R:R arithmetic ✔. No fabrication ✔. |
| **D. Research integrity** | **PARTIAL** | Evidence classes ✔, OOS split ✔, uncertainty reported ✔, reproducibility of *results* ✘ (no dataset refs), costs in backtest ✘, walk-forward/purging ✘, leakage test ✘. |
| **E. Strategy management** | **FAIL** | No strategy registry, no versions, no lifecycle, no version-specific approval. The mission's central governance requirement is absent. |
| **F. Demo execution** | **PASS (with caveats)** | Real demo integration exercised; intents/fills/protection/closure/reconciliation verified; failure and recovery paths tested; simulated vs broker evidence separated. Caveats: partial fills and margin refusal not modelled; some closes carry estimated P&L (correctly excluded from evidence). |
| **G. Automatic execution** | **PARTIAL** | Automatic execution works and risk is genuinely independent (✔), unapproved cannot go live because live is locked (✔ by absence), reconciliation ✔, restart ✔. **"Only approved and deployed strategies execute" ✘** — the ensemble runs unconditionally. Live stays disabled ✔. |
| **H. Monitoring and amendments** | **FAIL** | No deterioration detection, no expectation baseline, no amendment proposals, and adaptive weights/ML mutate behaviour without versioning. |
| **I. Operational quality** | **PARTIAL** | Tests run and passing ✔, regressions none ✔, docs extensive ✔. This document supplies the complete/partial/blocked breakdown. |

---

## 6. Phase status (§18)

| Phase | Status | Note |
|---|---|---|
| 1 — Inspection and baseline | **COMPLETE** | This document is the baseline record. |
| 2 — Core data and intelligence | **PARTIAL** | Data layer strong; multiscale/wave analysis absent; intelligence is an indicator ensemble rather than an explainable structure model. |
| 3 — Research and discovery | **PARTIAL** | Mining + evaluation primitives exist; the research pipeline (candidates → R:R screen → costs → qualification → reports) does not. |
| 4 — Strategy registry and approval | **NOT STARTED** | No registry, versions, lifecycle or approval. |
| 5 — Demo execution and reconciliation | **SUBSTANTIALLY COMPLETE** | Strongest area. Gaps: partial fills, margin refusal, broker-reported P&L on external closes. |
| 6 — Automatic execution and monitoring | **PARTIAL** | Execution and risk complete; approval gating and monitoring/amendments absent. |
| 7 — UI, documentation, final verification | **PARTIAL** | Existing UI extended; catalogue/approval/discovery views absent; full test programme incomplete. |

---

## 7. Prioritised outstanding work

Ordered by dependency, since phases 4–6 depend on the registry existing.

### P1 — Research integrity defects (block criteria C and D)
1. ~~**Backtest has no cost model and cannot see intrabar SL/TP.**~~ **DONE** — cost model, intrabar
   exit detection and a named ambiguity policy are implemented and tested. See §11.1.
2. ~~**Synthetic-data results are reachable from the dashboard.**~~ **DONE** — every result carries
   `dataSource`, the dashboard shows a SYNTHETIC banner, and the label is set by the engine rather
   than by the caller. See §11.2.
3. **Multiple-testing correction is dead code.** `evaluation.significanceAfterMultipleTesting` is
   never called outside tests. Fix: wire it into the discovery path.
4. **No dataset reference.** Persist or hash the exact bars used by a research run and store the
   reference on the result.

### P2 — Multiscale and structure analysis (block criterion B)
5. Implement a swing/structure detector with explicit, scaled, versioned definitions: start, end,
   duration, amplitude, volatility context, confirmation rule, confirmed vs provisional state, and
   availability time (the candle at which it became knowable).
6. Add multiresolution analysis (wavelet or equivalent) with documented boundary handling and a
   reproducible output artefact. Justify the method rather than adding it for its own sake.

### P3 — Strategy registry, lifecycle and approval (block criteria E and G; prerequisite for H)
7. `src/strategy/registry.js`: stable ID, semantic version, immutable version records (rules, scope,
   datasets, results, limitations, approval, deployment, change history).
8. Lifecycle state machine with backend-enforced transitions across the twelve states in §7.
9. Version-specific approval records: who, when, which version hash, which instruments/timeframes,
   which execution mode; withdrawal; suspension.
10. Change detection that forces a new version when any material rule changes.
11. Deploy-gate: the engine may run **only** versions that are `APPROVED` + `DEPLOYED`.

### P4 — Research pipeline and evidence reports (block criteria C and D)
12. Candidate generation from discovered structures → explicit entry/SL/TP/exit/sizing/invalidation.
13. R:R screening against the historical path (plausibility, not just arithmetic).
14. Qualification using `evaluation` + the missing metrics (consecutive losses, duration, parameter
    stability, regime breakdown).
15. Per-strategy evidence report (sections A–I) with reproducible inputs and honest limitations.

### P5 — Monitoring and amendments (block criterion H)
16. Expectation baseline persisted per deployed version; rolling comparison with statistical
    thresholds; distinguish variance vs evidence vs execution failure.
17. Amendment proposal object, versioned and compared to the current approved version, requiring
    fresh approval.
18. Bring `adaptiveLearner` and `mlModel` under versioning/approval, or restrict them so they cannot
    alter deployed behaviour without a recorded change.

### P6 — UI and operational visibility
19. Strategy catalogue, discovery-job and approval/deployment views.
20. Data-health, bar-timestamp and confirmed/provisional display in the intelligence view.
21. Explicit demo/live labelling and per-order status timeline.

### P7 — Persistence and tests
22. Schema version field + migrations for every store.
23. Historical-research test suite (§16.2), including a deliberate look-ahead leak test.
24. End-to-end lifecycle test and the ten named negative tests (§16.4).

### Lower priority
25. Partial-fill and insufficient-margin handling in the execution path.
26. Correlated-exposure and maximum-slippage risk controls.
27. Move `/api/backtest/live` off the request thread into a job with progress reporting.

---

## 8. Next implementation task

**Status: the task below (P1.1 + P1.2) is complete.** See §11 for what was built and how it was
verified. Remaining in P1 are items 3 (wire the multiple-testing correction into discovery) and 4
(dataset reference on every research result).

The original recommendation, kept for the record:

**Recommended first task:** P1.1 + P1.2 — make the backtest honest before building anything on top
of it.

Concretely, in `src/backtest/engine.js`:

- Add a cost model (`spread`, `commissionPerLot`, `slippage`) applied to every fill, reported in the
  result alongside the gross figure, with the assumption string carried in the output.
- Replace the close-only exit check with an intrabar check against each bar's `high`/`low`. When both
  SL and TP fall inside the same bar, mark the trade `outcome: 'AMBIGUOUS'` unless finer data is
  supplied; count ambiguous trades separately and exclude them from the win-rate conclusion (or
  resolve them conservatively — the choice must be explicit and documented).
- Make the synthetic history path impossible to confuse with real data: the response must carry
  `dataSource: 'SYNTHETIC' | 'CTRADER_BARS'` and the dashboard must display it.

Every change above has a deterministic unit test with known expected results (§16.1: "Use
deterministic test cases with known expected results").

This ordering is deliberate: the mission forbids building discovery and validation machinery on a
backtest whose fills are optimistic and costless. Fixing it now prevents every later result from
being quietly overstated.

---

## 9. Findings that affect how this work should proceed

**N-1 — The mission document is untracked and absent from the worktree.**
`docs/AIS_MARKETS_MASTER_MISSION.md.txt` exists only in the main checkout and is untracked by git.
This worktree does not contain it, so any session started from this branch cannot read the mission
unless it is copied in or committed. It was read from the main checkout path for this audit.
**Recommendation:** commit it (or copy it into the worktree) so every future session has the same
source of truth. Not done here, because committing is the owner's call.

**N-2 — Folder casing and extension.**
The instructions refer to `Docs/`; the repository uses `docs/`. The mission file also ends in
`.md.txt`. Tooling and scripts that assume either will silently miss files.

**N-3 — Synthetic data reaches the operator UI unlabelled.**
The dashboard's "Backtest" and "Optimize" buttons hit endpoints that default to a random-walk
generator (`backtest/engine.js:5-28`). The results look like backtest results. This is the single
most consequential honesty defect in an otherwise unusually careful codebase, and it is exactly the
pattern §3.2 forbids ("Treating a simulated backtest as real broker execution").

**N-4 — Unversioned behavioural drift.**
`adaptiveLearner` changes ensemble weights after every closed trade and `mlModel` gates entries when
its probability threshold is met. Both are persisted but neither has a version, lineage, drift check
or approval step. Under §12.2 this is a silent amendment to trading behaviour.

**N-5 — The strongest existing assets should be kept, not rebuilt.**
`src/analytics/evidence.js`, `src/analytics/evaluation.js`, `src/risk/preTrade.js`,
`src/risk/limits.js`, `src/ctrader/trading.js` and `src/audit/audit.js` are well-scoped, pure where
it matters, and honestly documented. The missing work is mostly *additive* — a registry, a research
pipeline, a monitor — not a rewrite. §1 of the mission says not to rebuild functioning components;
that guidance applies strongly here.

---

## 10. Safety compliance during this audit

- No application code was modified.
- No document was overwritten; this file is new.
- No secrets were read into this document; `.env` and `data/ctrader_tokens.json` were not opened.
- No broker connection was made and no order of any kind was submitted.
- No destructive git operation was run; the working tree was clean at start and remains clean apart
  from this new file.

---

## 11. Change log — P1.1 and P1.2 (backtest honesty)

Both P1 items were implemented on this branch. Nothing was rebuilt: `src/backtest/engine.js` keeps
its shape (one strategy, one history, a metrics block) and gained the missing rigour. The public
surface is additive — every new field is a disclosure, not a new assumption.

### 11.1 Cost model and intrabar exits (P1.1)

`src/backtest/engine.js`:

- **Cost model.** `normaliseCosts()` validates `{ spread, slippage, commission }` and throws on a
  negative or non-numeric value rather than ignoring it. Spread and slippage are price units,
  commission is account currency per trade. `costDisclosure()` renders the assumption as a readable
  string ("no spread modelled; no slippage modelled; no commission modelled" when nothing is
  supplied), so a cost-free run says so out loud instead of looking free.
- **Fills are adverse.** `entryFill()`/`exitFill()` apply half the spread plus slippage against the
  trader on both sides. `settle()` reports gross and net separately and charges commission once per
  trade.
- **Intrabar exits.** `resolveExit()` tests each bar's `high`/`low`, not its close, so a stop or
  target touched inside a bar is now seen. A gap through a level fills at the bar's open — worse than
  the level, in the direction that hurts.
- **Ambiguity is named, not guessed.** When a stop and a target both fall inside one bar the bar
  cannot say which came first. The trade is marked `ambiguous`, the policy is recorded on the result,
  and the default is `stop-first` (conservative). `exclude` drops the trade from the statistics
  instead of guessing; `target-first` is available and must be chosen explicitly. Excluded trades
  stay in `allTrades` for audit and are never counted in win rate, profit factor, Sharpe or return.
- **No look-ahead added.** The signal is still built from bars closed at or before the entry bar and
  filled at that bar's close; a position entered at bar *i* is first exposed to bar *i+1*'s range.
  This ordering was made explicit in comments and is covered by the determinism test.
- **New result fields.** `dataSource`, `costModel`, `costAssumption`, `ambiguityPolicy`,
  `grossPnl`, `totalCosts`, `ambiguousTrades`, `excludedAmbiguous`, `forcedCloses`,
  `recordedTrades`. A position open at the end of the series is closed at the last close and marked
  `forced: true`, so it cannot be read as a strategy exit.

`src/index.js`: `/api/backtest/run`, `/api/backtest/live` and `/api/optimize/run` accept optional
`costs` and `ambiguityPolicy` in the body, and return `400` with the message on a validation failure
instead of a 500 or a silently defaulted run.

### 11.2 Synthetic data cannot be mistaken for evidence (P1.2)

- **The label is set by the engine, not the caller.** `runBacktest` derives `dataSource` from whether
  history was supplied: `SYNTHETIC` for `generateSyntheticHistory`, `SUPPLIED_HISTORY` for a caller's
  bars. `realBacktest.runOnLiveHistory` passes `dataSource: 'CTRADER_BARS'` explicitly. A caller can
  supply a label but cannot produce a result that omits one.
- **The dashboard says it.** `public/index.html` renders a `⚠ SYNTHETIC DATA` banner for both the
  backtest and optimize buttons, naming the alternative (“Backtest on live bars” for real cTrader
  history), and prints `costAssumption` and `ambiguityPolicy` above the table. API error
  bodies are now surfaced instead of being rendered as results.
- **Ambiguous trades are visible in the UI**, not just in the JSON.

### 11.3 Verification

- `tests/backtestCosts.test.js` — **19 new deterministic tests**, one per behaviour above, with known
  expected values rather than "it ran". They cover: exit detection on a level touched but never
  closed at, shorts mirroring longs, gap fill at the open, both-levels-in-one-bar ambiguity, all
  three policies, cost validation, adverse fills in both directions, gross/net separation, the
  synthetic-vs-supplied label, an unknown policy being refused, determinism, and costs actually
  reducing net P&L.
- **Full suite: 339 tests, 339 pass, 0 fail** (`npm test`, 10.2 s). No pre-existing test was changed
  or removed to make this pass.

### 11.4 What this does not yet fix

Recorded here so the next session does not over-read the result:

- **Costs are still zero unless someone supplies them.** The model exists and is validated, but the
  dashboard sends no `costs` and the engine defaults to `ZERO_COSTS`. A UI run therefore reports
  honestly ("no spread modelled") but is still optimistic. Per-instrument default costs are the
  obvious next step.
- **The ambiguity policy is a choice, not a resolution.** `stop-first` is conservative but it is
  still an assumption. Only finer-grained data can settle it.
- **Sizing still derives from the raw entry price.** `balance * riskPerTrade / stopDist` is computed
  off `bar.close` while the fill is `entryNet`; the difference is small but it means risk per trade is
  approximate once spreads are non-zero.
- **P1.3 and P1.4 remain open** — the multiple-testing correction is still dead code, and no research
  result yet carries a hash of the bars it used.

### 11.5 Safety compliance during this change

- No broker connection was made and no order of any kind was submitted.
- No live endpoint was called; no `.env` or token file was read.
- Changes are uncommitted on the branch; committing is the owner's call.
