# Operations and Autonomy Controls — Priority 6 (2026-10-26)

## Built and tested
- **API authentication** (src/security/auth.js, src/index.js middleware). Every /api route except /api/health needs the owner token in the X-Owner-Token header. The token is generated on first start, printed once to the server console, and only a salted scrypt hash is stored in data/auth.json. Verification is constant-time. Failed attempts are audited. The wildcard CORS header was removed.
  - Dashboard and setup page send the token and ask for it once per tab when it is missing or rejected (public/index.html, public/setup.html).
- **Operating modes** (src/governance/mode.js). OBSERVATION and RESEARCH place no broker orders. DEMO_AUTONOMOUS (the existing behaviour, default) places demo orders within the risk limits. PAPER, DEMO_SUPERVISED and LIVE are listed as unavailable and cannot be selected. Selecting an order-placing mode requires the exact phrase "CONFIRM <MODE>". Changes are recorded with source and time. The order boundary refuses broker orders in a non-order mode (src/risk/preTrade.js). Decisions are still recorded in every mode.
- **Audit trail** (src/audit/audit.js). Append-only, hash-chained: each entry holds the hash of the one before. verify() recomputes the chain and reports the first broken entry. Recorded: startup, shutdown request, owner token created, failed authentication, mode changes, limit proposals/approvals/rejections, emergency stop on/off, recovery acknowledgement, order submission/refusal/fill, unknown outcome, protection failure, emergency close, position adoption, alert opened/resolved.
- **Alerts** (src/ops/alerts.js). Opened when a condition appears, resolved when it clears, both audited. Conditions: unresolved orders (critical), unmanaged positions (critical), recovery review (critical), reconciliation failure (high), emergency stop (high), broker or feed down (high), no broker orders in this mode (info).
- **Readiness** (src/governance/readiness.js). Execution is enabled, disabled (with reasons), or uncertain. Uncertainty outranks everything. "autonomous" is true only in DEMO_AUTONOMOUS with execution enabled.
- **Health** (GET /api/health, open). Components: broker, feed, engine, reconciliation, auth, audit. Overall "healthy" only if every component is ok.
- **Dashboard** shows the backend's readiness state, the reasons, and the count of open alerts (critical counted separately). It does not decide these itself.

## Tests
tests/operations.test.js: 13 tests (token creation, verification, no plaintext on disk; chain verification, detection of altered and deleted entries; default mode, LIVE locked, unbuilt modes refused, confirmation required; readiness states and uncertainty precedence; health; alert diff; boundary refusal in observation mode).
Full suite: 122 pass in both folders.

## Live boot check (worktree, trading switched off, base .env)
- /api/health without token: 200, status degraded (broker still connecting, engine not running), correct.
- /api/readiness without token: 401.
- /api/readiness with token: executionState disabled, reasons: automatic trading switched off by owner; broker state APP_AUTHENTICATED; live price feed not ready.
- /api/audit/verify: ok, 3 entries (owner token created, startup, one failed authentication).
- Access-Control headers: none.

## Not done (Priority 6 items)
- PAPER (simulated fills) and DEMO_SUPERVISED (per-trade owner confirmation) are not implemented; they are refused, not faked.
- Rate limiting on failed authentication attempts.
- Single owner token: no rotation endpoint. Rotation means deleting data/auth.json and restarting; the new token is shown once.
- Structured logs: console output is unchanged; the audit trail is the structured record of critical events.
- Alert delivery outside the dashboard (email, phone): none.
- The HTML pages themselves are served without a token (they contain no data); all data routes require it.
- Mode changes that loosen authority are confirmed by phrase only; there is no second approver.

## Incident found during verification (fixed)
The execution tests load the order path, which now writes audit records. They did not redirect the audit file, so 11 fake-broker events (ORDER_SUBMITTING, ORDER_FILLED, ORDER_OUTCOME_UNKNOWN, EMERGENCY_CLOSE, PROTECTION_FAILED) were written to the main folder's data/audit.log. No live order caused them; the real server had never run there. Fix: tests/execution.test.js now points AIS_AUDIT_FILE at a temporary file before loading the order path, and the polluted log was deleted. Verified: npm test in the main folder leaves no audit.log behind (122 pass).

## Update — 2026-10-26
- **Failed-attempt limiter built** (src/security/auth.js, src/index.js middleware). Five wrong tokens from one address within 15 minutes lock that address for 15 minutes (HTTP 429, Retry-After). A correct token is accepted while locked. Audited as AUTH_FAILED (with count) and AUTH_LOCKED. Tests: tests/authRateLimit.test.js. Live check passed (see TEST_EVIDENCE.md). Limitation: the limit is per address, so every local client shares one counter.
- **Owner connect, disconnect and logout audited** (OWNER_CONNECT, OWNER_DISCONNECT, OWNER_LOGOUT, with state before and after).
- **Engine failure alert**: three consecutive failed cycles raise CYCLE_FAILING (high). Tests: tests/engineFailureAlert.test.js.
- The "Not done" item on rate limiting is now closed. Still open: PAPER and DEMO_SUPERVISED modes, token rotation endpoint, alert delivery outside the dashboard.
