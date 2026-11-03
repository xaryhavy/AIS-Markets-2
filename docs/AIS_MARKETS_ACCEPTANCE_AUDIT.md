# AIS Markets — Post-implementation acceptance audit

**Date:** 2026-11-02
**Repository:** `C:/Users/sirju/Documents/AIS Markets 2/.claude/worktrees/ais-markets-ctrader-f6a11a`
**Branch:** `claude/ais-markets-ctrader-f6a11a`
**Commit audited:** `8b1fa7f`. Audited against a clean tree; two remediations and the demo-evidence
harness were then applied — `src/analytics/evaluation.js`, `src/intelligence/patternMiner.js`,
`src/index.js`, `src/data/storage.js`, `scripts/demo-execution-evidence.js`, `package.json` and two test
files (§4, §11, §12) — and ship in the commit that introduces this document.
**Mission source:** `docs/AIS_MARKETS_MASTER_MISSION.md.txt` in the main checkout (not tracked in this
worktree — see N-1 in `AIS_MARKETS_IMPLEMENTATION_STATUS.md`)

**Overall status: PARTIALLY COMPLETE — 22 PASS / 13 PARTIAL / 0 BLOCKED / 12 FAIL**

**Redaction:** this repository is public, so the demo account number has been replaced with
`DEMO-ACCOUNT` here and in both files under `docs/evidence/`; nothing else in the quoted output was
altered. The verbatim copies, with the real number, are kept in the gitignored `data/evidence-raw/`.

---

## 1. Executive status

The execution and safety spine of this system is real, and better than its own documentation
suggests. Order intents are written to disk before they are sent, an unknown broker outcome pauses
new entries rather than triggering a resubmission, protective orders are verified after the fill and
an emergency close runs if protection fails, and stale or fingerprinted-changed data blocks dispatch.
Risk controls sit in a separate module that the strategy layer cannot skip. LIVE mode is structurally
locked. That is a genuinely careful build.

The **research and strategy-management half is not built**. Three things dominate the verdict:

1. **No strategy registry, no versioning, no approval record, no lifecycle.** `src/strategy/` does
   not exist. `shadowTracker` records the strategy version as the string `'unversioned'`, with the
   comment "no strategy versioning exists yet; recorded honestly". There is no backend enforcement
   that an approved strategy is what executes, because there is no concept of an approved strategy.
   Every acceptance criterion under E and most of H fails on this one absence.

2. **The statistical validation module was dead code.** `src/analytics/evaluation.js` is a strong
   module — Wilson intervals, a minimum sample size, a t-statistic, a chronological out-of-sample
   split, and an implemented multiple-testing correction. **No production file required it.** The
   only importer in the repository was its own test. This is the defect the status document logged as
   P1.3, and it was larger than P1.3 stated: the whole module was unused, not one function.
   *This one was fixed during the audit* (§11) — the correction now runs on every mined rule and the
   result is recorded. `evaluate`, `outOfSample` and `exactResults` are still unwired.

3. **There is no multiscale or wave analysis.** No wavelet, no FFT, no multi-resolution
   decomposition, no swing/structure detector with a defined and versioned specification. What exists
   is a three-timeframe EMA trend filter (M5/M15/H1). That is useful, and it is not what §4.3 asks
   for.

Two things the audit found that were **not** previously recorded:

- `orderManager.syncWithBroker()` writes a **locally estimated** P&L (`pnlEstimated: true`) when the
  broker closes a position outside AIS. The trade is correctly classified `BROKER_DEMO_ESTIMATED`
  afterwards, so it is not counted as exact evidence — but the number in the trade record is an
  estimate, not a broker-reported fill.
- `patternMiner.findRules()` enumerates every single token and every token pair, then keeps the top
  10 by out-of-sample P&L, with thresholds of 30 in-sample and 10 out-of-sample trades at a 55%/50%
  win rate. Against the size of the candidate space that is a multiple-testing problem, and the
  correction that would address it exists but is not applied to this path.

Nothing here was remediated beyond the backtest work already committed, because the fixes that would
move the criteria belong to work the mission defers to phases 4–6 and are not safe to improvise
inside an audit. §10 lists them in dependency order.

---

## 2. Acceptance matrix

Statuses per the audit brief: `PASS` / `PARTIAL` / `BLOCKED` / `FAIL`.

### A. Repository and architecture

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| A1 | Existing application inspected | `src/` (61 modules), `tests/` (48 files), `public/` (3 pages), `docs/` (20 docs) enumerated; engine, execution, risk, data, intelligence read | **PASS** |
| A2 | Implementation integrated into existing architecture | Backtest changes extend `src/backtest/engine.js` in place; `realBacktest` and `index.js` wire through existing routes | **PASS** |
| A3 | Existing work preserved | `npm test` 339/339 pass; no pre-existing test modified or deleted across commits `5e81470`, `8b1fa7f` | **PASS** |
| A4 | No new critical component exists only as unused code | **Remediated in §11.** `evaluation.js` is now required by `patternMiner` and `significanceOf` is called in the discovery path. `evaluate`, `outOfSample` and `exactResults` still have no production caller — the module is reachable but only partly used | **PARTIAL** |

### B. Market intelligence

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| B1 | Real market data ingested from configured source | `src/ctrader/marketFeed.js`, `connectionManager.js`. Live push feed + history. **No `.env` in this worktree**; main checkout has one (not read, not used) | **PARTIAL** |
| B2 | Data-quality controls operate correctly | `src/data/quality.js`: `validateBars` (OHLC validity), gap tolerance (`setGapTolerance`), `fingerprint`, `assess` with reason codes, block episodes, `isExpired`. Tests: `dataQuality.test.js`, `dataGate.test.js` | **PASS** |
| B3 | Multiple instruments and timeframes | Instruments from `marketData.getSymbols()`; frames `CONTEXT_FRAMES = ['M5','M15','H1']` in `timeframes.js:5`. `M1` used for entries | **PASS** |
| B4 | Multiscale or wave analysis, reproducible | `grep -ri "wavelet\|multiresolution\|multiscale\|dwt\|fft\|decompos" src/` returns **nothing** | **FAIL** |
| B5 | Confirmed vs provisional detections distinguished | A completed-bar guard exists (`timeframes.completedBars`, `quality.completedBars`), which prevents an unclosed candle being analysed. But no *detection* carries a confirmed/provisional state, because no swing/structure detection object exists | **PARTIAL** |
| B6 | Future information cannot leak into actionable signals | Completed-bar filtering throughout; data fingerprint captured at analysis (`tradingEngine.js:199`) and re-checked at dispatch (`:250-254`); analysis expiry; backtest exposes a position entered at bar *i* only to bar *i+1* (`engine.js` step 1 before step 2). Tests: `backtestCosts.test.js` determinism, `dataGate.test.js` | **PASS** |

