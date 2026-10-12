# NIFTY 20-point option research — pre-registration

Written and committed **before** any strategy-family result was computed on the clean 1-minute dataset.
The earlier ORB/EMA baseline (`backend/backtest/twentyPoints.ts`) was run on all dates using contaminated 5-minute
rolling candles; it is kept only as a record and is re-run on clean data as family "BASE".

## Data
- Dhan `/charts/rollingoption`, 1-minute, NIFTY nearest weekly expiry, ATM−3…ATM+3, CE and PE, with OI, IV, volume, spot.
- Period: 2024-10-14 → 2026-10-12. Per-strike series assembled from 1-minute bars only (5-minute rolling bars mix strikes).
- Expiry and lot per contract from NSE F&O bhavcopy samples. Charges: paper-engine rates (+ SEBI fee), 1 lot.

## Periods (chronological, fixed now)
| Period | Dates | Use |
|---|---|---|
| DEV | 2024-10-14 → 2025-10-31 | design, parameter choice, ablations |
| VALIDATION | 2025-11-01 → 2026-05-31 | one look per candidate; no re-tuning after looking |
| HOLDOUT | 2026-06-01 → 2026-10-12 | final, opened once, only for candidates that pass VALIDATION |

Note: the contaminated 5-minute baseline already touched all periods. It is not a candidate and no parameter was taken from it.

## Fixed trade definition
- Entry: the next 1-minute bar's OPEN after the signal minute closes, plus slippage. Signals use completed bars only.
- Target: entry premium + 20 points (premium points, not index points). Stop: fixed before entry, from {10, 15, 20}.
- Time exit: {15, 30, 60} minutes; hard exit 15:20. Within one minute that touches both target and stop: STOP.
- A strike that leaves the ATM±3 data: exit at the next available minute's open (flagged DATA_GAP).
- NO_TRADE is a valid outcome. Max 2 trades per day; stop for the day after a target hit.

## Variant budget
At most 6 families × 3 stops × 3 time exits = 54 variants evaluated on DEV. At most 5 candidates go to VALIDATION.
Every variant tried is listed in the report, with its DEV result, whether or not it looks good.

## Promotion criteria (all must hold; not relaxed later)
1. VALIDATION and HOLDOUT each: ≥ 40 trades, net expectancy > 0 after charges at 1 point slippage per side.
2. VALIDATION + HOLDOUT combined: bootstrap 90 % lower bound of net expectancy per trade > 0; profit factor ≥ 1.2.
3. Max drawdown (net points, 1 lot) ≤ 120 points over VALIDATION + HOLDOUT.
4. Still net-positive at 2 points slippage per side.
5. No single day contributes more than 20 % of total net points.
6. DEV result also positive (not a period-specific accident).

If no candidate meets all six: verdict **NO_VALIDATED_EDGE** — nothing is enabled for live or paper trading.
A 95 % win rate is not a criterion and no parameter is chosen to raise the win rate.
