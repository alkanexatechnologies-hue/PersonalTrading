# Premium Prediction Center — probability validation (step 3) — pre-registration

Written and committed **before** any result was computed. Research only. Its sole output is a JSON file the Premium
Prediction Center may read to show a probability **only** where it passed; nothing here trades or changes a gate.

## Question
When the Premium Prediction Center shows a breakout/breakdown state on the NIFTY 5-minute chart, how often does the
ATM CE / ATM PE premium actually **rise** over the next 5, 15 and 30 minutes, and is that rate stable enough out of
sample to be displayed as a probability?

## Data
- Dhan `/charts/rollingoption`, 1-minute, NIFTY nearest weekly expiry, ATM−3…ATM+3, CE and PE (already cached,
  `data/research-nifty20/raw1m`, 2024-10-14 → 2026-10-12), assembled per strike from 1-minute bars only.
- Spot: the same files' 1-minute spot. 5-minute candles are built from it (time = bar start, like Dhan's).

## Decision points (no look-ahead)
- Every closed 5-minute bar whose close time is 09:20 … 15:00 IST (so the 30-minute horizon ends by 15:30).
- Levels: the existing breakout engine (`runSession`, unchanged) run for that day on the previous 4 sessions + the day,
  closed bars only. `levels[i]` = the engine's resistance/support from bar i−1, exactly as the live route builds them.
- State: `breakStates` from `backend/premium/premiumCenter.ts` (unchanged), buffer = engine `breakBufferAtr` × ATR14.
- Contract: ATM strike = 50-point strike nearest the bar's close; nearest weekly expiry (what the rolling series holds).
- Entry premium = OPEN of the first 1-minute premium bar starting at the decision time (bar close).
  Exit premium at horizon h = OPEN of the 1-minute bar starting h minutes later. Missing minute → sample skipped
  (counted). No intrabar (forming) states are tested — only closed-bar states.

## Outcome
- RISE = exit − entry > 0. Also recorded: signed change and absolute change (premium points and %).
- Not a trade test (no costs) — this measures the probability the screen would display. Trading P&L was already
  tested in the 20-point study (no edge after costs).

## Groups
For each side (CE, PE) × horizon (5, 15, 30) × index state (bull: NONE, PRE_BREAKOUT, CONFIRMED_BREAKOUT,
RETEST_HOLD, FAILED_BREAKOUT; bear: NONE, PRE_BREAKDOWN, CONFIRMED_BREAKDOWN, RETEST_FAILURE, FAILED_BREAKDOWN).
Baseline = the unconditional rise rate of that side × horizon over all decision points.

## Periods (same as the earlier studies)
DEV 2024-10-14 → 2025-10-31 · VALIDATION 2025-11-01 → 2026-05-31 · HOLDOUT 2026-06-01 → 2026-10-12 (opened once).

## Statistics
- Rise rate with 95 % interval from a day-block bootstrap (consecutive bars on one day are not independent).
- Brier score on HOLDOUT of the DEV rate vs the baseline rate (lower = better).

## Display rule (fixed now)
A group's probability may be displayed only if ALL hold:
1. n ≥ 100 decision points in DEV, ≥ 50 in VALIDATION and ≥ 30 in HOLDOUT, from ≥ 10 different days in each;
2. the DEV rate differs from the baseline by ≥ 5 points AND the day-bootstrap 95 % interval of (group − baseline) in
   DEV excludes 0;
3. VALIDATION and HOLDOUT rates are each within 8 points of the DEV rate and on the same side of the baseline;
4. HOLDOUT Brier score with the DEV rate is lower than with the baseline rate.
The displayed number is the rate over DEV + VALIDATION + HOLDOUT, shown with its sample size, interval, test period
and date. Every other group stays **PROBABILITY NOT VALIDATED** (or NO EDGE when the rate is indistinguishable from
the baseline). Only the 5-minute chart and NIFTY are covered; other indices / 15-minute stay NOT VALIDATED.