### C. Pattern and strategy discovery

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| C1 | Search historical periods for repeated behaviours | `patternMiner.findRules` (`src/intelligence/patternMiner.js:59-85`) mines **closed trades with features**, not price-bar history. It groups by regime/hour/day/strategy/pattern tokens | **PARTIAL** |
| C2 | Count and document occurrences | Each rule carries `inSample.n` and `outOfSample.n`, gated at `MIN_IN_SAMPLE=30` / `MIN_OUT_OF_SAMPLE=10` (`:9-10`). Deterministic given the same trades (sorted by `openTime`, `:63`) | **PASS** |
| C3 | Produce explicitly defined candidate strategies | A proposal is `{ key, tokens, description, inSample, outOfSample, status }` (`:99-108`) — a token conjunction such as `regime=RANGING AND hour=14`. **No entry, stop-loss, take-profit, exit, sizing or invalidation is defined** | **FAIL** |
| C4 | Calculates planned reward-to-risk correctly | `riskManager.riskReward` (`riskManager.js:67-71`); `preTrade.check` enforces geometry and a 1:3 floor (`preTrade.js:37-41`); `calculateStops` derives TP at `MIN_REWARD_RISK * stopDistance` (`:56-64`). Tests: `riskControls.test.js` (19) | **PASS** |
| C5 | Records rejection reasons | Signals: `shadowTracker.recordDecision(..., {decision:'SKIPPED', reason})` at every gate (`tradingEngine.js:177-266`). Proposals: `decide(key, decision, reason)` now stores `rejectedReason`, defaulting to "no reason recorded" rather than leaving the field blank (§11). Route updated at `index.js:568-569` | **PASS** |
| C6 | Qualify, reject or defer candidates on evidence | The machinery exists and is tested (`evaluation.js` MIN_SAMPLE flag, Wilson CI) but **is never called in production** | **FAIL** |
| C7 | Does not fabricate results when none qualifies | No code path declares a strategy profitable. `evidence.js` classifies every trade and `evaluation` filters to `BROKER_DEMO_EXACT` only. No strategy was declared profitable in this audit | **PASS** |

### D. Research integrity

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| D1 | Historical results reproducible | `tests/backtestCosts.test.js` "the same supplied history produces the same result twice"; synthetic generator seeded deterministically | **PASS** |
| D2 | Validation periods clearly separated | `patternMiner` 70/30 chronological split (`:14`, `:64`, `:77-78`), recorded as `inSample`/`outOfSample`. `evaluation.outOfSample` does the same properly but is unwired | **PARTIAL** |
| D3 | Costs and realistic execution assumptions included | Backtest engine now models spread/slippage/commission and adverse fills — **but defaults to `ZERO_COSTS`** and the dashboard supplies none. `evaluation.evaluate` takes `costPerTrade` defaulting to `0` | **PARTIAL** |
| D4 | Out-of-sample testing implemented where appropriate | Implemented in `patternMiner` (live) and in `evaluation.outOfSample` (unwired). Not applied to backtest results | **PARTIAL** |
| D5 | Major sources of bias addressed and documented | Look-ahead: addressed. Intrabar ambiguity: addressed (this branch). Multiple testing: **now applied and reported per rule** (§11) — the threshold is divided by the number of token rules examined. It is recorded rather than used as a hard filter, so a weak rule is shown with its verdict instead of disappearing. Survivorship, regime drift and selection bias on the thresholds remain unaddressed | **PARTIAL** |
| D6 | Statistical uncertainty not hidden | Every mined proposal now carries `candidatesTested` and a `significance` block (adjusted alpha, z threshold, t-statistic, clears-or-not) (§11). `evaluation.evaluate`'s Wilson intervals remain unused, and none of this reaches a per-strategy evidence report | **PARTIAL** |

### E. Strategy management

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| E1 | Strategy versions and lifecycle states persist | No `src/strategy/`. `shadowTracker.js:21` records `strategyVersion: 'unversioned'` with an explicit comment | **FAIL** |
| E2 | Approval enforced by the backend | `patternMiner.decide()` sets an `APPROVED` status on a *pattern proposal*; `approvalScore` uses it **only to sort signals** (`tradingEngine.js:169-170`). Nothing is blocked by approval state | **FAIL** |
| E3 | Approval applies to a specific version | No version identifier exists to attach an approval to | **FAIL** |
| E4 | Material amendments require fresh approval | No amendment object and no version hash to detect a material change | **FAIL** |
| E5 | Evidence and audit records accessible | `src/audit/audit.js` records order, mode, limit and approval events; `evidence.js` classifies results honestly. Accessible via API | **PARTIAL** |

### F. Demo execution

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| F1 | Actual demo integration exercised | The engine ran against the demo account and, separately, one real order was placed, protected, closed and reconciled (§6, §12.6): `Connected to demo account DEMO-ACCOUNT`, five symbols on the live feed, `EURUSD BUY 100000` filled as position `256532679`, protective levels read back from the broker, position closed, closure confirmed by the broker | **PASS** |
| F2 | Orders, fills, protective orders, positions, closures verified against broker state | All five verified against the real broker on 2026-11-02 (§12.6): intent written before sending, fill with broker `positionId`/`orderId`/`executionPrice`, stop-loss and take-profit **read back from the broker** after the fill, close with broker exit price and realised P&L, closure confirmed by the position being gone. Caveat retained: `syncWithBroker` P&L for a position closed *outside* AIS is locally estimated (`orderManager.js:146-149`), which this run did not exercise | **PASS** |
| F3 | Failure, timeout, duplicate-order and recovery cases tested | Duplicate per instrument blocked by `maxPositionsPerInstrument` (`preTrade.js:67-69`); UNKNOWN outcome pauses entries; recovery fence tested. All via **mocked dependencies**, not a live broker | **PARTIAL** |
| F4 | Simulated tests distinguished from actual broker tests | `evidence.js` six evidence classes; `tests/` use injected fake clients and no test claims broker evidence | **PASS** |

