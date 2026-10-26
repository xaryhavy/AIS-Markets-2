# Mandate Success Criteria — Measurement, 2026-10-26

Each goal of the mandate is measured against the evidence available now. Status words follow the mandate: Verified, Implemented-unverified, Partial, Simulated-only, Missing, Blocked. "Met" is used only where every part of the goal is verified on the code and on the demo account.

Overall: **Not met.** Goals 1 to 3 are partly met. Goals 4 to 6 are partly met or missing. Goal 7 is not met. The verdict is **Not ready**.

## Goal 1 — Validate market data and produce reproducible, evidence-linked analysis
- **Status:** Partial.
- **Verified:** candle validation (invalid values, duplicates, out-of-order, forming candles excluded), gap detection, staleness per timeframe, analysis expiry, fingerprint of the candles used (`src/data/quality.js`, tests/dataQuality.test.js, 11 tests). Live: weekend FX correctly blocked.
- **Not done:** provider-error counts are recorded but no gate or alert uses them; session-aware staleness; gap tolerance review (needs owner decision); market-understanding additions (structure, supply/demand, liquidity) — not justified until validated.

## Goal 2 — Make explainable TRADE / WAIT / NO-TRADE decisions
- **Status:** Verified (unit) and observed live; partly complete.
- **Verified:** every signal gets a state, reason code, frozen levels and data fingerprint (`src/governance/shadowTracker.js`, `noTrade.js`). Live window: 356 decisions recorded since the restart, each with a reason.
- **Not done:** the decision log grows with `WAIT/NOT_QUALIFIED` entries, which carry no frozen levels, so the repeat-collapsing rule does not apply to them. Compaction changes evaluation data — owner decision.

## Goal 3 — Enforce risk limits at the server-side execution boundary
- **Status:** Partial.
- **Verified:** pre-trade check at the order boundary (`src/risk/preTrade.js`, `src/ctrader/trading.js`), validated risk configuration, emergency stop, loss caps (realised), recovery fence, operating-mode refusal. Tests: riskControls, guardrails, riskManager, recoveryFence.
- **Not done:** mark-to-market (floating) loss caps (new limit — owner decision); correlated exposure (not built); exit management while entries are disabled is tested only through the engine wiring test.

## Goal 4 — Execute, confirm fills, verify protection, monitor, reconcile with the broker
- **Status:** Partial; strongest part of the system on evidence.
- **Verified on the demo account:** three fault scenarios (lost reply, socket drop, crash during submission). Each order was resolved from the broker and protected before close; no duplicates (docs/FAULT_INJECTION_RESULTS.md). Adoption is audited once and closes are audited with intents marked CLOSED (tests/adoptionAndCloseAudit.test.js, 4 tests).
- **Not done:** the adoption and close audit change has **not** been exercised live (no entry has occurred since the change); power loss during submission is untested; live protection rejection and partial fills are not fault-injected; the three earlier test closes (+0.22) are unrecorded by owner decision and disclosed in the reports.

## Goal 5 — Learn only from correctly classified evidence
- **Status:** Partial. Evidence classification is built; learning is not yet restricted by it.
- **Verified:** classification (`src/analytics/evidence.js`: BROKER_DEMO_EXACT, BROKER_DEMO_ESTIMATED, FAULT_TEST, SIMULATED_LEGACY, HYPOTHETICAL). Strategy evaluation (`src/analytics/evaluation.js`) uses exact broker-demo results only, with explicit costs, chronological out-of-sample split, sample-size flags, and multiple-testing adjustment (9 tests, tests/evaluation.test.js).
- **Measured now:** the trade store holds 12 simulated legacy trades and 1 estimated broker close. **Zero exact broker-demo results.** The evaluation therefore reports "insufficient sample (0 of 30)" and draws no conclusion.
- **Not done:** the adaptive learner still receives legacy simulated trades (defect 6) — owner decision to archive or reclassify; the learner has not been changed to read only BROKER_DEMO_EXACT; learning promotion with versioning is not built; the existing `src/analytics/performance.js` is not evidence-separated and should not be used for decisions (it is still used by an API route).

## Goal 6 — Produce accurate daily, weekly, monthly and yearly owner reports
- **Status:** Partial.
- **Verified:** period-correct reports in JSON and Markdown; hypothetical outcomes kept separate; missing-data and integrity notes; disclosure of unrecorded closes and fault-injection test trades; tests in reports.test.js, ownerReport.test.js, reportUnrecorded.test.js, reportFaultDisclosure.test.js.
- **Not done:** reconciliation with broker statements (needs a statement format); commission and swap stored separately (the broker P&L already nets them, but they are not shown as separate fields); benchmark choice (owner decision); mark-to-market; analytical narrative. Sample reports exist only as labelled synthetic examples.

## Goal 7 — Operate safely; detect own faults; stop new entries when unsafe
- **Status:** Partial. The safety controls are built and tested; the operating modes and alert delivery are incomplete.
- **Verified:** owner-token authentication with lockout and rotation; readiness states enabled / disabled / uncertain; audit chain with verification; alerts including the cycle-failure condition; recovery fence with acknowledgement; health checks. Live: readiness moved with backend state; 0 cycle errors in the observed window after the storage fix; the review was raised and acknowledged on approval.
- **Not done:** PAPER and DEMO_SUPERVISED modes are refused, not built (owner design approval needed); alert delivery beyond the dashboard (channel choice needed); the server's deliberate-stop path does not record a clean shutdown from the shell (stop route held pending owner review); the engine does not pause entries after repeated cycle failures (owner policy decision).

## Goal — sustained supervised demo validation and live-readiness assessment (Priority 7)
- **Status:** Not met.
- **Done:** a 12-minute post-restart window with 142 cycles and no errors, and the fault-injection runs. Not done: a sustained run of hours; a window that includes at least one live entry and exit; a live-readiness assessment (documented as a requirement, not started, and live must not be enabled).

## Blocked on owner decisions (the mandate requires them first)
1. Legacy simulated trades: archive, reclassify, or leave (defect 6).
2. Mark-to-market loss caps.
3. Gap tolerance on the data gate.
4. Engine policy after repeated cycle failures: alert only, or pause entries.
5. Unmanaged broker positions: policy.
6. Decision-log compaction for `WAIT/NOT_QUALIFIED` entries.
7. PAPER and DEMO_SUPERVISED modes: authority design.
8. Benchmark for yearly reports.
9. Alert channel beyond the dashboard.
10. INVALIDATED rules.
11. Backfill of the three earlier test closes — decided: leave unrecorded and disclosed.
12. Stop route for a deliberate, recorded shutdown — held for review.

## Verdict against the mandate's levels
**Not ready.** The highest level the evidence supports. "Engineering-complete, validation-incomplete" would need every buildable item done and the owner decisions made; the owner decisions are not made and the sustained validation has not been run.

## Update - 2026-10-26: the 11 owner decisions
Each decision is measured in docs/DECISIONS_STATUS_2026-10-26.md. In brief: 1, 2, 3, 4, 7 and 11 are resolved; 5, 6, 8, 9 and 10 are partial with the gaps stated there. Item 6 is built but not applied, pending the owner's checkpoint decision. The suite is at 280 passing tests.
Goal 5 (learning on correctly classified evidence) moves forward: learning now uses broker-demo trades only, and legacy records are archived and tagged. The evaluation still has no exact broker-demo sample, so no strategy conclusion is drawn.
Goal 7 (safe operation) moves forward: loss caps, entry pause, owner stop route and PAPER/supervised modes are built and tested; the stop route and readiness were checked live.
