# AIS Markets — Completion Register

Living record. Each row is backed by code I read or a command I ran. "Verified" means exercised by a test or a live demo run, not just present in code.

## Step 1 — Baseline (2026-10-25)

| Capability | Status | Evidence | Risk / gap |
|---|---|---|---|
| Server lifecycle, clean-shutdown marker, recovery fence | Verified (fence endpoints live-tested) | src/governance/guardrails.js, src/index.js SIGINT/SIGTERM handlers | Crash-vs-stop marker relies on process exit path; Ctrl+C not yet tested |
| API routes and authorisation | Partial | src/index.js routes; no authentication on any route | Any local process can change prefs, limits, approve proposals |
| cTrader auth / token refresh | Partial | src/ctrader/auth.js | Refresh method (GET vs POST) unverified; no refresh token to test with |
| Live market data (quotes, M1/M5/M15/H1 bars) | Verified (live demo run) | src/ctrader/marketFeed.js, src/data/marketdata.js | No candle validation (gaps, duplicates, incomplete bars); no freshness gate before orders |
| Order submission | Implemented-unverified for failure paths | src/ctrader/trading.js openMarket | Timeout after submission is reported as a failure; order may have filled |
| Protective orders (SL/TP) | Partial | trading.js amendSltp; verified on one demo position | If amend fails, close is attempted; if close also fails, position is left open and unrecorded |
| Position reconciliation | Partial | orderManager.syncWithBroker | Only tracks positions it created; broker positions without a local record are ignored |
| Risk admission | Partial | riskManager.checkRisk, guardrails.allowTrade | Limits hard-coded (not configurable/validated); open floating loss not counted in loss caps |
| Loss caps | Implemented-unverified (unit tests only) | guardrails.lossCapBreach, tests/guardrails.test.js | Uses broker balance and recorded trades only |
| Decision recording (EXECUTED/SKIPPED) | Partial | src/governance/shadowTracker.js recordDecision | Records only some rejection points; no structured reason codes |
| NO-TRADE outcome monitor | Missing (partial precursor) | shadowTracker.evaluateShadows judges against current price after 1 minute; no frozen levels, horizon, or ambiguity handling | Must be rebuilt per mandate |
| WAIT / NO-TRADE explicit states | Missing | Engine has TRADE-or-skip only | Must be added |
| Multi-timeframe analysis | Implemented-unverified | src/intelligence/timeframes.js (unit-tested) | Live use verified only through trend readings in the demo run |
| Learning (adaptive weights, ML model) | Partial | adaptiveLearner.updateOnTrade receives simulated legacy trades; ML validated on one split (37 selected trades) | Evidence not separated by type (demo / backtest / hypothetical / legacy) |
| Strategy evaluation (costs, OOS, multiple testing) | Missing | backtest engine ignores spread, slippage, commission | Backtest results optimistic |
| Owner reports (daily/weekly/monthly/yearly) | Partial, MISLEADING | src/reports/reportGenerator.js: every period is all-time to date; includes simulated trades; no period boundaries, costs, or reconciliation | Must be rebuilt |
| Dashboard | Partial | public/index.html | Shows connection and safety state from backend; not yet reviewed against records |
| Storage | Partial | src/data/storage.js (atomic writes added) | JSON files, no migrations, no schema versioning |
| Tests | 30 unit tests | `npm test` | No integration tests for execution paths |

## Defects found in Step 1 (ordered by severity)

1. **CRITICAL — unknown order outcome treated as failure.** `trading.openMarket` throws on timeout; `tradingEngine` records SKIPPED and sets a 10-minute cooldown. The broker may have filled the order. Result: an unrecorded, possibly unprotected position.
2. **CRITICAL — failed protection and failed close leave an unrecorded open position.** `openMarket` closes on amend failure but does not record the position if that close also fails.
3. **HIGH — no quote freshness check.** `isReady()` checks only that the feed was subscribed. The engine can act on a price of any age.
4. **HIGH — unmanaged broker positions are ignored.** `syncWithBroker` only reconciles local records.
5. **HIGH — owner reports are misleading.** "Daily" and "weekly" reports cover all-time data and include simulated trades.
6. **HIGH — simulated trades feed learning.** `checkAndClosePositions` settles legacy paper trades and passes them to `adaptiveLearner.updateOnTrade`.
7. **MEDIUM — NO-TRADE evidence is not frozen.** Outcomes are judged against a later price, not frozen levels and a horizon.
8. **MEDIUM — no authentication on the API.**