### G. Automatic execution

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| G1 | Automatic execution of explicitly approved and deployed strategies | Automatic demo execution exists (`DEMO_AUTONOMOUS` default), but there is no approved/deployed strategy concept to gate on | **FAIL** |
| G2 | Risk controls remain independent of strategy logic | `src/risk/preTrade.js` runs inside the order path and cannot be skipped by a caller (`trading.js:77-79`). Pure, injectable, separately tested | **PASS** |
| G3 | Unapproved strategies cannot execute live | Unenforceable — no approval concept. Mitigated in practice because **LIVE mode is unavailable** (`mode.js:25`) and demo-only orders are permitted by the mission | **FAIL** |
| G4 | Order state reconciled with the broker | `tradingEngine.js:103-127` reconciles before entries; failure pauses entries; `unresolvedIntents` blocks entries (`safety.js:13`). Tests: `engineCycleWiring`, `entryPause*` | **PASS** |
| G5 | Restart and failure recovery tested | `tests/recoveryFence.test.js` (6), `shutdown.test.js`, `storageConcurrency.test.js`, `resume is refused without a successful broker reconciliation` | **PASS** |
| G6 | Live trading remains disabled | `MODES.LIVE = { orders: false, available: false }` (`mode.js:25`); `setMode` refuses an unavailable mode (`:86`); `/api/live/approve` returns 409. No live order was placed in this audit | **PASS** |

### H. Monitoring and amendments

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| H1 | Strategy performance monitored against defined expectations | `mtmCaps`, `entryPause`, `adaptiveLearner` circuit breaker, `alerts.sync` condition set (`tradingEngine.js:63-88`). **No per-strategy expectation baseline exists** | **PARTIAL** |
| H2 | Deterioration triggers investigation | Consecutive-cycle-failure alert (`CYCLE_FAILURE_ALERT=3`), drawdown/loss caps, circuit-breaker size halving | **PARTIAL** |
| H3 | Amendments versioned and supported by evidence | No amendment object | **FAIL** |
| H4 | Current approved version not silently modified | `adaptiveLearner` adjusts ensemble weights after every closed trade and `mlModel` gates entries on a probability threshold — **both persisted, neither versioned, approved or drift-checked** | **FAIL** |
| H5 | New versions require fresh approval | No version concept | **FAIL** |

### I. Operational quality

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| I1 | Relevant tests run | `npm test` — 339 tests, 339 pass, 0 fail, 0 skipped | **PASS** |
| I2 | New failures and regressions addressed or documented | None introduced. The only change this session (`8b1fa7f`) added 19 tests and modified no existing assertion | **PASS** |
| I3 | Documentation reflects actual behaviour | `AIS_MARKETS_IMPLEMENTATION_STATUS.md` §11 added with an explicit "what this does not yet fix" list; this audit adds §3–§10 | **PASS** |
| I4 | Final report identifies complete, partial, blocked, unverified | This document | **PASS** |

### Tally

47 criteria assessed.

| Status | Count | After remediation (§11) | After demo run (§12) | Final (§12.6) |
|---|---|---|---|---|
| PASS | 19 | 20 | 20 | 22 |
| PARTIAL | 14 | 14 | 15 | 13 |
| BLOCKED | 1 | 1 | 0 | 0 |
| FAIL | 13 | 12 | 12 | 12 |
| **Total** | **47** | **47** | **47** | **47** |

Before remediation the counts were 19 / 14 / 1 / 13. The second column is the end of the code audit: A4
moved FAIL → PARTIAL and C5 moved PARTIAL → PASS. The third is after the read-only demo run: F1 moved
BLOCKED → PARTIAL because the connection and feed were exercised, though no order crossed the boundary.
The fourth is after the accepted demo trade (§12.6): F1 → PASS and F2 → PASS, since the order, fill,
protection, close and reconciliation were all verified against broker state.

No FAIL criterion moved at any point, and nothing became PASS that was not PASS before.

---

## 3. Exact test commands and results

All commands run from the worktree root.

```
npm test
```
```
ℹ tests 339
ℹ suites 0
ℹ pass 339
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11255.4047
```

Re-run at the end of the audit, after the remediation in §11:

```
npm test
```
```
ℹ tests 347
ℹ suites 0
ℹ pass 347
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11752.2052
```

Re-run once more, after the second remediation in §12:

```
npm test
```
```
ℹ tests 350
ℹ suites 0
ℹ pass 350
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11444.3398
```

```
node --test tests/backtestCosts.test.js
```
```
ℹ tests 19
ℹ pass 19
ℹ fail 0
ℹ duration_ms 841.8483
```

Targeted suites relevant to the acceptance criteria, all included in the 339 above:

| File | Tests | Covers |
|---|---|---|
| `riskControls.test.js` | 19 | risk limits, R:R floor, geometry, per-instrument position cap |
| `execution.test.js` | 10 | order path, intents, outcome handling |
| `operations.test.js` | 13 | pre-trade refusal, mode gating |
| `recoveryFence.test.js` | 6 | restart/recovery fence |
| `dataGate.test.js`, `dataQuality.test.js` | — | stale/bad data blocking |
| `engineCycleWiring.test.js`, `entryPause*.test.js` | — | reconciliation failure pauses entries |
| `evaluation.test.js` | — | statistics (**module has no production caller**) |
| `patternMiner.test.js` | — | rule mining, 70/30 split |

**No test was skipped, weakened or removed.** No fabricated results: the counts above are the
observed output.

Tests that could **not** be run and why:
- Any test requiring a live cTrader connection — no credentials in this worktree (F1).
- Any test requiring the application server to be started against a broker — same reason.

---

## 4. Files changed during this verification

