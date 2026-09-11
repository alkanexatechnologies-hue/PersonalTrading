# Signal Audit Trail

For transparency and auditability, each newly emitted OI-Command signal is recorded to a
dedicated, append-only audit channel.

## What is recorded (per signal)

| Field | Source |
|-------|--------|
| Timestamp (epoch ms + IST) | server clock at emit |
| Instrument (symbol + name) | signal payload |
| Market data source | always `GROWW` |
| Data timestamp (`oiAsOf`) | OI snapshot time |
| Data age (seconds) | `dataAgeSec` at emit |
| Strategy / rule version | `RULE_VERSION` (`backend/compliance/disclosures.ts`) |
| Signal type | direction (UP/DOWN) + option type (CE/PE) |
| Entry | option LTP at signal |
| Stop loss | management.stopLoss |
| Target | management.targetLo / targetHi |
| Risk / reward | computed from entry, stop, target |
| Signal status | `EMITTED` (later horizon evaluation lives in `oi-command-log.json`) |
| Automated execution enabled | paper auto-trade active flag (simulated) |
| Order / execution reference | `null` — no live order execution (simulated only) |

## Storage

- Channel: `signal-audit` in the centralized log (`backend/log/centralLog.ts`).
- Durable file: `data/log/signal-audit-<YYYY-MM-DD>.jsonl` (one JSON object per line,
  append-only, date-rotated with retention sweep).
- In-memory ring buffer for fast UI reads.

## De-duplication

Audit records are written only when a **new** signal is logged. This piggybacks on the
existing `logOiSignal()` de-dup (one signal per symbol per ~14-minute slot per day), so
polling/refreshes do not create duplicate audit rows.

## Reading / exporting

- JSON: `GET /api/audit/signals?limit=200[&symbol=^NSEI][&mins=120]`
- CSV: `GET /api/log/export.csv?channel=signal-audit` (BOM for Excel).

## Scope note

This audit trail covers signal generation and data provenance. It is **not** an
order-execution audit (no live orders are placed). A broker order audit, order tagging and
reconciliation would be additional and **REQUIRE BROKER/EXCHANGE CONFIRMATION** if live
execution is ever added.
