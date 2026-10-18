# ProTrader (supervisor) log

Every trading-logic change is reviewed by ProTrader (`.claude/agents/protrader.md`) before it goes
live. One entry per verdict, newest at the bottom.

## 2026-10-18 · Changes approved by the OWNER (before the supervisor gate existed)

These were approved directly by the owner after the 12–16 Oct comparison. They are not supervisor-reviewed and are
queued for its first review.

**Changes:**
- P8 plan lock
- fix 3 (duplicates by level, conflict → stand aside)
- P2 range day
- P7 no 5-min break alerts before 09:30
- P9 Target 1 at the OI wall in front

**Evidence:** current 11 trades, 55% wins, 4 SL → with the changes 7 trades, 71% wins, 2 SL. One week only, index points
before costs, no premium test.

**Status:** live since commit c7db560. **PENDING SUPERVISOR REVIEW** on ≥ 60 sessions with premium P&L.

## Open audit points for the supervisor (option-buyer audit, 2026-10-18)

1. Breakout entry has the weakest record (15-min upside breakouts: 28% follow-through), while sweeps did better.
2. No premium stop (Thursday: SENSEX 74200 CE fell −39% before the index stop).
3. Time decay and days-to-expiry are ignored (Friday: index +74, premium −6%).
4. No IV / VIX check.
5. NIFTY and SENSEX can both be open: one correlated bet, twice.
6. No ₹ position sizing or daily loss cap.
7. No event calendar.
8. Review weights and A/B/C cut-offs are unvalidated.
9. No trailing stop after Target 1.
10. Opening-drive days are always MISSED.

## 2026-10-18 · ProTrader premium backtest #1 (≈2 years, real Dhan premiums)

Details: `backend/research/protrader/RESULTS.md`.

- **System:** NOT PROFITABLE for an option buyer after costs.
  - Live logic B: NIFTY 484 trades, 37% win, −5.7% per trade, −₹1.50 L (1 lot).
  - SENSEX 508 trades, 40% win, −3.6% per trade, −₹1.05 L.
- **P2 range-day filter: APPROVE.** Better in development and validation for both indices, and lower drawdown.
- **P8 lock + fix 3: APPROVE** (bug fix).
- **P9 wall in front: NEED MORE DATA** (no OI history; the OI-minute log is accumulating).
- **−30% premium stop: REJECT** (helps NIFTY, hurts SENSEX in both periods).
- **Main loss driver:** 41% of trades hit the stop at −26.6% average. Entries after 14:00 and expiry-day entries are the
  worst. These are the next tests.
- **ProTrader advice to the owner until an edge is validated:** paper or minimum size only.