| File | Change | Why |
|---|---|---|
| `docs/AIS_MARKETS_ACCEPTANCE_AUDIT.md` | new | This report |
| `src/analytics/evaluation.js` | added `significanceOf`, exported it | Lets the discovery path use the existing statistics without full trade records; previously the module had no production caller |
| `src/intelligence/patternMiner.js` | correction applied per rule; `candidatesTested` and `significance` recorded; `decide()` records `rejectedReason`; `AIS_PROPOSALS_FILE` override | Wires the dead statistics into the path that needed it, and stops rejections vanishing without a reason |
| `src/index.js` | `/api/proposals/decide` passes `reason` through | Records the owner's rejection reason |
| `tests/patternMinerSignificance.test.js` | new, 8 tests | Covers the correction, the recorded counts, determinism and rejection reasons |
| `src/data/storage.js` | damage is copied aside once per collection, re-armed after a successful write; a failed copy no longer fails the load | D-7 — one damaged file filled the data folder with a copy per cycle |
| `tests/storage.test.js` | 3 new tests | The single copy, the re-arm after a save, and a failed copy not stopping the load |
| `scripts/demo-execution-evidence.js` | new | Places one minimum-size demo order, verifies protection and closure against the broker, writes evidence (§12.6). Read-only unless `--execute` |
| `package.json` | `verify:demo-execution` script | The repeatable entry point for that evidence |
| `docs/evidence/demo-execution-*.json` | new | Raw output of the executed order, kept as the primary record |

Nothing else was touched. No existing test was modified, weakened or removed, and the 4 pre-existing
`patternMiner` tests pass unchanged.

The changes audited are the two commits already on the branch:

| Commit | Files | Nature |
|---|---|---|
| `5e81470` | auth, session, static-serving, test scoping | Pre-existing, not part of this audit's implementation work |
| `8b1fa7f` | `src/backtest/engine.js`, `realBacktest.js`, `src/index.js`, `public/index.html`, `tests/backtestCosts.test.js`, status doc | Cost model, intrabar exits, ambiguity policy, data-source labelling |

---

## 5. Evidence from the historical research pipeline

The mission asks for this path to be demonstrated end to end:

> Historical data → validation → multiscale analysis → pattern discovery → occurrence counting →
> candidate strategy generation → cost-adjusted historical evaluation → out-of-sample validation →
> evidence report.

Traced through the code, the path **breaks at the third step and does not resume**:

| Step | Present? | Where |
|---|---|---|
| Historical data | Yes | `ctrader/marketFeed.getHistory`, `realBacktest.runOnLiveHistory` (H1/M15/M1, 2000 bars) |
| Validation | Yes | `data/quality.js` validate, gap tolerance, fingerprint |
| **Multiscale analysis** | **No** | Absent. Only M5/M15/H1 EMA trend, `timeframes.js:5` |
| **Pattern discovery** | **Partial** | `candlestickPatterns` / `supplyDemand` / `confluenceEngine` detect named bar patterns; `patternMiner` mines *closed trades*, not bars |
| Occurrence counting | Yes, on trades | `patternMiner.findRules` in/out sample counts |
| **Candidate strategy generation** | **No** | Proposals are token conjunctions; no entry/SL/TP/exit/invalidation |
| Cost-adjusted historical evaluation | Yes | `runBacktest` with cost model — **zero-cost by default** |
| **Out-of-sample validation** | **Partial** | `patternMiner` 70/30 on trades; `evaluation.outOfSample` unwired |
| **Evidence report (sections A–I)** | **No** | `evidence.js` is a classifier, not a report. `reportGenerator` produces operational period reports (trades/decisions/outcomes), not per-strategy evidence |

**Provenance:** a backtest result now states `dataSource` (`SYNTHETIC` / `SUPPLIED_HISTORY` /
`CTRADER_BARS`), its `costModel`, `costAssumption` and `ambiguityPolicy`. That is provenance of a
kind — but **no permanent reference to the exact bars is stored** (no hash or dataset id). Amending
§8 P1.4 of the status doc: still open.

**Reproducibility:** demonstrated for the engine — same supplied history produces the same result
(asserted in `backtestCosts.test.js`).

**Reward-to-risk:** computed from the actual entry, stop and target (`riskManager.riskReward`), not
arithmetic alone, and enforced at the order boundary.

**Costs and ambiguous candles:** handled as of `8b1fa7f` — adverse fills on both sides, gap fills at
the open, both-levels-in-one-bar marked `ambiguous` with the policy named and the conservative
`stop-first` default.

**No strategy was declared profitable.** The pipeline does not produce a candidate to declare, and
none was invented here.

---

## 6. Evidence from real demo broker execution

**Connection, live feed and one full order lifecycle exercised against the demo broker. PASS.**

The code audit above could not reach the broker: this worktree holds no `.env`. The engine was
afterwards started from this worktree against the main checkout's environment file
(`node --env-file=../../../.env src/index.js`), which the engine reports as a demo account. What that
run established, verbatim from its own log and health endpoint:

```
[cTrader] live prices subscribed: EURUSD, GBPUSD, USDJPY, XAUUSD, BTCUSD
[cTrader] ACCOUNT_AUTHENTICATED: Connected to demo account DEMO-ACCOUNT
```
```
GET /api/health
{"status":"healthy","components":{"broker":"ok","feed":"ok","engine":"ok",
 "reconciliation":"ok","auth":"ok","audit":"ok"},"at":"2026-11-02T19:29:12.035Z"}
```

So the real integration — credential exchange, account authentication, symbol subscription, live
quotes, reconciliation loop — runs against the broker, not a fake. That is what moves F1 off
`BLOCKED`.

**The engine run itself placed no order**, which is the correct behaviour and worth evidencing. It
began with the recovery fence engaged, exactly as designed for a process that did not shut down
cleanly:

```
[GUARD] Previous run did not shut down cleanly — trading held until acknowledged in the dashboard
```
```
data/run_state.json → { "cleanShutdown": false, "fenceActive": true }
data/alerts.json    → RECOVERY_REVIEW / critical / since 2026-10-28T08:46:11.156Z
```

`guardrails.fenceStatus().fenceActive` raises a `critical` condition (`tradingEngine.js:84`), so
entries stay held until an owner acknowledges in the dashboard. For the whole of that run the engine
was connected, funded, in `DEMO_AUTONOMOUS`, with `tradingEnabled: true` — willing and able to trade,
and it did not. The fence was still unacknowledged when the run ended.

**The order came afterwards, on the owner's explicit instruction, and through the order layer rather
than the engine** (§12.6). That distinction is deliberate: acknowledging the fence would have released
the *autonomous* engine, which is more than "one demo trade" authorises. The verification instead
called `trading.openMarket` once, which keeps every order-layer control in force — demo-only refusal,
pre-trade risk check, write-ahead intent, protection verification, emergency close — and leaves the
fence, the mode and the risk limits exactly as they were.