## Step 2 — Priority 1 status (2026-10-25)
- 1a unknown-outcome handling: DONE (unit-tested with fake broker; not fault-injected live)
- 1b unmanaged positions block entries: DONE (no automatic close — owner decision)
- 1c quote-age gate: DONE (15 s)
- Reporting defect (defect 5): DONE (period-correct, demo-only)
- Defect 6 (simulated trades feed learning), defect 8 (API auth): OPEN, owner decision
- Priority 2 (data integrity): DONE for validation, completed-only analysis, staleness, fingerprints (58 tests). Open items in docs/DATA_QUALITY.md.
- Priorities 3–7: NOT STARTED beyond earlier work. See docs/COMPLETION_REPORT.md.

## Status update — 2026-10-26 (end of day)

Test count: 150 pass (worktree). Evidence: docs/TEST_EVIDENCE.md.

### Work completed today
- Stuck history fetch: bounded (no-progress stop, chunk cap, 60 s deadline). Test: marketFeed.test.js.
- No-trade monitor write failure on Windows: transient rename retries. Test: storage.test.js.
- Repeated WAIT decisions collapsed per symbol and reason, frozen levels kept as pending outcomes. Test: waitDedupe.test.js.
- Owner connect, disconnect and logout audited. Live check passed. Test: auditOwnerActions.test.js.
- Owner-token failed-attempt lockout (5 failures / 15 min / 15 min lock). Live check passed. Test: authRateLimit.test.js.
- Recovery fence logic tested (crash, restart, acknowledgement). Run-state path made overridable for tests. Test: recoveryFence.test.js.
- Engine: three consecutive failed cycles raise CYCLE_FAILING. Test: engineFailureAlert.test.js.
- Live: recovery review acknowledged; trading resumed in DEMO_AUTONOMOUS (readiness enabled, audit verified).
- docs/SHUTDOWN_RECOVERY_MATRIX.md written: 16 scenarios with status per row.

### Corrections to the earlier register
- "NO-TRADE outcome monitor: Missing" is out of date. It is built (src/governance/noTrade.js runMonitor, frozen levels, ambiguity, expiry, separate outcomes). Evidence and remaining gaps: docs/NO_TRADE_MONITOR.md.
- "Owner reports: Partial, MISLEADING" is out of date. Period-correct daily, weekly, monthly and yearly reports exist. Remaining gaps are in the Priority 5 list below.

### Open items by priority
- **P1 safety:** defect 6 (simulated trades feed learning): needs owner decision (checkpoint). Defect 8 (API auth): done today (owner token and lockout).
- **P2 data:** market-understanding additions (not justified yet); provider-error counts; session-aware staleness; gap tolerance review (checkpoint: changes a trading gate).
- **P3 risk and execution:** correlated exposure; mark-to-market loss caps (checkpoint: new risk limit); exit management while entries are disabled (test needed); fault injection against the demo broker (needs owner approval); power-loss test.
- **P4 learning:** INVALIDATED status (needs invalidation rules: checkpoint); strategy versioning; evidence-type separation of records (legacy and simulated trades: checkpoint, owner decision); controlled promotion; strategy evaluation with costs and out-of-sample (not started).
- **P5 reports:** broker statement reconciliation; commission and swap storage; benchmark choice (owner decision); mark-to-market; analytical narrative.
- **P6 operations:** PAPER and DEMO_SUPERVISED modes (not implemented, refused); token rotation endpoint; alert delivery outside the dashboard.
- **P7:** sustained supervised demo validation and live-readiness assessment: not started.

### Verdict (unchanged)
Not ready for autonomous demo validation. Engineering partly complete (most of Priorities 1–3 built; open items above); validation not started beyond unit tests and short live checks. Live is not assessed and must not be enabled.

