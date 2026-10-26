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