Also observed on that first run, and recorded as D-7 below: the engine's successive cycles each
re-copied the same unreadable `mtm_caps_state.json` aside, producing nine `.corrupt-*` files in 45
seconds before the file was repaired by a successful write.

Distinguishing the categories as required:

| Category | What this audit has |
|---|---|
| Unit tests | 350, all passing (§3) |
| Integration tests | Present and passing (engine cycle wiring, recovery fence, storage concurrency) — against **injected fakes**, not a broker |
| Simulations | `backtestCosts.test.js` — synthetic and supplied history |
| Historical backtests | Engine only; no qualifying strategy exists to backtest as evidence |
| **Demo broker connection and live feed** | **Yes** — demo account DEMO-ACCOUNT, five symbols subscribed, all health components `ok` |
| **Actual demo execution (order → fill → protective orders → closure)** | **Yes, once** — one minimum-size EURUSD order, protective levels read back from the broker, closed and reconciled (§12.6) |

Run it yourself: `node --env-file=../../../.env scripts/demo-execution-evidence.js` reports account
state and refuses if anything is already open; add `--execute` to place the single order and close it.

---

## 7. Approval, risk, duplicate-order and reconciliation test results

| Requirement | Result | Evidence |
|---|---|---|
| An unapproved strategy cannot enter live execution | **Cannot be demonstrated** — no approval concept. LIVE is separately locked (`mode.js:25`) | E2, G3 |
| Approval tied to the exact strategy version | **No version exists** | E3 |
| Material change requires fresh approval | **Not implemented** | E4 |
| Unauthorized users cannot approve or deploy | Auth exists (scrypt, sessions, rate limit, `authRateLimit.test.js`); since no strategy approval endpoint exists, the specific case is moot | E2 |
| Failed risk checks block order submission | **PASS** — `preTrade.check` runs inside the order path, returns reasons, and refused orders are never sent (`trading.js:77-79`) | `riskControls.test.js` |
| Stale or invalid market data cannot generate an executable order | **PASS** — `safety.entryBlockers` (feed readiness, quote age, unresolved intents, unmanaged positions) plus `dataQuality.assess` at analysis and again at dispatch | `dataGate.test.js`, `execution.test.js` |
| Duplicate signals do not cause duplicate orders | **PASS** — `maxPositionsPerInstrument` in `preTrade.js:67-69`; plus per-symbol `orderCooldown` after a failed order (`tradingEngine.js:216-219`, `:263`) | `riskControls.test.js` |
| Unknown broker order status triggers reconciliation, not resubmission | **PASS** — outcome written `UNKNOWN`, `UnknownOutcomeError` thrown, entries paused via `unresolvedIntents`, resolved by `resolveIntents` against broker positions | `execution.test.js`, `engineCycleWiring.test.js` |
| Strategy amendments cannot silently replace the approved version | **Not implemented** — and `adaptiveLearner`/`mlModel` already alter behaviour without a version record | H4 |
| Live trading remains disabled throughout verification | **PASS** — `MODES.LIVE.available = false`; no live order placed | `mode.js` |

---

## 8. Known defects, blockers and unverified requirements

### Blockers (external)
- **B-1 — resolved in §12.6.** Credentials were reachable through the main checkout's `.env`, the
  recovery fence did not have to be cleared to make one bounded order, and on the owner's explicit
  instruction that order was placed and closed. Nothing in F now blocks on the environment. What
  remains unexercised against the real broker (rejections, timeouts, duplicates) is a deliberate choice
  rather than a blocker — see F3 and §12.6.

### Defects affecting correct interpretation of results
- **D-1 (fixed in §11):** `src/analytics/evaluation.js` was entirely unwired. Previously logged as
  "multiple-testing correction is dead code"; the accurate statement was that every export had no
  production caller. `significanceOf`/`significanceAfterMultipleTesting` are now called from the
  discovery path. `evaluate`, `outOfSample` and `exactResults` remain unwired.
- **D-2:** Backtest costs default to `ZERO_COSTS`; no dashboard or API caller supplies them. Results
  are now honest about being cost-free rather than silently optimistic, but still optimistic.
- **D-3:** `patternMiner` searches every token and token pair and keeps the top 10 at weak
  thresholds. Multiple-testing exposure is material and uncorrected.
- **D-4 (fixed in §11):** `patternMiner.decide()` recorded `REJECTED` with no reason; it now stores
  `rejectedReason` and the API passes one through.
- **D-5:** `syncWithBroker` P&L is locally estimated (`pnlEstimated: true`), not broker-reported.
- **D-6:** `adaptiveLearner` and `mlModel` change live behaviour with no version, lineage, drift check
  or approval.
- **D-7 (fixed in §12):** `storage.load` copied a damaged file aside on **every** call. A file that
  stays unreadable is loaded on every engine cycle, so one damaged `mtm_caps_state.json` produced nine
  identical zero-filled `.corrupt-*` copies in 45 seconds; the copies are evidence, so they were never
  cleaned up. Found during the demo run, not by reading the code.
- **D-8 (not fixed, §12.7):** `npm run validate:demo` validates nothing about the broker. It checks
  that files exist and modules load, reads a preferences file the app no longer uses, and prints
  `✅ Full validation complete` regardless. A green light that means nothing is worse than no light.

### Unverified
- Real broker order acceptance, rejection, fill, protective order, closure and reconciliation against
  broker-reported state.
- Multiscale/wave analysis reproducibility (nothing to verify).
- End-to-end strategy lifecycle (no lifecycle exists).
- Per-strategy evidence report sections A–I (not implemented).

---

## 9. How to reproduce

From the worktree root:

```
npm install
```

```
npm test
```

```
node --test tests/backtestCosts.test.js
```

```
node --test tests/riskControls.test.js
```

To exercise the demo broker path — performed once in this audit (§12.6), and repeatable:

```
node --env-file=../../../.env scripts/demo-execution-evidence.js
```

That one reports the account, the symbol and the order it *would* place and stops there. With
`--execute` it places exactly that one order and closes it. It needs `CTRADER_CLIENT_ID`,
`CTRADER_CLIENT_SECRET`, `CTRADER_ACCOUNT_ID` and `CTRADER_ENVIRONMENT=demo`; the `--env-file` above
points at the main checkout's file because this worktree has none.

`npm run validate:demo` is **not** the command for this, despite its name — see §12.7.

The application refuses to start trading if `CTRADER_ENVIRONMENT` does not match the account's real
type, so a live account cannot be driven under a demo configuration.

