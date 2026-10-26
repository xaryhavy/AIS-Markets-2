# Architecture Map — AIS Markets (2026-10-26)

Built from the code as it stands. Paths are relative to the repository root. Nothing here is a plan.

## 1. Entry point and lifecycle
- `src/index.js`: Express server on port 37492. Mounts the owner-token middleware on every `/api` route except `/api/health`. Starts the cTrader connection, the trading engine, and the recovery-fence check. A deliberate stop (SIGINT or SIGTERM) writes the clean-shutdown marker; a crash does not.
- `public/`: dashboard and setup pages. They display backend state and never decide readiness themselves.

## 2. Data flow (one engine cycle, every 5 s)
`src/engine/tradingEngine.js` `runCycle()`:
1. **Broker and feed check:** `ctrader/trading.isReady()` (broker authenticated and live feed subscribed).
2. **Reconciliation:** `ctrader/trading.reconcile()` confirms unknown orders and finds unmanaged broker positions. A failure is recorded as unresolved, which blocks entries.
3. **Exits (always run):** `execution/orderManager.syncWithBroker()` and `checkAndClosePositions()`. Exits run even when entries are off.
4. **Entry gate:** `governance.allowTrade('demo')` (owner switch, recovery fence, loss caps, emergency stop). If it refuses, the cycle stops before any scan.
5. **Data integrity:** `data/quality.assess()` per symbol. Bad or stale data is not analysed.
6. **Analysis:** `intelligence/signalEngine.scanAll()` on completed candles, `timeframes.analyzeLive()` for multi-timeframe context, `buildFeatures()`.
7. **Frozen levels:** entry, stop and target are computed before any gate can reject the signal (NO-TRADE monitor input).
8. **Gates, in order:** operating mode, data quality, higher-timeframe confirmation, `execution/safety.entryBlockers()` (quote age, unresolved orders, unmanaged positions, feed), cooldown, reward-to-risk floor, learned win probability, position size, `risk/riskManager.checkRisk()`, and a final data-fingerprint and expiry check before dispatch.
9. **Dispatch:** `execution/orderManager.openPosition()` → `ctrader/trading.openMarket()` (write-ahead intent, submit, confirm fill, verify protection).
10. **Recording:** every signal, executed or not, goes through `governance/shadowTracker.recordDecision()` with a state (TRADE, WAIT, NO_TRADE), a reason code and frozen levels. Repeated WAITs are collapsed (see `docs/NO_TRADE_MONITOR.md`).

Separately, every 60 s: `governance/noTrade.runMonitor()` resolves frozen hypothetical outcomes from completed one-minute candles only.

## 3. Execution authority boundaries
| Boundary | Where | What it enforces |
|---|---|---|
| Operating mode | `governance/mode.js`, `risk/preTrade.js` | OBSERVATION and RESEARCH refuse all broker orders. LIVE and unbuilt modes cannot be selected. |
| Order boundary | `ctrader/trading.js` `openMarket()` | Refuses when not connected; the pre-trade check runs with live account and quote state. |
| Risk admission | `risk/riskManager.js`, `risk/limits.js` | Stops, reward-to-risk, position size, exposure, position count, validated limits. Limits can be changed only by an owner-approved proposal. |
| Loss caps and fence | `governance/guardrails.js` | Daily, weekly, monthly caps; recovery fence after an unclean stop; acknowledgement. |
| Emergency stop | `risk/limits.js` (`emergencyState`) | Refuses every entry; audited on and off. |
| Readiness | `governance/readiness.js` | Computes enabled / disabled / uncertain from backend state only. |
| Owner access | `security/auth.js`, `index.js` middleware | Token required on every API route; per-address lockout after five failures; token rotation. |

## 4. Storage and evidence
- `data/storage.js`: JSON collections with atomic writes, per-collection write serialisation, and `mutate` for locked read-modify-write. Collections in use: `decisions`, `no_trade_outcomes`, `trades`, `alerts`, `risk_config`, `run_state`, `guardrails`, `auth`, `preferences`, and others.
- `audit/audit.js`: append-only, hash-chained log. `verify()` reports the first broken entry.
- Evidence classes (per the mandate) are not yet separated in storage: legacy simulated trades and hypothetical outcomes share collections with broker records. This is an open item.

## 5. Intelligence and learning
- `intelligence/`: signal engine, strategies, price-action and candlestick patterns, regime detector, multi-timeframe analysis, confluence, supply/demand, forecaster, adaptive learner (circuit breaker and weights), ML model (validated on held-back trades before use), pattern miner (owner-approved rules), optimizer, backtest engines in `backtest/`.
- Learning writes weights and rule proposals; it cannot change risk limits or execution permissions (no code path does so).

## 6. Operations and reporting
- `ops/alerts.js`: alerts opened and resolved on condition changes, audited. Delivered on the dashboard only.
- `engine/tradingEngine.js` `syncOps()`: builds the alert conditions every cycle, including the cycle-failure condition.
- `reports/`: daily, weekly, monthly and yearly owner reports (JSON and Markdown), period-correct, with hypothetical outcomes in a separate section.
- `analytics/performance.js`: performance metrics.

## 7. Broker integration
- `ctrader/openApiClient.js`: protobuf-framed TCP/TLS client; request timeouts; error responses; session loss. Counts failures into `ctrader/providerErrors.js`.
- `ctrader/connectionManager.js`: connect, reconnect, watchdog, balance refresh, status.
- `ctrader/marketFeed.js`: symbol resolution, history seeding (bounded fetch), spot subscription, quote timestamps.
- `ctrader/auth.js`: broker OAuth tokens.
- `ctrader/setupFlow.js`: first-time account selection.

## 8. Known dependencies and risks in the map
- The engine depends on many modules by name; a missing import fails only at runtime, when a path is reached. The reward-to-risk defect was of this kind and was found by a wiring test.
- Storage writes are serialised inside one process only. A second process writing the same data folder is not protected.
- Broker behaviour under timeouts, disconnects and restarts during submission is covered by fake-broker tests only.
