# Owner Reports — Priority 5 (2026-10-26)

## What is produced
Each run writes four periods (daily, weekly, monthly, yearly) as JSON and Markdown to data/reports/<period>-<date>.{json,md}.
Builder: src/reports/ownerReport.js (pure). Writer: src/reports/reportGenerator.js generateReport / generateAll.

## Content (as mandated)
- Header: period bounds, generation time, sources, label.
- Attention and recommendations: severity-ranked. Critical/high → "investigate now". Medium → "owner decision" (never changed automatically).
- Market conditions: regime observations and decisions per instrument.
- Opportunities: decisions in period, states (TRADE / WAIT / NO_TRADE, derived for older records), skip reasons.
- Trades: closed in period, exact vs estimated results, open now, execution by status, adopted positions.
- Performance: exact realised P&L, estimated separately, wins/losses, win rate, average win/loss, expectancy per trade, profit factor, maximum drawdown from balance samples in period, breakdowns by instrument, strategy and regime. Each carries a sample flag (≥30 trades to call it sufficient).
- Risk: admission refusals, other risk refusals, open positions now. Emergency-stop history is not stored as events, so only the current state is known.
- Execution: intents by status, bad outcomes, unresolved now.
- Hypothetical NO-TRADE: outcome counts, target rate with sample flag, labelled HYPOTHETICAL. Excluded from every result figure (tested).
- Monthly adds a weekly breakdown; yearly adds a monthly breakdown.
- Missing or incomplete data: always listed (broker statement not reconciled, commission/swap not stored separately, no benchmark, no mark-to-market, equity samples, legacy decisions).

## Tests
tests/ownerReport.test.js: 15 tests (period starts, boundary exclusion, exact totals and expectancy, estimates separated, sample flags, simulated exclusion, hypothetical exclusion, drawdown from samples, drawdown unavailable, legacy decision handling, critical attention, owner-decision recommendations, missing-data statements, weekly/monthly breakdowns, Markdown content). Full suite: 109 pass in both folders.

## Real output (2026-10-25 run, your data)
- Daily/weekly/monthly: 0 trades closed in period, 1 demo trade open.
- Decisions in the log: 1885, all before this period (1241 RISK_ADMISSION refusals, 644 not qualified).
- Attention raised: risk admission refused more than half of decisions (owner decision); ML not active.
- Missing data listed as stated above.

## Sample reports (SYNTHETIC — format only)
docs/sample_reports/daily-SYNTHETIC.md, weekly-SYNTHETIC.md, monthly-SYNTHETIC.md, yearly-SYNTHETIC.md. Each is labelled synthetic at the top. They are NOT performance.

## Not done
- Broker statement reconciliation (no statement feed is read).
- Commission and swap per trade (not stored separately).
- Benchmark comparison (no benchmark defined; the owner must choose one).
- Mark-to-market of open positions.
- Market-understanding narrative (structure, levels, events): the report states regimes and counts, not an analytical narrative.
- Strategy version history (decisions are "unversioned").