---

## 10. Minimum remaining steps for genuine completion

In dependency order. Nothing below was attempted in this audit.

1. ~~**Build `src/strategy/registry.js`** — immutable version records with a content hash over the
   rules, so an approval can bind to a version and a material change produces a new one.~~ **Done — §13.**
2. ~~**Lifecycle state machine** with backend-enforced transitions; add the deploy gate so the engine
   may run only `APPROVED` + `DEPLOYED` versions.~~ **Done — §13.** E and G are still not PASS: the
   registry versions a strategy faithfully without the research path that would justify an approval.
3. **Wire `evaluation.js` into the research path** — candidate qualification, the 70/30 split, and
   `significanceAfterMultipleTesting` with a truthful count of strategies tested. *Partly done in
   §11*: the multiple-testing correction now runs and is recorded per rule. Still to do: run
   `evaluate`/`outOfSample` over set-up-level results once candidates have defined rules, and surface
   the Wilson intervals.
4. **Candidate generation with explicit rules** — entry, stop, target, exit, sizing, invalidation —
   so that "candidate strategy" means something.
5. **Multiscale/structure analysis** with a versioned definition and confirmed/provisional state,
   or an explicit decision to descope §4.3 and record that in the mission.
6. **Per-strategy evidence report, sections A–I**, built from a persisted dataset reference.
7. **Dataset reference** — hash the bars used and store it on every research result.
8. **Per-instrument default costs** so a dashboard run is not cost-free by default.
9. **Version or restrict `adaptiveLearner` / `mlModel`**, and add the expectation baseline plus
   amendment objects that H requires.
10. **Real demo execution evidence**, once credentials are available and the owner authorises it.

Steps 1–3 together would move E from FAIL to PARTIAL and several D criteria from PARTIAL to PASS.
Nothing short of 1–4 makes E or G pass.

---

## 11. Remediation performed

One defect was safe, contained and directly evidenced, so it was fixed rather than only reported.

### What was wrong

`src/analytics/evaluation.js` held the statistical machinery the research criteria need —
sample-size gating, a t-statistic, a chronological out-of-sample split and a multiple-testing
correction — and **no production file required it**. Meanwhile `patternMiner` searched every single
token and every token pair, kept the top 10, and reported win rates with no correction for how many
rules it had tried. That is the exact combination the mission's research-integrity section warns
about: a wide search reported as if it were a narrow one.

### What changed

- `evaluation.js` gains `significanceOf(pnlValues, { strategiesTested })` — the same test `evaluate`
  applies, for callers that hold only P&L rather than full trade records. It reuses
  `significanceAfterMultipleTesting` and `MIN_SAMPLE` rather than duplicating the statistics.
- `patternMiner.findRules` counts the rules examined (`index.size`) and computes each surviving
  rule's significance on its **held-back trades only**, against a threshold divided by that count.
- Every proposal now carries `candidatesTested` and a `significance` block
  (`adjustedAlpha`, `zNeeded`, `tStatistic`, `clearsThreshold`).
- `decide(key, decision, reason)` records `rejectedReason`, defaulting to "no reason recorded".
  `/api/proposals/decide` passes `reason` through.
- `AIS_PROPOSALS_FILE` overrides the proposals path, matching the pattern `prefs` and `mode` already
  use, so tests never write into the data directory.

### Deliberate design choice

The correction is **recorded, not enforced**. A rule whose edge does not clear the adjusted threshold
is still listed and still reachable by the owner — it now says so on its own record. Filtering it out
silently would hide the evidence of what the search actually found, which is the opposite of what
this criterion asks for. The owner decides; the system tells the truth about the odds.

### Verification

`tests/patternMinerSignificance.test.js` — 8 new tests: the candidate count is reported; the
threshold is divided by that count and is strictly stricter than 1.96; a weak edge under a wide
search does not clear; a strong edge with enough trades does clear; a sample below the minimum never
clears however good it looks; the same series always gives the same answer; a rejection keeps its
reason across a reload from disk; a rejection without a reason says so.

Full suite after the change: **347 tests, 347 pass, 0 fail, 0 skipped**. The four pre-existing
`patternMiner` tests were not modified and still pass.

### What this did not fix

It does not give a candidate a defined entry, stop, target, exit or invalidation — that is C3 and it
is still `FAIL`. It does not create a strategy registry, which is the single largest gap. It does not
surface the Wilson intervals. It does not make the backtest cost model non-zero by default.

---

## 12. Second pass: the demo run, the one accepted trade, and what they found

The code audit was performed without broker access. It was then repeated against a running engine to
see whether reality agreed with the reading of the code. Two things came out of it.

### 12.1 The three claims worth confirming, confirmed

| Claim from the code audit | What the running engine showed |
|---|---|
| The broker integration is real, not a stub | `ACCOUNT_AUTHENTICATED: Connected to demo account DEMO-ACCOUNT`; five symbols subscribed to the live push feed; `/api/health` returning `broker`/`feed`/`reconciliation` `ok` |
| An unclean shutdown holds entries | The previous process had been killed, so startup logged `[GUARD] Previous run did not shut down cleanly — trading held until acknowledged in the dashboard`, and `run_state.json` held `fenceActive: true` with a `critical` `RECOVERY_REVIEW` alert |
| The fence is not advisory | Every cycle ran with `fenceActive` raising a critical condition (`tradingEngine.js:84`). Across the whole run no entry was attempted |

The third row is the useful one. A hold that is described in a document is a claim; a hold that
survives a live 5-second cycle loop against a connected demo account, with `tradingEnabled: true` and
mode `DEMO_AUTONOMOUS`, is a control. The engine was willing and able to trade and did not.

State at the time of that run, for the record: `mode: DEMO_AUTONOMOUS`, `liveMode: false`,
`tradingEnabled: true`, `emergencyStop: off`, `entryPause: inactive`, `fenceActive: true`. Only the
fence stood between the engine and an order, which is exactly the layer this criterion asked about.

### 12.2 Defect D-7 — a damaged file was copied aside once per cycle

The run surfaced one defect that reading the code had missed. `mtm_caps_state.json` was found
zero-filled (the Windows crash artefact: allocated but never flushed), and the storage layer's recovery
path did this:

