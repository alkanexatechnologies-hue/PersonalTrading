# Trend-day detector — pre-registration

Written and committed **before** any result. Research only.

## Question
Can a trend day be recognised early (10:00 / 10:15) from information available then, such that buying the ATM option
in the day's direction and holding it pays after costs? And do breakout trades lose less on days the detector calls?

## Data
NIFTY 2024-10-14 → 2026-10-12: 1-minute spot, 1-minute ATM±3 CE/PE premiums with OI (cached Dhan rolling data).
BANKNIFTY alignment is not available yet (history not downloaded) — left out of this version.

## Features at decision time T (all from data before T)
Day direction D = sign(price(T) − previous close).
- **F1 gap held**: |open/prev close − 1| ≥ 0.15 % and the gap is in direction D.
- **F2 opening-range break**: price(T) beyond the 09:15–09:30 high (D>0) / low (D<0).
- **F3 above/below TWAP**: price(T) on the D side of the time-weighted average price since 09:15 (index has no
  volume, so TWAP replaces VWAP).
- **F4 writers covering**: over strikes within ±150 pts of price(T), D·(Δput OI − Δcall OI) from 09:20 to T > 0.
Score = F1 + F2 + F3 + F4 (0–4).

## Trade (variants)
If score ≥ s: buy the ATM option in direction D at the next 1-minute premium OPEN after T. Initial stop: 1-minute index
close 1·ATR (ATR14 of 15-min bars to the previous close) against the entry. Exit variants:
- **HOLD**: hold to 15:00 (or the stop).
- **TRAIL**: after +0.5·ATR, the stop trails to the previous closed 15-min bar's low (D>0) / high (D<0); exit by 15:15.
Costs: charges + 1 point slippage per side, 1 lot. One trade per day.

Variants: s ∈ {3, 4} × T ∈ {10:00, 10:15} × exit ∈ {HOLD, TRAIL} = 8.

## Stay-out check (report only, no tuning)
The 15-min (T15) and 5-min (E5) breakout trades from the early-breakout study, split by whether their side agrees with D
and the 10:00 score is ≥ 3. Shows whether "trade only on detector days" reduces losses.

## Periods and decision rule
DEV 2024-10-14 → 2025-10-31 (choose the best variant with ≥ 40 trades) · VALIDATION 2025-11-01 → 2026-05-31 ·
HOLDOUT 2026-06-01 → 2026-10-12 opened only if the chosen variant is positive in DEV and VALIDATION. Usable only if
the day-bootstrap 95 % lower bound of net expectancy > 0 in VALIDATION and HOLDOUT. Otherwise NO VALIDATED EDGE.

## Confirmatory test C1 (written after the first run, BEFORE looking at it — the first stay-out split had look-ahead)
The first stay-out split applied the 10:00 score to breakouts that fired before 10:00 (information not yet known).
C1 removes that: only breakout signals whose candle closes **at or after 10:00** count, and the detector is the 10:00
score (data before 10:00). Rule: take the **E5** (5-min close) breakout only if score ≥ 3 and its side equals D.
Fixed now, no other choice made: E5 (not T15), score ≥ 3, 10:00. C1 passes only if net expectancy > 0 in DEV and
VALIDATION, and then HOLDOUT is opened once; usable only if the HOLDOUT day-bootstrap 95 % lower bound > 0.
