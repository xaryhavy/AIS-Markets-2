# Risk Controls — Priority 3 (2026-10-26)

## Built
- src/risk/limits.js: validated, persisted risk configuration. Each limit has safe bounds (checkValue), whole-number rules for counts, an active value, and an enabled flag. Proposals need a rationale and only take effect when approved; every change is recorded in history with its source. Emergency stop state persisted. Equity history sampled for drawdown.
- src/risk/preTrade.js: server-side pre-trade check, called inside the order path (src/ctrader/trading.js openWith) before any intent is recorded or any order is sent. Checks: emergency stop, balance known, stop/target on the correct side, reward:risk floor 1:3, risk per trade, open-position count, total open risk (when enabled), exposure, open positions without stops, per-instrument count (when enabled), spread (when enabled), drawdown (when enabled), consecutive losses (when enabled), UTC session windows (when enabled).
- The engine's sizing and checks now read the configuration (riskManager, tradingEngine, safety), not constants. Current active values equal the previous constants.
- Emergency stop: /api/risk/emergency-stop blocks every new entry; exits and reconciliation keep running. Requires a reason of at least 5 characters.
- API: GET /api/risk, POST /api/risk/propose, /approve, /reject, /emergency-stop.

## Tests
77 tests pass (npm test), including tests/riskControls.test.js (27 cases: defaults equal previous behaviour, proposed limits off, bounds, wrong-side stops, RR floor, risk cap, position count, exposure, missing stops, emergency, balance, spread, drawdown, consecutive losses, session windows including midnight, USD-base conversion, drawdown window).

## Finding that needs your decision (checkpoint)
The decision log (data/decisions.json, 1885 entries) shows 1241 decisions skipped with "Max exposure reached". The sizing rule (1% of balance at risk over a 1.5 ATR stop) and the exposure cap (20% of balance as notional) are incompatible for FX: at 1% risk the notional is roughly balance x 1% / (stop as % of price). A 0.3% stop gives 3.3x balance; the cap allows 0.2x. So the engine has been largely idle since the exposure cap was introduced. The values were not changed (parameter changes need owner approval).
Options for you to choose:
  a. Raise maxExposurePct (e.g. to 300 = 3x balance) — this is leverage; it needs an owner decision on the maximum leverage you accept.
  b. Keep exposure at 20% and accept that the engine trades very rarely.
  c. Redefine exposure as margin used (needs broker margin data, not yet read).

## Not built (Priority 3 items)
- Correlated exposure across currencies (only per-instrument count, when enabled).
- Loss-based controls use realised P&L only (open floating loss not counted) — mark-to-market still missing.
- Owner authentication for these routes (defect 8 in the completion register): any local process can propose, approve or stop.
- Dispatch-path revalidation for pending/batch/queued paths: only the ordinary path exists in this codebase.
- Shutdown/recovery test matrix (owner disables autonomy, broker down, restart) — not executed.

## Update — exposure cap set to 5x (owner choice)
- maxExposurePct upper bound raised from 50 to 500 (100 = 1x leverage). Bound change and value were proposed and approved through the approval flow; history recorded in data/risk_config.json.
- Active value: 500 (5x leverage). Previous value 20 (0.2x), now superseded.
- Effect: the 1,241 "Max exposure reached" skips in the decision log are no longer caused by the exposure cap at the current sizing. Total open risk is still uncapped (proposed limit, disabled).
- The running server loads the new configuration on its next start.