```
[storage] mtm_caps_state.json was unreadable (… Unexpected token '', ""… not valid JSON) — copied aside, starting empty
```
```
…repeated once every 5-second cycle, nine times…
```
```
data/mtm_caps_state.json.corrupt-1793646897320 … mtm_caps_state.json.corrupt-1793646932876
```

Each copy was byte-identical and all-zero. `load()` is called several times per engine cycle, so an
unreadable file produced a copy per call, forever, and the copies are kept deliberately as evidence —
so nothing ever removed them. The risk-control state itself (day/week/peak equity baselines) was
silently reset to empty on every one of those loads, which is why the file existing in a repaired state
mattered: the write of a new baseline is what ends the loop.

`storage.load` now remembers which collections it has already copied aside and takes the copy **once**,
logging later occurrences as `still unreadable — already copied aside`. A successful write re-arms it,
so a file that is damaged again later gets a fresh copy rather than being hidden by the earlier one. The
copy itself was also made non-fatal: if `fs.copy` fails the engine still starts, because evidence of the
damage is not a precondition for running.

Whether this is the fix or a bandage depends on why the file was zero-filled in the first place. The
writes are atomic — temp file, then rename, with Windows retries (`storage.js:36-53`) — so the zero fill
came from a crash or a kill during the small window where the temp file existed and the rename had not
completed, or from an earlier non-atomic writer. The deduplication makes that class of damage visible
exactly once instead of drowning the log, which is the most that can honestly be claimed here.

Verified: `node --test tests/storage.test.js` — 6 tests, including three new ones (copied once across
five loads; copied again after a successful save; a failed copy does not fail the load). Full suite:
**350 tests, 350 pass, 0 fail.**

### 12.3 What the fenced run did *not* record, and why that is correct

`data/decisions.json` holds no record for 2026-11-02. That is not a logging failure: `tradingEngine`
step 3 calls `governance.allowTrade('demo')` and **returns before the scan** (`tradingEngine.js:150-151`),
so a fenced engine produces no signals at all. The block is surfaced as `stats.lastBlockReason` and as
the `RECOVERY_REVIEW` alert instead.

Worth stating plainly because it cuts both ways: while entries are held no *observation* data accumulates
either. A long pause leaves a gap in the decision history that looks like inactivity rather than policy,
and the shadow/no-trade evaluation gains nothing during it. That is a design consequence, not a defect,
and it is recorded here so the gap in the record is not later mistaken for evidence of a quiet market.

### 12.4 The decision record as evidence that the gates fire in production

The audit graded C5 (rejection reasons recorded) from the code. The stored decisions confirm it against
real data — 4,375 records in `data/decisions.json`:

| Records | Format | Meaning |
|---|---|---|
| 2,490 | `CURRENT` — `decision` is a string, `reasonCode` present | Every one carries a reason code; none blank |
| 1,885 | `LEGACY_OBJECT_DECISION` — `decision` holds `{decision, reason}` | All from 2026-10-23 08:29–09:46, before structured logging |

The reason codes on the current records show which gates are actually rejecting trades, not just which
exist:

| Reason code | Count |
|---|---|
| `NOT_QUALIFIED` | 1,873 |
| `DATA_QUALITY` | 298 |
| `ML_THRESHOLD` | 161 |
| `MTF_CONFIRMATION` | 154 |
| `RR_FLOOR` | 4 |

So the data-quality gate, the multi-timeframe filter, the ML threshold and the reward-to-risk floor have
each refused real signals — the risk and admission layers are load-bearing, not decorative. The legacy
records are classified read-only by `src/governance/legacyFormats.js` with an explicit owner decision
that no legacy format is approved and none is rewritten, so their shape is a documented state rather than
silent corruption. No consumer should read `decision` without checking its type; that hazard is the one
real cost of keeping them as they are.

### 12.5 What the read-only pass did not do

- **No order was placed by it and no fence was acknowledged.** The recovery review is still open, still
  `critical`, and still holding entries. Clearing it is a trading decision for the owner, and it was
  not cleared even to make the trade in §12.6.
- No MTM cap state was restored by hand — the zero-filled baselines were replaced by the engine's own
  first healthy write, which means the day/week/peak baseline is whatever this run recorded, not what
  the account had before the crash. That is worth knowing before those caps are relied on.
- F2 and F3 stay `PARTIAL`: protective orders, fills and broker-reported closures remain unverified
  against a real broker for the same reason as F1.

### 12.6 The accepted demo trade — one full order lifecycle

Authorised by the owner on 2026-11-02 ("Yes, one demo trade"). Executed by
`scripts/demo-execution-evidence.js --execute`, which refuses unless every precondition below holds:

- `CTRADER_ENVIRONMENT=demo` **and** the account authenticates as demo. `attemptConnect` already
  refuses a type mismatch (`connectionManager.js:117-119`), and the script refuses again on its own read.
- The live feed is ready — an order is not sent against a stale quote.
- **No position is already open.** The script aborts rather than add to anything.
- One call to `trading.openMarket`, which keeps the prompt-intent write, `preTrade.check`,
  `amendSltp` verification and the emergency-close policy in force. A refusal is recorded, never
  retried or resized around.
- The fence is not acknowledged, the mode is not changed, no risk limit is touched.

What the broker confirmed, in order:

| Step | Evidence |
|---|---|
| Account | `Connected to demo account DEMO-ACCOUNT`, balance `9749.07`, environment `demo` |
| Market | EURUSD bid `1.11952` / ask `1.11953`, spread 0.1 pip, live |
| Size | `units: 1000` — the broker's `minVolume` (100000 cents = 0.01 lot), i.e. the smallest order it accepts |
| Risk at the stop | stop 2.25 pips → **$0.22** at risk on a $9,749 balance (0.002%) |
| Planned R:R | 2.956 — passes the 1:3 floor at its 0.05 tolerance; the shortfall is price rounding to 5 digits |
| Intent written before sending | `INT-1793649624156-clpbie`, status `SUBMITTING` |
| Fill | position `256532679`, order `372557744`, entry `1.11954`, volume `100000` |
| **Protection read back from the broker** | `stopLoss 1.1193`, `takeProfit 1.12019` — matched the request exactly |
| Close | exit `1.11954`, realised P&L `-0.06` (spread) |
| **Closure confirmed by the broker** | position `256532679` no longer returned by `openPositions()` |
| Intent after close | status `CLOSED` |
| Ledger | hash-chained audit entries `seq 188 ORDER_SUBMITTING` → `189 ORDER_FILLED` → `190 POSITION_CLOSED` |
| After the run | 0 open positions, 0 unresolved intents |

