# AI Data Collection — Market-Hours Validation

This document is updated each time the market-hours validation of the live
snapshot recorder (`backend/data/liveSnapshotRecorder.ts`) is run. It never
contains fabricated numbers — a section reads "NOT AVAILABLE YET" rather than
an invented value when real data doesn't exist at the time of writing.

---

## Latest validation run

**Run at:** 2026-09-12, 23:31 IST (Saturday)
**Result:** Could not be performed — see blockers below.

### Blockers found

1. **Market closed.** It was a Saturday night, outside 9:15 AM–3:30 PM IST regardless of day.
2. **Groww access token stale.** `.groww_token` was last minted 2026-09-11, 13:38 IST. Groww tokens expire daily ~6 AM IST, so the token was already invalid independent of the day-of-week issue.
3. **Zero records on disk.** `data/trading_data/` was empty — confirmed by direct filesystem check, not inferred. Every `/oi-command` call attempted during this session returned empty candle arrays (a symptom of blocker #2), and the recorder correctly refused to write a snapshot from empty candle data rather than record something fabricated.

### Report (every section honestly reflects "no data", not a guess)

```
Number of market snapshots:        0
Number of option-chain records:    0
Number of strategy snapshots:      0
First/Last timestamp:              N/A — no data
5 random timestamps:               N/A — no data exists to sample
Live API vs recorded comparison:   N/A — cannot compare against nothing
Deduplication check:               N/A — nothing to deduplicate
Completeness percentages:          N/A — 0/0
Fake-data search:                  N/A — no files to search
```

```
AI DATA COLLECTION
Market data:          NOT READY
Live OI:              NOT READY
Option chain:         NOT READY
Technical features:   NOT READY
Strategy output:      NOT READY
Data quality:         N/A (no data)
Training dataset:     NOT READY
```

**Recommendation at this run:** Not enough data to start building an AI model — because no data has been collected yet, not because of any quality problem with the recorder itself (which is unit-tested — 122/122 passing, including duplicate-handling, missing-data-handling, and anti-leakage tests).

**Safety flags (unchanged):**
- `AI_MODE=ADVISORY_ONLY`
- `MODEL_TRAINING_ENABLED=false`
- `LIVE_ORDER_EXECUTION=false`

---

## What needs to happen before the next validation can produce real numbers

1. On a weekday between 9:15 AM–3:30 PM IST, regenerate the Groww token (Connect panel → Groww → **Generate Token & Save**).
2. Keep the dashboard/server running with at least one tab open on the Trader Dashboard (or let the background jobs poll it) for a few hours so snapshots actually accumulate in `data/trading_data/<YYYY-MM-DD>/`.
3. Ask for this validation to be run again — real record counts, sample snapshots, live-vs-recorded comparisons, completeness percentages, and an updated AI-readiness verdict will be filled in above, replacing this section, once real data exists.

---

## Validation history

| Run date/time | Result |
|---|---|
| 2026-09-12, 23:31 IST | Blocked — market closed + stale Groww token + 0 records (see above) |
