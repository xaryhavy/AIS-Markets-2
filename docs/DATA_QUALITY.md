# Data Quality — Priority 2 (2026-10-25)

## Implemented
- src/data/quality.js: candle validation (finite positive prices, high/low consistency, period-aligned times), duplicate and out-of-order handling, completed vs forming vs future candles, gap detection with missing-bar counts, a fingerprint of the exact candles used, staleness per timeframe, 30-second analysis expiry.
- signalEngine analyses completed candles only (previously it used the forming candle).
- Engine: assesses each symbol before scanning, skips symbols with bad or stale data, rechecks the same fingerprint before dispatch, and records the fingerprint on every decision (src/governance/shadowTracker.js).
- tests/dataQuality.test.js: 11 tests (validity, duplicates, ordering, forming/future exclusion, gaps, fingerprint, staleness, recent gaps, expiry).

## Live check (read-only, demo broker, 2026-10-25, a Sunday)
- BTCUSD: OK. 3000 M1 candles, 1 forming, 3 gaps; no invalid candles.
- EURUSD, GBPUSD, USDJPY, XAUUSD: BLOCKED. Newest completed candle about 47 hours old. FX and gold were closed for the weekend, so the block is correct.
- No invalid, duplicate or future candles were found on any symbol.

## Not done (Priority 2 items)
- Market understanding additions (structure, support/resistance, supply/demand, liquidity, event risk). Not justified yet: the existing regime, pattern and multi-timeframe modules are the current evidence sources, and new analysis needs its own validation before use.
- Provider-error tracking beyond the connection state. Staleness covers silent feed failures; error counts are not yet recorded.
- Session-aware staleness. FX gaps over weekends are reported correctly but not yet distinguished from data faults; the block is conservative.
- Gap tolerance on quiet instruments: a single missing minute in the last 30 candles blocks trading. Needs review once live-session data is available.

## Update — 2026-10-26
- Provider-error counts are built (src/ctrader/providerErrors.js): timeouts, broker error responses, dropped sessions, shown on /api/ctrader/status. Counts reset on restart. Tests: tests/providerErrors.test.js. Still open: counts are not yet used by any gate or alert.