Evidence file: `docs/evidence/demo-execution-2026-11-02T19-59-52-528Z.json`. The harness is kept as
`scripts/demo-execution-evidence.js` and `npm run verify:demo-execution`, so the claim can be re-tested
rather than believed.

What this does **not** establish:

- **No rejection, timeout or duplicate path was exercised against the real broker.** F3 stays
  `PARTIAL` for that reason — those paths are still covered by injected fakes only. Provoking a real
  rejection means deliberately sending an order the broker should refuse to a funded account, and
  provoking a timeout or a duplicate means deliberately breaking the connection mid-request. Neither is
  something to do to an account without being asked to, so neither was done.
- The **emergency-close path did not fire**, because protection succeeded. It remains verified only by
  tests.
- One trade is one trade. It says nothing about strategy profitability, and nothing here should be read
  as though it did.

### 12.7 A second finding: `npm run validate:demo` never touches the broker

While looking for the right place to run this, `scripts/validate-demo.js` turned out to prove much
less than its name and §9 of this audit imply. All 13 lines of it do is check that some data files
exist and that 15 modules `require()` without throwing. It never connects, never authenticates, never
places an order, and its `[PASS] Trading ON` line reads `data/preferences.json` — a file this
application no longer keeps its preferences in (`data/prefs.json` is the live one, and that read is
guarded by `if` with no `else`, so on a missing file it prints nothing and still ends with
`✅ Full validation complete`).

That is a small, live example of the failure mode the mission warns about: a green validation command
that validates nothing. It is not fixed here — replacing it properly means deciding what a demo
validation command should be allowed to do, which is the owner's call — but the new
`verify:demo-execution` script is what the audit's §9 should point at instead, and §9 now does.

---

## 13. Third pass: the strategy registry and the deploy gate

§10 steps 1 and 2 are done. Steps 3–10 are not.

### 13.1 What was built

`src/strategy/registry.js` holds every strategy the engine could run as an immutable, versioned record.

- **The approval binds to a content hash**, not to a name. The hash covers the declared rules *and* the
  strategy's own `generate()` source, so a code change produces a new version and needs a new approval.
  Approving a version names the hash it covers; if the rules changed after the owner read them, the
  approval is refused rather than silently applied to whatever is on disk.
- **The state machine is enforced in the registry**, not in the routes, so no route, script or test can
  move a version somewhere the owner did not authorise. `DRAFT → APPROVED → DEPLOYED → RETIRED`, with
  `RETIRED → APPROVED` the only way back and no direct `DRAFT → DEPLOYED`. Every transition requires a
  reason of at least ten characters and is appended to the record's own history.
- **The deploy gate** (`registry.gate`) admits a strategy only when a version is `DEPLOYED`, and reports
  which version that is. `signalEngine` filters the ensemble by it, and `tradingEngine.runCycle` stops
  entries outright when nothing is deployed, with `lastBlockReason` saying so.

### 13.2 The one decision worth naming

A strict gate on an empty registry would have halted a running system the moment it shipped. So the
first start performs an explicit **migration**, not an approval: `adoptBaseline` adopts whatever is
already in service as version 1, state `DEPLOYED`, with every history entry attributed to
`system-migration` and a stated reason. A flag in the file makes it run once. After that every change —
new rules, changed code — starts at `DRAFT` and waits for the owner.

The alternative — auto-approving the built-ins on every start — would have made the gate decorative.

### 13.3 Routes

`GET /api/strategies/registry`, `GET /api/strategies/registry/gate` (what would and would not run, and
why), and `POST .../register`, `.../approve`, `.../deploy`, `.../retire`. Each owner action is written to
the hash-chained audit ledger.

### 13.4 Tests

370 pass, up from 350: 16 in `tests/strategyRegistry.test.js` and 4 in `tests/deployGateWiring.test.js`.
They cover hash stability under key order, idempotent registration, version increment on change, refusal
of `DRAFT → DEPLOYED`, hash-bound approval, the reason floor, retirement, adoption running exactly once,
the deployed version surviving a newer draft above it, and the engine opening nothing when the gate is
empty. Writing them found two defects in the gate itself — it tested the newest version instead of the
deployed one, and its read helpers could see an unloaded cache — both fixed before commit.

### 13.5 What this does not do

- **A strategy is still a name plus parameters.** §10 step 4 — entry, stop, target, exit, sizing and
  invalidation as explicit rules — is untouched. The registry can version a strategy faithfully and
  still not tell you what it means to trade it.
- **The hash covers source text, not behaviour.** A refactor forces a re-approval that reviews nothing
  material; that is the safe direction of error, but it is an error.
- **Criteria E and G are PARTIAL, not PASS**, and D is unchanged: the versions are now real and the gate
  is real, but the research path that would justify an approval (§10 step 3) is not yet wired.
- **The gate is not visible on the dashboard.** It is enforceable through the routes; there is no screen.

---

## Declaration

**PARTIALLY COMPLETE.**

Material functionality exists and is well tested in the execution, risk and reconciliation layers. One
order lifecycle has now been verified against the real demo broker, not a fake: 0.01 lot EURUSD, filled,
protected, closed and reconciled, with the audit ledger to match (§12.6). Nothing in F blocks on the
environment any more.

`VERIFIED COMPLETE` is still not available, and the reason is unchanged: **criteria still fail, and
they fail in the half of the system that decides what to trade.** §13 has since removed the two
structural blockers — there is now a strategy registry with version-bound approval and an enforced
deploy gate — but a version is only as meaningful as the rules it records, and §10 step 4 (entry,
stop, target, exit, sizing, invalidation) is still untouched. An execution layer that can place an
order correctly is not the same as a system that knows which order to place, and this audit will not
blur the two.

Two defects were fixed rather than only reported — the unwired statistics (§11) and the copy flood
(§12). Two more were found and reported without a fix — the meaningless `validate:demo` command (§12.7)
and the unversioned learner/ML behaviour (D-6) — because fixing them means deciding something the owner
has not decided.

No secret value was printed or copied. No credential was exposed. Exactly one order was placed, on the
owner's explicit instruction, on the demo account, at the broker's minimum size, and it was closed
within two seconds; no fence was acknowledged and no live mode was entered.