## Update — 2026-10-26 (later)
- **Defect (new, fixed):** tradingEngine reward-to-risk check used an undefined name (`limits`). Every unblocked signal failed the cycle. Live log shows 12 failed cycles on the demo server, no orders placed. Fixed; covered by tests/engineCycleWiring.test.js. Rule: none changed.
- **Provider error counts built:** src/ctrader/providerErrors.js counts timeouts, broker error responses and dropped sessions; exposed as `providerErrors` on /api/ctrader/status. Tests: tests/providerErrors.test.js (4).
- **Exits while entries are disabled:** tested through the real runCycle (tests/engineCycleWiring.test.js).
- **Demo fault injection:** paused at the owner's request ("build other priorities"). Not run.
- **Open, found today:**
  - The server was force-killed at 22:26 for the lockout test. The recovery fence is therefore active again (RECOVERY_REVIEW alert, open at 22:26). Trading is held until the owner acknowledges it.
  - CYCLE_FAILING is untested live.
  - The live server is still running the old engine code, which contains the `limits` defect, until restarted.
  - The blocker text "order outcome(s) not yet confirmed" is used for a failed reconciliation too. It is accurate but not specific.

## Update — 2026-10-26 (demo restart on fixed code)
- The earlier restart still showed cycle errors: `limits is not defined` was fixed, but a new ENOENT appeared from overlapping writes. Fixed in storage (unique temp names, per-collection write queue, atomic `mutate`). Test: tests/storageConcurrency.test.js.
- Demo server restarted on the fixed code at 23:03. Owner-approved acknowledgement applied (the earlier unclean stop had raised the review again). Over about five minutes and 65 cycles: 0 cycle errors, 0 monitor errors. No trades in that window.
- Open:
  - The earlier lost-update risk in `append`/`update` is fixed in code. Whether any record was lost is not verified. Worth a read-only check of the decisions and outcomes files for gaps.
  - The server is started with `timeout -s INT` so a bounded run ends with a clean stop. Plain `timeout` (hard kill) leaves the recovery fence on the next start.
  - CYCLE_FAILING alert still not verified live.
  - Demo fault injection still paused.

## Update — 2026-10-26 (build of remaining non-decision items)
- **Read-only record check:** decisions.json (2986) and no_trade_outcomes.json (3341): no duplicate ids, no orphaned outcomes. The 140 resolved outcomes without their own decision are collapsed repeats, each linked to a kept decision. No detectable loss; a lost append would leave no trace, so this does not prove none occurred.
- **Owner token rotation built:** `POST /api/auth/rotate` (needs the current token); old token refused at once; only a hash stored; audit AUTH_ROTATED. Tests: tests/authRotate.test.js (3). Full suite: 164 pass.
- **Architecture map:** docs/ARCHITECTURE_MAP.md.
- **Autonomy readiness matrix:** docs/AUTONOMY_READINESS_MATRIX.md. Verdict: Not ready.
- **Not built, awaiting owner decisions:** PAPER and DEMO_SUPERVISED modes (authority design), learning evidence separation and legacy trades (defect 6), gap tolerance, mark-to-market loss caps, unmanaged-position policy, engine failure policy, benchmark, alert channel, INVALIDATED rules, cost model and out-of-sample protocol, correlated exposure method, broker statement format, and approval for fault injection on the demo account.

## Update - 2026-10-26 (fault injection on the demo account, owner approved)
- Three scenarios run on the demo account, EURUSD at broker minimum (1000 units), each closed and confirmed flat: timeout, disconnect, restart during submission. All three orders were recorded as UNKNOWN or left as SUBMITTING, found at the broker, adopted and protected by reconciliation, then closed. No duplicate orders. Details: docs/FAULT_INJECTION_RESULTS.md. Harness: scripts/faults/run.js (no production code change).
- Gaps found, not yet fixed: reconciliation run outside the engine is not audited (no POSITION_ADOPTED); closeMarket writes no audit and no trade record, so the three test closes (+0.22 total) do not reconcile to AIS records; intents for closed positions remain FILLED; power loss is untested.
- Production server is stopped. Its run state is unclean (the stop did not run the deliberate-stop handler), so the next start will need the recovery review acknowledged again.

