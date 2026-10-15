# Root breakout (base → expansion) — pre-registration

Written and committed **before** any result. Research only; output = statistics the live co-pilot may quote.

## Idea (how experienced buyers enter at the root)
Price compresses into a tight base (volatility contraction); the move is born when a candle closes out of the base.
Enter on that first close, stop just beyond the other side of the base (small risk), and take it only when there is
room to the next hurdle.

## Data
NIFTY 2024-10-14 → 2026-10-12, 1-minute spot + ATM CE/PE premiums (cached Dhan rolling data). No Dhan calls.

## Definitions (5-minute bars, decisions on closed bars only)
- ATR = ATR14 of 15-min bars up to the previous session's close.
- **Base**: the last K closed 5-min bars whose highest high − lowest low ≤ c·ATR.
- **Root breakout (bull)**: the next 5-min bar closes above base high + 0.1·ATR; bear mirror below base low.
  One signal per base; at most 2 signals per side per day; 09:30–14:30 closes; no new signal while in a trade.
- **Hurdles**: previous-day H/L/C, pivots R1/R2/S1/S2, previous-week H/L, round 100s. **Room** = distance from the
  signal close to the next hurdle in the trade direction; required ≥ 1·ATR (else the signal is skipped).
- **Trend filter (variant)**: 15-min EMA21 rising for bull / falling for bear (closed 15-min bars).

## Trade
Entry: next 1-min premium OPEN, ATM strike (nearest 50), CE for bull, PE for bear.
Initial stop: 1-min index close beyond the far side of the base (−0.05·ATR). Exits (variant):
- **TGT**: next hurdle touched → that minute's close; 60-min time stop; 15:15.
- **TRAIL**: after +0.5·ATR in favour, stop trails to the low (bull) / high (bear) of the previous closed 5-min bar;
  no fixed target; 15:15.
Costs: charges + 1 point slippage per side, 1 lot.

## Variant budget (all reported)
K ∈ {6, 12} × c ∈ {0.6, 1.0} × trend ∈ {none, with} × exit ∈ {TGT, TRAIL} = 16 variants.

## Periods and decision rule
DEV 2024-10-14 → 2025-10-31 (choose the best variant by net expectancy, ≥ 60 trades) · VALIDATION 2025-11-01 →
2026-05-31 (one look) · HOLDOUT 2026-06-01 → 2026-10-12 (opened only if the chosen variant is positive in DEV and
VALIDATION). A variant is **usable** only if net expectancy > 0 with a day-bootstrap 95 % lower bound > 0 in VALIDATION
and HOLDOUT. Otherwise: NO VALIDATED EDGE, and the live screen shows the root pattern as context only.
