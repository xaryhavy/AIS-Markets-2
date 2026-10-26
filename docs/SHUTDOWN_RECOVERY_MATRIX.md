# Shutdown and Recovery Matrix — Priority 3 (2026-10-26)

Each scenario lists what the system must do, the evidence that exists, and what is still unproven.
"Unit" means a test with a fake broker, clock or file. "Live" means observed on the demo account.
Nothing here has been fault-injected against the real broker, and a power loss during an order has not been tested.

| # | Scenario | Required behaviour | Evidence | Status |
|---|---|---|---|---|
| 1 | Owner switches autonomy off | No new entries; reason shown in readiness | tests/operations.test.js (readiness stop conditions); index.js reads `tradingEnabled` | Unit verified. Open-position management while off: exits still run (tradingEngine.js, "Exits still run below"), not separately tested. |
| 2 | Loss cap hit (daily / weekly / monthly) | Entries blocked for the period | tests/guardrails.test.js (9 tests, UTC period starts) | Unit verified. Floating (mark-to-market) losses are not counted: open gap. |
| 3 | Emergency stop | Every entry refused; logged | tests/riskControls.test.js "an emergency stop refuses every entry"; audit EMERGENCY_STOP_ON/OFF | Unit verified. Live on/off drill recorded 21:56 (audit seq 5–6). |
| 4 | Broker disconnect | Entries blocked, state shown | readiness reason `broker state …`; health `broker` component | Unit verified. Live disconnect and reconnect confirmed in audit (OWNER_DISCONNECT / OWNER_CONNECT, 22:17–22:18). |
| 5 | Broker disconnect while an order is in flight | Order is UNKNOWN, never FAILED; resolved by reconciliation | tests/execution.test.js "timed-out order is UNKNOWN", "unknown order stays unresolved inside grace period" | Unit verified with fake broker. Not fault-injected live. |
| 6 | Stale quote or dead feed | Entries blocked | tests/execution.test.js (stale quotes, dead feed); tests/dataQuality.test.js | Unit verified. Live: weekend FX blocked correctly (docs/DATA_QUALITY.md). |
| 7 | Unconfirmed orders or unmanaged broker positions | State `uncertain`; entries blocked; no automatic close | readiness tests (uncertainty outranks everything); execution.test.js adoption tests | Unit verified. Owner decision still open on whether unmanaged positions may ever be closed (currently never). |
| 8 | Reconciliation fails | Entries paused; readiness `uncertain` | tradingEngine.js reconcile catch sets `unresolved`, so readiness is uncertain | Code-path verified (read, not tested directly). Gap: no dedicated test. |
| 9 | Engine cycle fails repeatedly (worker error) | Logged; after 3 in a row an owner alert is raised | tradingEngine.js safeCycle; tests/engineFailureAlert.test.js (3 tests) | Alert logic unit verified. The process keeps running after a cycle error: intentional, but entries are not explicitly paused by the failure count. Owner decision open. |
| 10 | Restart after a crash or kill | Recovery review holds trading until acknowledged | tests/recoveryFence.test.js (6 tests); guardrails.init | Unit verified. Live: 22:01 restart raised RECOVERY_REVIEW after the earlier interrupted session; acknowledged 22:21. |
| 11 | Restart does not clear an unacknowledged fence | Fence persists across further restarts | tests/recoveryFence.test.js "a restart does not clear an unacknowledged fence" | Unit verified. |
| 12 | Restart with a submission left hanging | Resolved by reconciliation, cannot block entries forever | tests/execution.test.js "a submission left hanging by a crash is also resolved" | Unit verified. |
| 13 | Storage write fails (rename) | Retried a bounded number of times, then raised; temp file removed | tests/storage.test.js (3 tests) | Unit verified for the rename step only. A failed append inside an order path is not tested. |
| 14 | Storage or audit chain corrupted | Health degraded; `chain broken at entry N` | tests/operations.test.js (altered and deleted entries detected) | Unit verified. |
| 15 | Power loss during order submission | Restart reconciles the broker before entries resume | Design: write-ahead intents + reconciliation (execution.test.js) | Not tested against a real power loss or kill during submission. Open. |
| 16 | Owner acknowledges the fence | Trading resumes only when readiness shows `enabled` | Live, 22:21: readiness went to `enabled`, alert resolved, audit RECOVERY_ACKNOWLEDGED | Live verified (demo). |

## Gaps that block demo-autonomy readiness
- Row 1 and 2: exit management while entries are disabled, and mark-to-market loss caps, need tests and an owner decision on floating losses.
- Row 8: reconciliation failure has no direct test.
- Row 9: owner decision on whether repeated cycle failures should pause entries (not only alert).
- Row 15: no fault-injection against the broker. This needs the owner's approval for demo fault tests.

## Changes made for this matrix
- `src/governance/guardrails.js`: run-state file path can be set with `AIS_RUN_STATE_FILE` (test isolation only; default unchanged).
- `src/engine/tradingEngine.js`: consecutive cycle failures are counted; three in a row raise a `CYCLE_FAILING` alert, and a failed cycle re-syncs alerts.

## Update — 2026-10-26 (later)
- Row 1 (autonomy switched off): exits-run-while-entries-blocked is now tested through the real runCycle (tests/engineCycleWiring.test.js).
- Row 8 (reconciliation failure): now tested. A failed reconciliation blocks entries and no order is sent (tests/engineCycleWiring.test.js).
- Row 9 (repeated engine cycle failure): found a defect that caused real failed cycles on the demo server (undefined `limits` in the reward-to-risk check, fixed). CYCLE_FAILING alert is unit-tested only.
- Row 5 (disconnect with an order in flight) and row 15 (power loss during submission): still not fault-injected. Demo fault injection is paused at the owner's request.

## Update — 2026-10-26 (storage concurrency)
- Row 13 (storage write fails): now also covers overlapping writes on one collection (tests/storageConcurrency.test.js). The ENOENT race that appeared live is fixed.
- Row 16 (acknowledge): the fence re-appeared after the previous server's bounded run ended with a hard kill. Bounded runs now use `timeout -s INT` so they end with a clean stop.

## Update - 2026-10-26 (fault injection, demo)
- Row 5 (disconnect with an order in flight): fault-injected on demo; resolved correctly. See docs/FAULT_INJECTION_RESULTS.md.
- Row 15 (power loss during submission): partial. A process crash after the request was sent was tested on demo; a true power loss was not.
- Row 5 and row 15 also expose: adoption outside the engine is not audited, and closes through closeMarket are not recorded as trades.