## Update - 2026-10-26 (adoption and close audit fix)
- Adoption is audited in trading.resolveIntents (once; engine duplicate removed). Closes are audited in trading.closeMarket (POSITION_CLOSED), and the matching FILLED intent becomes CLOSED. orderManager.closeTrade records closes of recorded trades; the fault harness uses it.
- Tests: tests/adoptionAndCloseAudit.test.js (4). Full suite: 168 pass, 0 fail.
- Not done: live check of this change (the demo server is stopped; its next start needs the recovery review acknowledged). Backfill of the three earlier test closes (+0.22) needs owner approval.

## Decision - 2026-10-26: earlier test closes left unrecorded and disclosed
- The three fault-injection closes (+0.22) stay without audit entries or trade records, by owner decision. Owner reports disclose them in every period that contains them (dataNotes and summary.unrecordedBrokerCloses), with the P&L excluded from totals. Test: tests/reportUnrecorded.test.js. Full suite: 172 pass.

## Final status - 2026-10-26
- Verdict: Not ready. Details and evidence: docs/FINAL_STATUS_2026-10-26.md.
- New defect: a SIGINT sent from the shell does not reach the server's stop handler on this machine. The stop is not recorded as clean, so every stop forces a recovery review on the next start. Fix before relying on bounded runs: an owner-token stop route that records SHUTDOWN_REQUESTED, or another verified signal path. Not yet built.
- Open decision: decision log growth from WAIT/NOT_QUALIFIED signals, which carry no frozen levels.
- Live: not assessed; not enabled.

## Final status - 2026-10-26
- Verdict: Not ready. Details and evidence: docs/FINAL_STATUS_2026-10-26.md.
- New defect: a SIGINT sent from the shell does not reach the server stop handler on this machine. The stop is not recorded as clean, so every stop forces a recovery review on the next start. Fix before relying on bounded runs: an owner-token stop route that records SHUTDOWN_REQUESTED, or another verified signal path. Not yet built.
- Open decision: decision log growth from WAIT/NOT_QUALIFIED signals, which carry no frozen levels.
- Live: not assessed; not enabled.

## Owner decisions on the 11 blocked items - 2026-10-26
Status by decision, with commits and open items: docs/DECISIONS_STATUS_2026-10-26.md.
- Resolved: 1 (legacy archive applied to real data, with backup), 2 (MTM caps), 3 (data gate), 4 (entry pause), 7 (PAPER and DEMO_SUPERVISED), 11 (owner stop route, live-tested).
- Partial: 5 (dashboard panel not built), 6 (built; NOT applied: checkpoint), 8 (built; buy-and-hold unavailable without history), 9 (Telegram built; email needs nodemailer), 10 (built; no pending-entry opportunities exist yet).
- Suite: 280 pass, 0 fail. Commits on claude/ais-markets-ctrader-f6a11a, nothing pushed.

## Items 5, 6, 8, 9, 10 - status with evidence (2026-10-26)
- **Item 5 (unmanaged positions): Partial.** Dashboard panel built (read-only, text-escaped; tests/dashboardUnmanaged.test.js). Resolution is an owner action through the API only.
- **Item 6 (decision-log compaction): built, NOT applied. Scope narrowed per owner.** Only current-format WAIT / NOT_QUALIFIED records older than 30 days are compactable, and none exist yet. Legacy-format decisions (1,885) are tagged legacy/unverified (backup written; rollback available) and are never compacted; all 1,885 are linked to NO-TRADE outcomes, so they are protected anyway. Scheduled dry run every 6 hours, logged to decision_compaction_dryrun_log, never applies. Inventory: docs/LEGACY_FORMAT_INVENTORY.md. Tests: tests/compaction.test.js (9), tests/legacyFormats.test.js (4).
- **Item 8 (yearly benchmarks): Partial.** Broker hourly bars now load for yearly reports (read-only). Buy-and-hold reports only with full coverage; otherwise "benchmark unavailable". Tests: tests/benchmarkBars.test.js (4). Live reports need an authenticated broker session.
- **Item 9 (alerts): Partial. Telegram UNVERIFIED against a live bot.** Telegram path tested with a mock transport only. Email path uses nodemailer ^6.10.1 (declared dependency), tested with a mock transport. Credentials come only from environment variables; .env is in .gitignore; no .env file is tracked; a scan of tracked source, tests, docs and scripts found no credential-shaped strings. Network errors are redacted before logging (test: tests/notify.test.js). Tests: 11.
- **Item 10 (INVALIDATED and entry states): Partial.** Two entry types: MARKET (fill = frozen quote + modelled half-spread; no pending state) and LEVEL (PENDING_ENTRY, ENTERED, INVALIDATED, EXPIRED_UNFILLED, AMBIGUOUS_ENTRY, AMBIGUOUS_OUTCOME; 12-candle window, configurable). Completed candles only; no look-ahead; exact rule and timestamp stored. Counts and rates reported; never in win or loss. Tests: tests/invalidatedOutcomes.test.js (17 expectations across states and summaries), tests/monitorEntryStates.test.js (3). Gap: no producer creates LEVEL opportunities yet; all current opportunities are MARKET.
- Full suite at this commit: 305 pass, 0 fail, 0 skipped.

