# Risk and Safety Report — AIS Markets (2026-10-25)

Scope: demo broker only. Live trading was not enabled or tested.

| # | Issue | Severity | Status | Evidence | Action taken |
|---|---|---|---|---|---|
| 1 | An order that timed out after submission was treated as a failure. It may have filled, leaving an unrecorded, possibly unprotected position. | Critical | FIXED (unit-tested; not yet fault-injected against the live broker) | src/ctrader/trading.js openWith, resolveIntents; tests/execution.test.js | Every order is written to an intent record before sending. Timeouts become UNKNOWN; reconciliation adopts a matching broker position or marks NOT_FILLED after 2 minutes. Entries stay paused while any intent is unresolved. |
| 2 | Protection failed and the emergency close also failed, leaving an open, unprotected, unrecorded position. | Critical | FIXED (unit-tested) | trading.js openWith; tests/execution.test.js | Intent becomes PROTECTION_FAILED; each cycle retries the close; entries blocked until resolved. |
| 3 | Broker positions with no local record were ignored. | High | FIXED — blocks entries and alerts; does not auto-close | trading.js reconcile; engine logs "entries paused" | Unmanaged positions are not closed automatically: the owner may hold positions outside AIS. Owner decision required. |
| 4 | Orders could be placed on a stale price. | High | FIXED | marketdata.quoteAgeMs; safety.entryBlockers (15 s limit); marketFeed now stamps arrival time | Entries skipped when the signal's quote is older than 15 s. |
| 5 | Owner reports were all-time totals labelled as daily/weekly/monthly, and included simulated trades. | High | FIXED (unit-tested) | src/reports/reportGenerator.js buildReport; tests/reports.test.js | Period windows enforced; only broker-demo trades count; estimated P&L shown separately; data notes state exclusions. |
| 6 | Simulated legacy trades fed the adaptive learner. | High | NOT FIXED | orderManager.checkAndClosePositions still settles legacy paper trades; tradingEngine passes them to adaptiveLearner | Needs an owner decision: discard or archive legacy trades. |
| 7 | Intermittent connection failure: broker did not answer ProtoOASymbolsListReq within 15 s during connect. | Medium | OBSERVED, not fixed | Smoke test run; connection manager retries with backoff | Reconnect logic recovers (observed earlier). Needs monitoring. |
| 8 | No authentication on any API route. Any local process can change limits, approve proposals, or toggle trading. | High | NOT FIXED | src/index.js routes | Requires an owner decision on the authentication method. |
| 9 | Loss caps ignore open floating losses. | Medium | NOT FIXED | guardrails.lossCapBreach uses realised P&L only | Mark-to-market needed. |
| 10 | NO-TRADE monitor judges rejections by price at evaluation time, not frozen levels. | Medium | NOT FIXED | governance/shadowTracker.js | Part of Priority 4. |
| 11 | Risk limits are constants, not validated or persisted configuration. | Medium | NOT FIXED | riskManager.js MAX_POSITIONS, MAX_EXPOSURE, RISK_PER_TRADE | Changing defaults needs owner authorisation (checkpoint). |
| 12 | Crash/stop marker: the clean-shutdown mark was not exercised in this round because the test tool kills the process without running handlers. | Medium | PARTIAL | src/index.js SIGINT/SIGTERM handlers | Owner should test Ctrl+C once. |

Emergency policy in force now: UNKNOWN or PROTECTION_FAILED intent, or any unmanaged broker position → no new entries. Exits and reconciliation continue. Nothing is closed automatically except a position that could not be protected.
