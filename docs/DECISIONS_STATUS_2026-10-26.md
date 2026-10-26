# Status of the 11 Owner Decisions — 2026-10-26

Branch: claude/ais-markets-ctrader-f6a11a. Nothing pushed. Demo only. Live stays locked.
Full suite at the last commit: **280 tests, 280 pass, 0 fail, 0 skipped** (`node --test tests/*.test.js`).

Status words: **Resolved** (built, tested, and verified where stated), **Partial** (built, with a stated gap), **Pending** (needs an owner action or an input).

| # | Decision | Status | Commit | What is done | What is still open |
|---|---|---|---|---|---|
| 1 | Legacy simulated trades: archive, tag, exclude | **Resolved** (applied to real data) | e43a8cf | Tagged 12 legacy records `legacy/unverified` with provenance; full backup written first; rollback removes only the tags; excluded from learning, owner performance and strategy evaluation | Rollback has not been exercised on the real data |
| 2 | Mark-to-market loss caps (2% day, 5% week, 10% drawdown) | **Resolved** (built); live equity source verified | 4a70097 | Caps validated and persisted; equity = balance + unrealised P&L; breach blocks entries, alerts, leaves positions managed; owner resume with reconciliation | Live cap breach not exercised; live values need separate approval (demo values only) |
| 3 | Data-gate gap tolerance (fail closed, default 0, calendar) | **Resolved** | ec6e94e | Missing completed candle in the lookback blocks the instrument and timeframe; weekend and configured closures excused; tolerance 0 to 20, owner set, audited; each block episode logged with reason codes | Holiday calendar is empty by default; the owner must add closures |
| 4 | Pause entries after 3 failed cycles | **Resolved** | 5d16590 | Pause after 3 (configurable 1 to 20), persisted, alert, exits and monitoring keep running; resume needs reconciliation and owner action | none |
| 5 | Unmanaged position policy | **Partial** | 2a45acb | Critical, blocks entries; never auto-closed or adopted; owner ADOPT, CLOSE or IGNORE with recorded reason; read-only list with protection status (API) | **Dashboard panel not built** (API only) |
| 6 | Decision-log compaction (30-day retention, rollups, protected records, dry run first) | **Partial**: built, dry run shown, **not applied** | ca708cd | Dry run, idempotent apply, reversible within the retention window, protected records, archive kept | **Checkpoint: no compaction applied.** Dry run finds 0 compactable records (see below) |
| 7 | PAPER and DEMO_SUPERVISED modes | **Resolved** | 398def3 | PAPER never sends a broker order (simulated fills, own evidence class); DEMO_SUPERVISED needs an owner session of 0.1 to 8 hours, expires to OBSERVATION; LIVE still refused; every change audited | none |
| 8 | Yearly benchmarks (buy-and-hold and flat/cash) | **Partial**: built; buy-and-hold **unavailable** | 5e1b9c3 | Two labelled baselines with definition; buy-and-hold only from full coverage; otherwise "benchmark unavailable", never estimated | No historical price source for a year; the section reports unavailable until one is connected |
| 9 | Alert channels (Telegram, email fallback, env vars) | **Partial** | 5956f32 | Telegram built; email adapter built; off until configured; dedupe, rate limit (15 min per code, 20 per hour); credentials never logged; alerts on all nine listed events | **Email needs the nodemailer package** (not installed; not added without approval). Telegram not exercised against a real bot |
| 10 | INVALIDATED outcome type | **Partial** | ab3e60c | Own outcome type with exact rule and time; excluded from win and loss; counted and rated | **Scope:** current hypotheticals enter at the decision price, so nothing can be invalidated until opportunities with a pending entry exist |
| 11 | Owner stop route (idempotent, recorded, no close, resume with reconciliation) | **Resolved** (live-tested) | aff8cd8, f3dd1c9 | Owner-authenticated; first request 201, repeat 200 with no new record; records who, when, reason and state; positions untouched; resume needs reconciliation; tested for repeats, restart mid-shutdown, and unauthenticated access (401) | none |

## Items needing your action
- **Item 6 checkpoint.** The dry run on the real decision log finds nothing to compact. At 30 days the cutoff is 2026-09-26 and no decision is that old. At a 1-day what-if, 0 records are compactable. The 1,885 oldest decisions are in the legacy object format (no state or reason code), so the rule does not match them. Choosing to compact them needs a rule decision from you. Nothing has been applied.
- **Item 9 email.** `npm install nodemailer` is needed before the email fallback works. I have not added it without your approval.
- **Item 5 dashboard.** The read-only panel is not built. The API exists at `GET /api/positions/unmanaged`.
- **Item 8 benchmark data.** A yearly buy-and-hold needs a historical price source.

## Environment variables for alerts (set only these; never commit values)
```
ALERT_TELEGRAM_BOT_TOKEN     bot token from BotFather
ALERT_TELEGRAM_CHAT_ID       chat id that receives the alerts
ALERT_EMAIL_SMTP_HOST        SMTP server (fallback)
ALERT_EMAIL_SMTP_PORT        SMTP port, e.g. 587
ALERT_EMAIL_SMTP_USER        optional SMTP user
ALERT_EMAIL_SMTP_PASS        optional SMTP password
ALERT_EMAIL_FROM             sender address
ALERT_EMAIL_TO               recipient address
```
Alerts stay off until at least one channel is set. Email also needs the nodemailer package installed.

## Live checks (demo server, 2026-10-26, 01:10 to 01:14 UTC)
- Unauthenticated `POST /api/system/shutdown`, `GET /api/system/shutdown`, `POST /api/system/shutdown/resume`: 401 each.
- First shutdown request: 201, record with who, when, reason and state. Repeat: 200, same record.
- Readiness while shut down: disabled, with the emergency stop and pause reasons.
- Resume after reconciliation: 200. Readiness enabled again. Audit chain verified at 72 entries.
- Equity reading from the broker works (unrealised P&L request): last equity 9,749.07, matching the balance with no open positions.

## Next priority
1. Your decision on item 6 (which legacy-format decisions to compact, if any).
2. Approve `nodemailer` (for the email fallback), and build the dashboard panel for unmanaged positions.
3. Connect a historical price source so yearly benchmarks can be reported.
4. Once there are pending-entry opportunities, exercise INVALIDATED on the demo account.

## Update - completion pass (commit after aa10904)
- **5 Unmanaged positions:** dashboard panel added (read-only, text-escaped, no action buttons). Tests: tests/dashboardUnmanaged.test.js (3). Resolution remains API-only, owner action.
- **8 Yearly benchmarks:** yearly reports now load hourly completed bars from the broker (read-only trend-bar requests, `src/analytics/benchmarkBars.js`). Buy-and-hold is reported only when the bars cover the period; otherwise "benchmark unavailable". Tests: tests/benchmarkBars.test.js (4). Needs an authenticated broker session; otherwise unavailable.
- **9 Alert channels:** `nodemailer` ^6.10.1 added as a declared dependency; email fallback now works through SMTP when the ALERT_EMAIL_* variables are set. Telegram code is in place but NOT exercised against a real bot (no token available here). Tests updated to the installed-library state: tests/notify.test.js (10).
- **6 Compaction:** built and dry-run tested. **Not applied.** The owner's answer on which legacy-format decisions to compact is still needed.
- **10 INVALIDATED:** rule, storage, summaries and report counts are complete. The producer of pending-entry opportunities is NOT built: defining the entry trigger for a rejected signal changes what the NO-TRADE monitor measures, so it needs the owner's rule.
- Full suite at this commit: 288 pass, 0 fail.