## Update - 2026-10-27: items 6 and 10, Telegram
- **Item 6 (compaction): built, NOT applied.** Compaction applies only to current-format WAIT / NOT_QUALIFIED decisions older than the retention window, not linked to any outcome, trade, incident or open position. No legacy format is approved. The 1,885 legacy-format decisions are NOT tagged, compacted, archived or modified: they were tagged and restored; they are byte-identical to the pre-tag backup (verified). Guard test: tests/compaction.test.js. Read-only inventory: docs/LEGACY_FORMAT_INVENTORY.md. A dry run is scheduled every six hours and logged; nothing applies.
- **Item 10 (entry states):** MARKET and LEVEL entry types; LEVEL is produced from a strategy-defined entry condition frozen at decision time (src/governance/levelEntry.js). A condition without a valid level is NOT_EVALUABLE; no level is invented. Tests: tests/levelEntry.test.js (9), tests/invalidatedOutcomes.test.js, tests/monitorEntryStates.test.js. No current strategy defines an entry condition, so no LEVEL opportunities exist in live data yet.
- **Telegram: UNVERIFIED against a live bot.** One-command test: `node scripts/alerts/test-telegram.js`. Setup checklist: docs/ALERTS_SETUP.md. Tested only with mock transports and a fake token (the live API returned 401 for the fake token, showing the request path works).
- Full suite: 315 pass, 0 fail, 0 skipped.

## Update - 2026-11-02: honest backtest, engine audit, demo execution evidence

- **Backtest rebuilt before anything was built on it (8b1fa7f).** It judged trades on the bar close alone and charged nothing, so results looked the same whether bars came from cTrader or a random walk. Now: costs (`spread`, `slippage`, `commission`) are validated and charged against the trader on both sides, gross and net P&L reported separately; exits are tested against each bar's high/low rather than its close, with a gap through a level filling at the open; a stop and target inside one bar is marked ambiguous and the policy is recorded (stop-first by default, `exclude` and `target-first` available), with excluded trades kept for audit and never counted in win rate, profit factor, Sharpe or return. `dataSource` is derived by the engine — `SYNTHETIC`, `SUPPLIED_HISTORY` or `CTRADER_BARS` — and a caller cannot produce a result without one; the dashboard shows a SYNTHETIC banner and the cost assumption. A position open at the end of the series is marked `forced`. Tests: tests/backtestCosts.test.js (19). **Gap: costs default to zero unless a caller supplies them**, so dashboard runs stay optimistic and now say so.
- **Engine audit: 47 acceptance criteria graded — 22 PASS, 13 PARTIAL, 12 FAIL, 0 BLOCKED** (e69822e). The execution, risk and reconciliation layers hold up; the research and strategy-management half did not exist. Evidence and per-criterion reasoning: docs/AIS_MARKETS_ACCEPTANCE_AUDIT.md.
- **Two defects fixed in that commit.** `evaluation.js` had no production caller — `patternMiner` now counts the rules it examines and records each survivor's significance against a threshold divided by that count, so a wide search no longer reports itself as narrow (recorded, not enforced; tests/patternMinerSignificance.test.js). `storage.load` copied a damaged file aside on every call — one unreadable file produced nine copies in 45 seconds and reset the mark-to-market baselines each time; the copy is now taken once per collection, re-armed after a successful write, and a failed copy does not fail the load (tests/storage.test.js).
- **Demo execution verified on the owner's instruction.** One order against the real demo broker: EURUSD 0.01 lot, filled, stop-loss and take-profit read back from the broker, closed and reconciled, with matching hash-chained audit entries. Repeatable, read-only without `--execute`: `scripts/demo-execution-evidence.js`. The recovery fence was not cleared and no live mode entered. Evidence: docs/evidence/demo-execution-2026-11-02T19-59-01-241Z.json and -19-59-52-528Z.json.
- **Recorded, not fixed:** `npm run validate:demo` validates nothing (D-8); the engine's own fenced run placed no order while connected and funded.
- Full suite: 350 pass, 0 fail, 0 skipped.

