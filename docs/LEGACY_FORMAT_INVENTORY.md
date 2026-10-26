# Decision Record Format Inventory (read-only) — 2026-10-26

Source: `data/decisions.json` (4,375 records) and `data/no_trade_outcomes.json` (5,503 records), read at 2026-10-26 ~01:35 UTC.
No record was changed to produce this inventory. Produced by `src/governance/legacyFormats.js` `inventory()`.

| Format | Records | First | Last | Linked to a NO-TRADE outcome | Linked to an executed trade | Symbols |
|---|---|---|---|---|---|---|
| CURRENT (string decision, state and reasonCode present) | 2,490 | 2026-10-25 21:49:18 UTC | 2026-10-26 01:34:36 UTC | 2,320 | 0 | EURUSD 416, GBPUSD 458, USDJPY 528, XAUUSD 444, BTCUSD 644 |
| LEGACY_OBJECT_DECISION (decision holds `{decision, reason}`) | 1,885 | 2026-10-23 08:29:07 UTC | 2026-10-23 09:46:54 UTC | **1,885 (all)** | 0 | EURUSD 377, GBPUSD 377, USDJPY 377, XAUUSD 377, BTCUSD 377 |
| LEGACY_NO_STATE | 0 | — | — | — | — | — |
| LEGACY_NO_REASON_CODE | 0 | — | — | — | — | — |
| OTHER | 0 | — | — | — | — | — |

## What this means
- Only two formats exist in the real log: the current format, and the pre-structured-logging object format.
- All 1,885 legacy-format records are linked to NO-TRADE outcomes. Under the protection rule they are never eligible for compaction, even if the format were approved. A format approval alone would compact nothing.
- No decision record links to a trade by identifier. Trades carry no decision id, so "linked to an executed trade" is 0 by construction. Trades in the log (13) are all demo or simulated and are not matched to decisions by id.
- Date range of the legacy format: 23 October 2026, 08:29 to 09:46 UTC, a 78-minute window. It is consistent with logging being changed in one session.

## Decision required from the owner
- Legacy-format decisions are not compacted by default. Each legacy format needs a specific approval before anything can happen to it. Right now there is nothing to approve that would compact a record, because all of them are linked to outcomes.
- Current-format WAIT / NOT_QUALIFIED records older than 30 days: none yet. The oldest current-format record is 2026-10-25 21:49 UTC.

## Tags applied
- All 1,885 legacy-format decisions are tagged `evidenceStatus: legacy/unverified` with `legacyProvenance` (format, taggedAt, taggedBy). Nothing else changed. A full backup of the decision file was written first. Rollback removes only these tags.
