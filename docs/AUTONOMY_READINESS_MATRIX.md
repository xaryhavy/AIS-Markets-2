# Autonomy Readiness Matrix — AIS Markets (2026-10-26)

Scope: broker demo only. Live is not assessed and must not be enabled. "Safe to enable?" answers whether the capability may be used now in supervised demo operation, not whether it is profitable.

| Capability | Status | Evidence | Acceptance criteria still open | Dependencies | Safe to enable now? | Next gate |
|---|---|---|---|---|---|---|
| Owner access (token, lockout, rotation) | Verified (unit + live lockout check) | tests/operations, authRateLimit, authRotate; live 22:26 | Rate limit per client, not per address; second approver for loosening | none | Yes, local use | Rate-limit review |
| Operating modes | Partial | mode.js; OBSERVATION, RESEARCH, DEMO_AUTONOMOUS built; PAPER and DEMO_SUPERVISED refused | Build PAPER (simulated fills) and DEMO_SUPERVISED (per-trade owner confirmation) | Owner design approval (changes execution authority) | DEMO_AUTONOMOUS only | Owner approval of mode design |
| Readiness and health | Verified | operations.test; live readiness changes observed | Readiness reasons should include reconciliation age | none | Yes, as a display of backend state | none |
| Audit trail | Verified | auditOwnerActions, operations tests; live verify ok (41 entries) | Storage of evidence class per record | none | Yes | none |
| Alerts | Partial | alerts.js; CYCLE_FAILING unit-tested only | Live check of CYCLE_FAILING; delivery beyond dashboard | Channel choice from owner | Dashboard only | Owner chooses channel |
| Market data validation | Verified (unit), live weekend block observed | dataQuality.test (11), docs/DATA_QUALITY.md | Session-aware staleness; gap tolerance review (trading gate) | Owner decision on gap tolerance | Yes, conservative | Owner decision |
| Provider error counts | Implemented-unverified live | providerErrors.test (4) | Used by no gate or alert | Design of thresholds | Visibility only | Thresholds decision |
| Order submission and fill confirmation | Partial | execution.test (fake broker); one controlled round trip live in earlier round | Live fault injection: timeout, disconnect mid-order, restart during submission | Owner approval for demo fault tests | Demo only, with monitoring | Fault-injection run |
| Protection (SL/TP) verification | Partial | execution.test; one live round trip | Live rejection of protection; amendment failure path live | Fault injection | Demo only | Fault-injection run |
| Reconciliation | Verified (unit), code path read | execution.test (adoption, grace period); engine wiring test (failed reconciliation blocks entries) | Live reconciliation after forced disconnect | Fault-injection run | Demo only | Fault-injection run |
| Unmanaged broker positions | Verified (unit) | execution.test; policy: never closed automatically | Owner decision on whether they may ever be closed | Owner decision | Blocks entries; no automatic close | Owner decision |
| Risk admission and limits | Verified (unit) | riskManager, riskControls, riskSafety tests | Configurable limits in use need owner approval | Owner approval per change | Demo, current validated values | none for current values |
| Loss caps (realised) | Verified (unit) | guardrails.test (9) | Mark-to-market (floating) losses are not counted | Owner decision (new limit) | Demo, with known gap | Owner decision |
| Correlated exposure | Missing | none | Design and test | Data for correlation | No | Build (after approval of method) |
| Emergency stop | Verified (unit + live on/off) | riskControls; audit seq 5–6 | none listed | none | Yes | none |
| Recovery fence and restart | Verified (unit + live) | recoveryFence.test (6); live 22:01, 22:21, 23:03 | Power-loss test | Fault injection | Yes, with acknowledgement | Power-loss test |
| Engine resilience | Partial | engineFailureAlert, engineCycleWiring; live: 0 cycle errors over 65 cycles after fixes | Repeated failure should pause entries (owner decision) | Owner decision | Yes, demo | Owner decision |
| Storage integrity | Verified (unit) | storage.test, storageConcurrency.test (4); read-only check found no duplicate or orphaned records | Single-process assumption; multi-process lock | none | Yes, one process only | none |
| NO-TRADE monitor | Verified (unit); live evidence accumulating | noTrade.test (17), waitDedupe.test (6) | INVALIDATED status (rules needed); evidence class separation | Owner-defined invalidation rules | Hypothetical only | Owner decision on rules |
| Learning (adaptive weights, ML) | Partial | mlModel.test; validation gate | Evidence separation; legacy simulated trades still feed learning (defect 6) | Owner decision on legacy data | No, until defect 6 decided | Owner decision |
| Strategy evaluation (costs, out-of-sample, multiple testing) | Missing for costs and OOS | backtest engine ignores spread and commission | Build cost model and out-of-sample protocol | Costs data from broker | No | Build |
| Owner reports (daily, weekly, monthly, yearly) | Verified (unit) with synthetic samples | reports.test, ownerReport.test (129 lines); docs/sample_reports | Broker statement reconciliation; commission and swap storage; benchmark choice | Statement format; owner benchmark decision | Demo reporting, labelled | Owner benchmark decision |
| Shutdown and recovery matrix | Documented, 16 scenarios | docs/SHUTDOWN_RECOVERY_MATRIX.md | Scenarios 5, 15 need live fault injection | Owner approval | Demo | Fault-injection run |
| Live trading | Not assessed | none | Everything above | Separate readiness review and explicit owner authorization | **No** | Not in scope |

## Summary
- **Safe to enable in supervised demo now:** owner access, readiness and health display, audit, emergency stop, recovery fence with acknowledgement, the current validated risk limits, the NO-TRADE monitor (hypothetical only), and the storage layer in one process.
- **Not safe yet:** learning from legacy simulated trades, strategy evaluation with costs, correlated exposure, PAPER and DEMO_SUPERVISED modes (not built), live anything.
- **Blocked on owner decisions:** learning data (defect 6), gap tolerance, mark-to-market loss caps, unmanaged-position policy, engine failure policy, benchmark choice, alert channel, INVALIDATED rules, and fault-injection approval.

## Verdict
**Not ready** for demo autonomy under the mandate. The demo system runs with the current validated limits and is monitored, but the mandate's fault-injection and validation evidence (Priority 7) has not been produced, and several Priority 3 to 6 items are open and await owner decisions. Live: not assessed.