## Update - 2026-11-03: strategy registry, version-bound approval, deploy gate

- **Every strategy is now a versioned, immutable record** (src/strategy/registry.js). The content hash covers the declared rules *and* the strategy's own `generate()` source, so a code change produces a new version and needs a new approval. Approval names the hash it covers and is refused if the rules changed after they were read. The state machine — `DRAFT → APPROVED → DEPLOYED → RETIRED`, back only through re-approval — is enforced in the registry rather than the routes, so no route, script or test can move a version somewhere the owner did not authorise; every transition needs a reason of at least ten characters and is appended to the record's history.
- **The deploy gate is enforced, and fails closed.** `signalEngine` votes only from deployed versions and names what it blocked (`strategiesRun`, `strategiesBlocked`), so reduced coverage cannot pass for "no signal". `tradingEngine.runCycle` stops entries outright when nothing is deployed and says so in `lastBlockReason`. If the registry cannot be read, nothing runs.
- **First start migrates rather than approves.** `adoptBaseline` adopts what is already in service as version 1, `DEPLOYED`, attributed to `system-migration`, and writes a flag so it runs once. Auto-approving on every start would have made the gate decorative; halting a running system on upgrade would have been worse (src/strategy/baseline.js).
- **Routes:** `GET /api/strategies/registry`, `GET /api/strategies/registry/gate` (what would and would not run, and why), `POST .../register`, `.../approve`, `.../deploy`, `.../retire`. Each owner action is written to the hash-chained audit ledger.
- Tests: tests/strategyRegistry.test.js (16), tests/deployGateWiring.test.js (4). Writing them found two defects in the gate itself — it tested the newest version instead of the deployed one, and its read helpers could see an unloaded cache — both fixed before commit. The three engine wiring tests now point `AIS_REGISTRY_FILE` at a temp directory, because the cycle reads the registry.
- **Not done:** a strategy is still a name plus parameters — audit §10 step 4 (entry, stop, target, exit, sizing, invalidation as explicit rules) is untouched. The research path that would justify an approval (§10 step 3) is not wired. Criteria E and G remain PARTIAL and D is unchanged. The gate is enforceable through the routes but has no dashboard screen.
- Full suite: 370 pass, 0 fail, 0 skipped.

## Defect - 2026-11-03: adaptive weights torn read halted the engine for a day

