# NO-TRADE Outcome Monitor — Priority 4 (2026-10-26)

HYPOTHETICAL. Nothing in this monitor is an execution, a profit, a loss, or a closed position.

## Build order (as mandated) and status
a. Capture rejections — DONE. Every decision in src/governance/shadowTracker.js recordDecision now stores: state (TRADE / WAIT / NO_TRADE), reasonCode (stable code from src/governance/noTrade.js reasonCode), regime, strategy, strategyVersion ("unversioned" — no versioning exists yet), dataFingerprint, priceAtDecision. Capture points: data quality, higher-timeframe gate, entry blockers, cooldown, reward:risk floor, ML threshold, zero size, risk admission, stale analysis, execution refusal, and not-qualified signals.
b. Freeze the hypothetical — DONE. Levels (entry, stop, target, action) and horizon (60 min) are computed in the engine before any gate can reject the signal (tradingEngine: signal.levels). Stored once on the decision; no code path rewrites them. Signals without levels are NOT_EVALUABLE.
c. Monitor outcomes — DONE. runMonitor runs every 60 seconds on its own timer, independent of the trading gate, so it keeps resolving while trading is paused. It uses completed one-minute candles only.
d. Ambiguity — DONE. A candle touching both stop and target is AMBIGUOUS and not counted. The order is never guessed.
e. Separate outcome records — DONE. Stored in data/no_trade_outcomes.json, linked by decisionId. Decision records are not modified.
f. Analytics — DONE in code (summarise): counts by reason code, instrument, regime; target-rate with Wilson 95% interval; flags for owner review only when the interval is clearly on one side of 50%. Nothing changes automatically.
g. Reports — DONE. Daily/weekly/monthly/yearly reports carry a separate "hypothetical" section labelled HYPOTHETICAL.
h. Never counted as executions, profit, loss or closed positions — DONE and tested (report test: outcomes do not change realised P&L or closed-trade counts).
i. Tests — DONE: tests/noTrade.test.js (17 tests).

## Defects found and fixed on the way
- Decision records stored the outcome as an object, so the old shadow evaluation never ran and the report's executed and skipped counts were always zero. Fixed: new records store strings; old records are read through normalizeDecision and flagged legacy, not rewritten.
- The old shadow evaluation judged skips against the price at evaluation time, with no frozen levels. Retired (evaluateShadows is now a stub that says so).

## Evidence from the real decision log
- Monitor run on 2026-10-26 against data/decisions.json: 1885 records written.
  - 1241 RISK_ADMISSION (old "Max exposure reached" skips)
  - 644 NOT_QUALIFIED
  - All 1885 NOT_EVALUABLE: legacy decisions froze no levels, so no honest outcome exists.
- Consequence: the existing history cannot evaluate rejections. Evaluable evidence starts with the first decision recorded after this change.
- An earlier run mislabelled the 644 unqualified skips as EXECUTED. Found by inspecting the output, corrected, and the generated file was regenerated (it is derived entirely from the decision log).

## Not done
- INVALIDATED status: no invalidation conditions are defined for signals, so none is produced.
- Strategy versioning: every decision says "unversioned".
- Analysis has not yet been run on live post-change decisions: the engine must run for hours before any evaluable outcome exists.
- Rule changes: none made. Any change based on these findings needs your approval (checkpoint).

## Update — 2026-10-26: repeated WAIT collapsed
- A WAIT whose symbol and reason code match the last logged decision for that symbol is no longer written to `decisions.json`. Its frozen levels are stored as a `PENDING` record in `no_trade_outcomes.json` with `collapsedInto` pointing at the kept decision.
- `runMonitor` resolves pending records in one batch from their own frozen levels; resolved records keep the levels.
- Matching uses the reason code, not the reason text, because the text contains values that change every cycle.
- Effect: fewer decision records per cycle. Every rejection still has an evaluable outcome. Report counts of decisions drop accordingly; outcome counts do not.
- Existing decision history is not compacted. Tests: tests/waitDedupe.test.js (6).
- The item "Analysis has not yet been run on live post-change decisions" is still open.
