# Zero-hero (expiry-day cheap OTM) — pre-registration

Written and committed **before** any result. Research only; output = statistics the live Zero-Hero panel shows.

## Data
1-minute spot + ATM−3…ATM+3 CE/PE premiums of the **expiring** weekly contract (Dhan rolling, nearest expiry):
NIFTY (cached) and SENSEX (being downloaded), 2024-10-14 → 2026-10-12.

## Expiry days
NIFTY: the NSE bhavcopy expiry calendar. SENSEX (no calendar cached): a day is an expiry day when the ATM CE+PE time value
at 15:20 is < 0.08 % of spot (expiring options are nearly pure intrinsic by then). The same test is checked against the
NIFTY calendar and its agreement is reported.

## Signal (expiry days only, closed 5-min bars, 13:30–14:45)
- **A (range expansion)**: a 5-min bar closes above the day's high so far (bull → CE) / below the day's low (bear → PE).
  First signal per side per day.
- **B (A + writers covering)**: A, and the OI of that side's 2-OTM strike (calls for CE / puts for PE) fell over the
  previous 15 minutes.
Strike = 2 strike-steps OTM from the ATM at the signal (NIFTY +/−100, SENSEX +/−200).

## Trade
Entry: next 1-minute premium OPEN. Exits (variants):
- **HOLD**: hold to 15:20.
- **SCALE**: sell half at 3× entry, the rest at 15:20.
- **STOP50**: exit if the premium falls to 50 % of entry (next minute open), else 15:20.
If the strike drops out of the ATM±3 data before exit, its value is taken as **intrinsic** at that minute (pessimistic for
losers; an OTM strike that far away is close to zero on expiry afternoon). Costs: charges + 0.5 point slippage per side.

## Variants, periods, decision
A/B × HOLD/SCALE/STOP50 = 6 per index. DEV 2024-10-14 → 2025-10-31 · VALIDATION 2025-11-01 → 2026-05-31 · HOLDOUT
2026-06-01 → 2026-10-12. Per index the DEV-best variant (≥ 20 trades) goes to VALIDATION; HOLDOUT is opened only if
it is positive in DEV and VALIDATION. Usable only if positive in HOLDOUT too. Reported: trades, hit rate (≥ 2× entry),
average and total net premium points, best and worst trade, longest losing streak.
