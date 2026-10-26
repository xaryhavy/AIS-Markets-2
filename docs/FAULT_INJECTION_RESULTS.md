# Fault-Injection Results — Demo Account (2026-10-25, Sunday, FX session open)

Approved by the owner on 2026-10-26 for demo only. No live account was touched. The production server was stopped for the runs, so the autonomous engine placed no orders.

## What was run
Harness: `scripts/faults/run.js` (one scenario per invocation). Read-only probe: `scripts/faults/probe.js`. No production code was changed.

Faults are applied to the client instance inside the harness process:
- **timeout:** the execution event that answers the new-order request is dropped. The request times out after the production 15 s limit.
- **disconnect:** the socket is destroyed right after the new-order request is written.
- **restart:** a child process crashes 50 ms after the new-order request is written, before any reply. A new process then reconciles.

Each scenario used EURUSD at the broker minimum (1000 units = broker volume 100000), stop-loss 15 pips and take-profit 45 pips (1:3). Each run closed the position it opened and confirmed the broker shows no open positions.

## Results

| Scenario | Order outcome as recorded | What the broker actually had | Reconciliation | Final state | Test P&L (account currency) |
|---|---|---|---|---|---|
| timeout | UNKNOWN: "cTrader request timed out" (after 15 s) | Position 252276705 filled | Adopted and protected in the first pass | Closed; 0 open | +0.08 |
| disconnect | UNKNOWN: "cTrader connection closed" | Position 252276925 filled | Reconnected in about 34 s; adopted in the first pass after reconnect | Closed; 0 open | +0.07 |
| restart | Intent left as SUBMITTING by the crashed process | Position 252277165 filled | New process adopted it in the first pass | Closed; 0 open | +0.07 |

Result files: `scripts/faults/results/timeout-*.json`, `disconnect-*.json`, `restart-*.json`.

## What this shows
- A lost reply does not produce a false failure. The order was recorded as UNKNOWN, not REJECTED, and the broker's fill was found.
- A connection drop during submission is handled the same way, and the automatic reconnect was enough to resolve it.
- A crash after the request left is recovered by a new process from the stored intent. No duplicate order was sent, and the intent was resolved.
- Each adopted position was protected (stop-loss and take-profit attached) before the test closed it.
- Audit chain: verified, 46 entries, no breaks (`audit.verify()`).

## Gaps the runs exposed (not fixed here)
1. **Adoption is not audited when reconciliation runs outside the engine.** The engine writes POSITION_ADOPTED. The harness calls reconciliation directly, so the three adoptions have no audit entry. The engine path is covered by its own code, but it was not run here.
2. **Closes made through `closeMarket` are not audited or recorded as trades.** The three test closes appear in the broker history, not in AIS trade records. The owner reports will not reconcile to the broker for these three positions (total +0.22 account currency).
3. **Intents for closed positions stay FILLED.** Nothing moves them to a closed state. The engine's blocking check looks only at SUBMITTING, UNKNOWN and PROTECTION_FAILED, so they do not block entries.
4. **Harness faults are injected at the client layer.** They simulate a lost reply, a socket drop and a process crash. They do not reproduce broker-side behaviour such as an order rejected after acceptance, a partial fill, or a late fill after the grace period.
5. **Power loss is not tested.** Scenario 15 in the matrix is covered only by the crash-after-send case.

## Matrix updates
- Row 5 (disconnect with an order in flight): fault-injected on demo, resolved correctly (this file).
- Row 15 (power loss during submission): partial. A process crash after the request was sent was tested; a true power loss was not.

## Follow-up - gaps 1 to 3 fixed (2026-10-26)
- Gap 1 (adoption not audited outside the engine): fixed. POSITION_ADOPTED is now written in trading.resolveIntents, the single place adoption happens. The engine's duplicate line was removed, so each adoption is audited once. Test: tests/adoptionAndCloseAudit.test.js.
- Gap 2 (closes not audited or recorded as trades): audit fixed. closeMarket writes POSITION_CLOSED. Trade record fixed for the harness path: orderManager.closeTrade closes a recorded trade and updates its record; the harness now records each adopted position and closes it through that path.
- Gap 3 (intents stay FILLED after close): fixed. closeMarket marks the matching FILLED intent CLOSED.
- Not fixed: the three test closes from the earlier runs were made before this change. They have no POSITION_CLOSED entry, no trade record, and their intents are FILLED. Backfilling records for real broker trades is a data reclassification, so it needs owner approval.
- Gap 4 (fault injection at client layer) and gap 5 (power loss) are unchanged.

## Decision - three earlier test closes left unrecorded (2026-10-26)
- The owner chose to leave the three earlier test closes unrecorded. They are not backfilled into trades or the audit log.
- Disclosure: src/reports/reportGenerator.js lists them in UNRECORDED_BROKER_CLOSES (position IDs 252276705, 252276925, 252277165; reported P&L 0.08, 0.07, 0.07). Any report period that contains them shows a dataNotes entry and summary.unrecordedBrokerCloses. Their P&L (0.22) is excluded from all totals.
- Test: tests/reportUnrecorded.test.js (4). Full suite: 172 pass, 0 fail.