- **Symptom.** The dashboard showed `Not ready · new entries paused: 3 consecutive engine cycles failed`. Three cycles died, the entry pause latched, and the banner still carried it 14 hours after the cycles recovered. The owner could not find out why: the reason existed only as `UNHANDLED_ERROR` in the audit ledger.
- **Cause.** `adaptiveLearner` wrote `data/adaptive_weights.json` with `fs.writeJson` — truncate, then write in place — while the engine read the same file 45 times per cycle (one per strategy per symbol). A read landing inside a write saw a truncated file and threw `Unexpected end of JSON input`. Two concurrent `updateOnTrade` calls could interleave on the same file for the same reason. Five occurrences in two days: `2026-11-02T21:47:16`, `11-03T01:28:02`, `01:33:02`, `02:00:53`, `11:22:45` — the last one during a live backtest, which writes the file 45 times in about three seconds. `src/data/storage.js` already had the fix (temp file, rename, Windows retry); this writer bypassed it.
- **Fixed.** Writes are now temp-then-rename, read-modify-write cycles are serialised on a promise chain, and reads are served from an in-memory cache updated after a successful write, so the trading path no longer touches the file. A mutation works on a copy, so a failed write leaves memory and disk agreeing. An unreadable file is **not** replaced with neutral weights — a learned 0.2 and the 1.0 default size positions differently, and that is the owner's decision, not a fallback's. Tests: tests/adaptiveWeightsConcurrency.test.js (5), including 40 concurrent updates and 50 reads racing 12 writes.
- **The reason is now visible.** The failing cycle's message travels with the count: `entryPause.tripOnFailures(n, cause)` stores it, the `CYCLE_FAILING` and `ENTRIES_PAUSED` alerts carry it, readiness shows it, `engine.getStats().lastCycleError` exposes it, and the audit `ENTRIES_PAUSED` record keeps it. The dashboard now lists every open alert with its code, severity, message and open-since time — before this it fetched the alerts and rendered only the count, so "alerts open: 1" was the end of the information.
- **The duplicated wording is gone.** The stored reason no longer ends in "; new entries paused" while every surface prefixes the same phrase; a record written before the fix is reduced to its cause on load.
- **The ML popup explains itself.** `mlModel.validate` now returns the comparison that decided it (selected trades vs all held-back trades, or how many cleared the probability bar) instead of the dashboard falling back to a hardcoded sentence.
- Full suite: 388 pass, 0 fail, 0 skipped.

## Defect - 2026-11-05: the model was learning from 34 hours and extrapolating to the week

- **Symptom.** The ML model's third-largest coefficient was `day_cos` (+0.392) and its seventh `day_sin` (−0.280). Decoded, it believed Sunday (+0.392) and Saturday (+0.464) were the best days to trade and Wednesday (−0.475) the worst — for instruments that mostly do not trade at weekends. The adaptive weights were also fitted on a single regime: every live bucket was RANGING.
- **Cause.** Three depths had drifted apart. `marketFeed` seeded 3,000 M1 bars, `marketdata` kept 6,000, and `realBacktest` asked for a hardcoded 2,000 — 33 hours. The backtest is the only source of trades for the ML model, so the entire corpus spanned 2026-11-04 and 11-05: 1,500 trades on Wednesday, 653 on Thursday, zero on the other five days. The weekday terms were fitted on a two-point distribution and applied to the whole week. The "walk-forward" split was really train-on-Wednesday, test-on-Thursday.
- **Fixed.** One source of truth: `marketData.maxBars(tf)` is now what the seed, the buffer and the backtest all ask for, so they cannot drift again. M1 depth is 20,000 bars (about two weeks), the seed matches it, and the fetch deadline covers the 20 chunks per symbol that two weeks needs. A broker that returns less than asked is logged rather than left to be discovered later.
- **The weekday terms are now conditional.** `fitWeights` counts the distinct weekdays in the corpus and zeroes `day_sin`/`day_cos` below five, recording `weekdays` and `dayFeaturesDropped` in the report. A fresh install with two days of data can no longer learn a weekday preference; two weeks of data can.
- **Tests.** tests/backtestDepth.test.js (4): the backtest reads the whole buffer, the seed matches the buffer, the buffer spans at least ten days, and a 5,000-bar store produces a 5,000-bar backtest. tests/mlModel.test.js gains 3: weekday terms dropped on a one-day corpus, kept on a full week, and the report says which. `AIS_BACKTEST_TRADES_FILE` was added so the depth tests never touch the real corpus.
- **Not done.** The corpus is still M1-only, so two weeks is the ceiling until the backtest can run on M5/M15 bars (2,000 M5 bars is a week, 2,000 M15 bars is three). The weight formula still divides by a 0.5 win rate that these strategies do not have, so profitable strategies sit below 1.0.
- Full suite: 395 pass, 0 fail, 0 skipped.
