# Test Evidence — 2026-10-25

Command (run from the project root, main folder):
    npm test
Result: 47 tests, 47 pass, 0 fail, 0 skipped.

Files and counts:
- tests/guardrails.test.js (loss caps, UTC period boundaries)
- tests/riskManager.test.js (notional, 1:3 reward-to-risk, stops, precision)
- tests/patternMiner.test.js (out-of-sample rule validation)
- tests/timeframes.test.js (trend classification, completed bars only, gating)
- tests/mlModel.test.js (feature vector, learning, validation activation)
- tests/execution.test.js (fake broker: fills, timeouts, refusals, failed protection, reconciliation, grace periods, entry blockers)
- tests/reports.test.js (period boundaries, exclusion of simulated trades, estimated P&L, decision counts)

Limits of this evidence:
- Execution tests use a fake broker client. They do not prove the real broker's behaviour under timeouts, disconnects or partial fills.
- No live order was placed in this round. The read-only reconcile smoke test failed to connect (broker timed out on ProtoOASymbolsListReq), so the live reconcile path was not exercised.
- Earlier live verification (previous rounds, demo account): one controlled round trip (open, SL/TP amend, close) and engine-run orders; see the conversation log.
- Passing tests do not show profitability or full broker-behaviour coverage.

## Update — 2026-10-26 (worktree, full suite)
Command (worktree root): `NODE_PATH=<main>/node_modules node --test tests/*.test.js`
Result: **150 tests, 150 pass, 0 fail, 0 skipped, 0 todo** (5.5 s).

Added since the 2026-10-25 run:
- tests/marketFeed.test.js (4): history fetch stops on no progress, on exhausted history, on the deadline, and converts prices correctly.
- tests/storage.test.js (3): transient rename retry, retry exhaustion with temp cleanup, non-transient errors not retried.
- tests/waitDedupe.test.js (6): repeated WAIT collapsed per symbol and reason; streak breaks; no-levels never collapsed; monitor resolves collapsed repeats from frozen levels.
- tests/auditOwnerActions.test.js (2): owner connect, disconnect and logout recorded in the chain; altered entry detected.
- tests/authRateLimit.test.js (4): lock after five failures, lock expiry, window reset, per-address isolation.
- tests/recoveryFence.test.js (6): fence on crash, no fence after clean stop, fence survives restart, acknowledgement persisted.
- tests/engineFailureAlert.test.js (3): CYCLE_FAILING raised at three consecutive failures.

Live checks (demo account, worktree server):
- Owner disconnect then reconnect: audit OWNER_DISCONNECT and OWNER_CONNECT; chain verified.
- Auth lockout: five wrong tokens returned 401, the sixth 429; the correct token returned 200 while locked; audit AUTH_FAILED ×5 and AUTH_LOCKED.
- Recovery review acknowledged: readiness enabled, alert resolved, audit RECOVERY_ACKNOWLEDGED.

Limits: all execution tests use a fake broker. No live fault injection (timeouts, disconnects mid-order, power loss) has been run. The fake-broker tests do not prove the real broker's behaviour.

## Update — 2026-10-26 (fault-injection preparation and offline builds)
Full suite (worktree): **157 tests, 157 pass, 0 fail, 0 skipped** (`node --test tests/*.test.js`).
New files:
- tests/engineCycleWiring.test.js (3): runs the real runCycle with dependencies stubbed. An entry is blocked when reconciliation fails and no order is sent; exits run when entries are switched off; a healthy signal passes the entry blockers and reaches position sizing.
- tests/providerErrors.test.js (4): a broker error response, a request timeout (mocked clock) and a dropped session are each counted; totals and message truncation.
- tests/engineFailureAlert.test.js (3) and tests/authRateLimit.test.js (4), tests/recoveryFence.test.js (6), tests/auditOwnerActions.test.js (2) from earlier today.

Defect found and fixed by the wiring test:
- src/engine/tradingEngine.js reward-to-risk check referenced `limits`, which is not defined in that file (the module is `limitsCfg`). Every signal that passed the entry blockers threw a ReferenceError before the per-signal error handling, failing the whole cycle. The demo server log shows 12 such cycle errors (`[ENGINE] cycle error: limits is not defined`, server run 22:16–22:26). The audit log has no order entries for that period, so no order was sent.
- Fixed by using `limitsCfg`. Covered by the healthy-path wiring test, which fails without the fix.

Not yet verified live:
- The `CYCLE_FAILING` alert did not fire during those 12 failures. That server started before the alert code existed. Needs a live run on the current code.
- The fixed code is not running on the demo server yet.

## Update — 2026-10-26 (storage concurrency and demo restart)
Full suite (worktree): **161 tests, 161 pass, 0 fail, 0 skipped** (`node --test tests/*.test.js`).
New tests:
- tests/storageConcurrency.test.js (4): fifty overlapping appends all persist; overlapping appends, updates and mutates do not fail with ENOENT; a batch update through `mutate` keeps an append made while it runs; a `mutate` returning undefined leaves the file untouched. Uses a temp data folder (`AIS_DATA_DIR`).
- tests/waitDedupe.test.js now uses an in-memory `mutate` and a temp data folder. Earlier it could reach the real `data/` folder through the monitor's new batch write. Checked: no real record was changed (no outcome stamped with the test clock).

Defect found and fixed:
- Two overlapping writes to the same collection shared one temp file name (`<file>.<pid>.tmp`). The second rename then failed with ENOENT. The demo server logged 2 such cycle errors after the restart at 22:44.
- Read-modify-write (`append`, `update`, the monitor's batch update) had no lock, so overlapping writes could drop a record. The monitor's batch update was added today; the lost-update risk in `append` and `update` was already there. No loss has been observed or verified either way.
- Fixed in src/data/storage.js: unique temp names per write; writes to one collection run one at a time; `mutate` for locked read-modify-write; src/governance/noTrade.js batch update now uses `mutate`.

Live check (demo account, fixed code, server started 23:03 with `timeout -s INT`):
- Readiness before acknowledgement: disabled, "recovery review required after an unclean shutdown" (the earlier server ended without a clean stop). Acknowledged by the owner's instruction; readiness then enabled, alerts empty.
- About 65 engine cycles over roughly five minutes: 0 cycle errors, 0 monitor errors, lastReconcileOk true, marketConnected true. Trades executed in this window: 0.
- Audit chain verified: 41 entries, no breaks.
