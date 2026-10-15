# Early breakout signals — pre-registration

Written and committed **before** any result was computed. Research only. Its output is a statistics file the live
co-pilot quotes next to a setup ("2-year history: n, followed-through %, net premium"); it never trades or changes a gate.

## Question
Can an option buyer enter **earlier** than the 15-min closed-candle trigger of the Premium Prediction plan, without
losing more to false signals than is gained by the better price? And is a **support bounce / resistance rejection**
entry better than the breakout itself?

## Data
NIFTY, 2024-10-14 → 2026-10-12: Dhan 1-minute spot and 1-minute ATM±3 CE/PE premiums (nearest weekly expiry), already
cached in `data/research-nifty20/raw1m`. No Dhan calls. Other indices: same study after their history is downloaded.

## Session plan (no look-ahead, same as the live screen)
Levels from data before the session: previous-day high/low/close, classic pivots R1/R2/S1/S2, previous-week high/low.
(OI walls and trendlines are not available historically and are left out.) ATR = ATR14 of 15-min bars up to the
previous close. Bull and Bear plans = `plans()` from `backend/premium/traderView.ts`, unchanged, anchored to the
previous close: entry (start), stop, T1.

## Signals (first per side per day, 09:30–14:30)
- **T15** (baseline, today's live rule): first 15-min close beyond the start.
- **E5**: first 5-min close beyond the start.
- **E5P**: E5 and the side's ATM premium made a new session high within the last 5 minutes (premium confirms).
- **BNC** (bounce/rejection): a 5-min bar tests the opposite plan's trigger level (within 0.15·ATR) and closes
  ≥ 0.2·ATR back away from it (support → CE, resistance → PE).

## Trade (identical exits for all)
Entry: OPEN of the next 1-minute premium bar after the signal bar closes; ATM strike (nearest 50) of that moment, side
CE for bull, PE for bear. Exit at the first of: index touches T1 (bounce: the level ±1·ATR) → that minute's close ·
1-minute index close beyond the stop (breakouts: plan stop; bounce: level ∓ 0.3·ATR) → next minute's open · 60 minutes
· 15:15. Missing premium minute → last available (flagged). Costs: the 20-point study's charges + 1 point slippage
per side, 1 lot.

## Periods
DEV 2024-10-14 → 2025-10-31 · VALIDATION 2025-11-01 → 2026-05-31 · HOLDOUT 2026-06-01 → 2026-10-12 (opened once).

## Reported
Per signal: trades, win %, avg and total net premium points per lot, profit factor, max drawdown, median minutes
earlier than T15 (same day and side), and "false early" = E5 trades on days T15 never triggered.

## Decision rule (fixed now)
An early signal is **preferred** only if its net expectancy beats T15 in DEV **and** VALIDATION **and** HOLDOUT and is
positive in all three. Otherwise the live screen keeps T15 as the trigger and shows the early signal only as
information with its measured statistics. Every statistic quoted live states n and the period.

## Amendment 1 (after the first DEV+VALIDATION run — recorded openly)
The first run let a signal enter even when the signal candle had already closed **beyond Target 1** (66 of 125 T15
"target" exits happened in minute 0 with ~0 gain minus costs). The live screen never triggers there — its radar shows
MISSED ("do not chase"). The simulation now applies the same rule: a signal whose close is already at/beyond T1 is
skipped (counted as MISSED). Nothing else changed. HOLDOUT is still unopened.
