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

## 2026-10-18 · ProTrader premium backtest #2: four tests (`protrader/RESULTS2.md`)

- **APPROVE: skip the index's own expiry day + retest entry** (T2 + T3a).
  - Better in development and validation for both indices.
  - NIFTY: −₹1.50 L → −₹0.32 L. SENSEX: −₹1.05 L → −₹0.44 L.
  - SENSEX validation turned positive (+2.5% per trade). Drawdowns much lower.
  - **Implemented** in the co-pilot: an expiry-day trigger is shown but not given; a trigger becomes "waiting for the
    retest" (30 min), and the trade is given on the retest, else "no retest, not given".
- **REJECT:** no entry from 14:00 (not robust); wider stop (NIFTY worse); sweep entry (worse over 2 years).
- **Status:** not yet proven profitable. Paper or minimum size until forward results confirm.

## 2026-10-18 · Expiry-day study (`protrader/RESULTS_EXPIRY.md`)

**Requested by the owner:** do not simply skip the expiry day.

**What was tested:**
- 6 strategy families.
- A 24-version grid: chosen on development, judged on validation.

**Result:** no profitable expiry-day buyer strategy is validated.
- The pre-chosen pick failed validation (overfit).
- Expiry management roughly halves to quarters the loss, and lifts the win rate from 23% to 43–48%, compared with today's
  logic on expiry day.

**Verdict:**
- Live: expiry-day skip stays.
- Proposed to the owner: a labelled paper / minimum-size forward test of the EMA20-pullback ITM method.

## 2026-10-18 · Owner's decision: EXPIRY MODE as a paper / minimum-size forward test

The owner does not want expiry day skipped. Given the expiry study, the owner chose **"Expiry mode, paper / min size"**.

**Live rules** (`backend/premium/expiryMode.ts`):
- **When:** the index's own expiry day only. Entries 10:30–13:30, max 2, one at a time.
- **Entry:** EMA20 pullback with the day's trend, on a closed 5-min candle.
- **Strike:** one strike in the money.
- **Exits, on the premium:** −40% stop · half at 1.5× · then stop at the entry premium · rest at 2.5× · 40-min time
  stop · out by 15:15.
- **Label:** "EXPIRY MODE · PAPER / MIN SIZE", scored separately in the closing statement as "expiry-mode (paper)".
- **Normal plan triggers on expiry day** stay "shown, not given".

**Status:** NOT validated as profitable. Promote to normal size only if 6–8 forward expiries are positive after costs.

## 2026-10-18 · Owner's idea: "direction first, enter on the liquidity sweep" (`protrader/RESULTS_STRUCTURE.md`)

**Tested:** 7 versions plus a direction filter on the live logic.

**Verdict: REJECT, all versions.** None beats the live logic in development and validation for both indices. NIFTY stop
rate is 67% with candle stops; wider structural stops leave too few trades; the direction filter is worse per trade in 3
of 4 cells.

**Live logic unchanged:** plan trigger + retest entry, expiry-day plan trades not given (expiry mode is paper).

## 2026-10-18 · ProTrader daily routine set up (owner's request)

- **15:30 daily review** with the closing statement:
  - stop-loss reasons from the recorded facts (late entry, range day, review grade and failed checks, premium lost)
  - triggers shown but not given (no retest, range day, expiry day, review C, conflict)
  - the forward scoreboard, live and expiry mode (`data/protrader-forward.json`)
  - a BTSD reminder
- **15:50** silent data refresh (`refreshData.ts`).
- **Friday 16:05** weekly re-check (`weekly.ts`). The first dry run, data to 16 Oct:
  - NIFTY: 2-year −0.8% per trade; last 20 sessions +1.9%.
  - SENSEX: 2-year −2.8%; last 20 sessions −0.1%.
  - Both "in line with the long run".

## 2026-10-24 · Phase-2 proposals from the 19–23 Oct audit — backtest #3 (`protrader/RESULTS3.md`)

**Tested** (pre-registered, one change at a time vs the live co-pilot, real Dhan premiums 2024-10-01 → 2026-10-23,
NIFTY + SENSEX, development / validation): wider stop, hard touch stop, no chasing, premium targets, time filter,
fast-market skip, and no-chasing + fast-market together.

**Verdict:**
- **APPROVE P2 + P5 together:** at the retest, no trade if the premium is 10%+ above its price at the trigger close, or if
  the last 4 closed 15-min candles of the day average ≥ 1.5 × ATR15. Better in all four cells, fewer stop losses, lower
  drawdown. Implemented in `copilot.ts` (`chased`, `fastMarket`) + the co-pilot retest step; recorded as "not given"
  (LATE ENTRY / FAST MARKET) with a Telegram note.
- **REJECT** wider stop, hard touch stop, premium targets (half at +50%), time filter.

**Still not proven profitable** — paper / minimum size.

## 2026-10-24 · FAKE-DOWN / FAKE-UP label accuracy — owner asked for ~90 % on 5-min or 15-min (`protrader/RESULTS_FAKE_MOVE.md`)

**Tested:**
- the live detector on 2 years of NIFTY + SENSEX data, 5-min and 15-min candles, development / validation
- variants: follow-through, hold 2 bars, day-average side, higher-TF structure, their combinations, and a target sweep
- each against a same-stop baseline

**Verdict:**
- **NO EDGE.** Validation right % is about 54–65% on 5-min and 39–58% on 15-min, always within about ±3 points of the
  same-stop baseline; avg R ≈ 0 or negative.
- **90% is not reachable honestly:** a 0.25-ATR target gives about 80% right with negative avg R.
- **No change to live logic.** Keep the label as information only. Next: premium confirmation, and OI at the level once
  the 1-min OI log has 60+ sessions.

## 2026-10-24 · Candle-level breakdown / breakup for the fake-move label (`RESULTS_FAKE_MOVE.md` §3)

**Tested:** previous candle H/L, higher-TF candle H/L and day high/low as levels, on 5m and 15m, both as fake (reclaim)
and as break (two closes beyond).

**Verdict:**
- **NO IMPROVEMENT.** Fake is equal to or below the live levels. Break is within about ±3 points of the same-stop
  baseline; the few validation gains are absent in development.
- **No change to live logic.**
- **Side-by-spot quirk noted:** accepted breaks are almost never reported, and the "Swing High" wording is wrong. This
  is a display fix only.

## 2026-10-24 · Candle fake at support / resistance (`RESULTS_FAKE_MOVE.md` §4)

**Tested:** previous-candle fake-down / up counted only near a live S/R level or an owner S/R level (0.3 / 0.15 ATR),
or together with the live-level fake, on 5m and 15m, NIFTY + SENSEX, development / validation.

**Verdict:**
- **NO IMPROVEMENT.** The best development cell, SENSEX 5m at both S/R types (68.5% vs 57.1%), falls to 34.0% vs 53.6%
  in validation.
- NIFTY 15m fake-up at owner S/R is +2 / +5 points on n ≈ 70, and SENSEX does not confirm it. Watch only.
- **No change to live logic.**
