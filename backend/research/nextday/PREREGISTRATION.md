# Next-day NIFTY direction from CE/PE premium support & resistance — pre-registration

Written and committed **before** any feature, model or outcome was computed. Research only: nothing here is read by
signals, the arbiter, the Master Trade Selector, risk gates or paper/live trading.

## Question
Do CE/PE premium support/resistance levels at day D's close predict NIFTY's direction on D+1 **better than spot alone**?

## Data (official, no Dhan load)
- NSE F&O bhavcopy, every trading day: NIFTY index options (all strikes, all expiries) — daily OHLC, close, settle,
  OI, change in OI, volume. Kept rows only, in `data/research-nextday/fo/`.
- NSE index close file, every trading day: Nifty 50 and India VIX daily OHLC, in `data/research-nextday/idx/`.
- Intraday order of moves on D+1 (outcome O2 only): Dhan 1-minute NIFTY spot already cached in
  `data/research-nifty20/raw1m` (2024-10-14 → 2026-10-12).
- Days with no NSE file (holidays) are skipped. No value is ever filled in or invented.

## Decision time and leakage rules
- The forecast is made after D's close using only files dated ≤ D. A feature function receives history sliced to ≤ D;
  a test checks that changing any D+1 value cannot change D's features.
- ATM = strike (50-point grid) nearest the Nifty 50 official close of D.
- Expiry = nearest NIFTY option expiry **strictly after D** (on an expiry day the expiring contract is ignored — its
  close is almost pure intrinsic value).
- Contracts = ATM−4 … ATM+4 (9 strikes) for CE and for PE, chosen from D's close only (no survivorship selection).
- IV: Black-Scholes implied volatility from the contract's close, spot = Nifty 50 close, rate 6.5 %, time to expiry
  from D 15:30 to expiry 15:30 (calendar days / 365).

## Features (each scaled to −1 … +1)
**A — spot (model A)**
- a1 close location: 2·(C−L)/(H−L) − 1.
- a2 5-day breakout: +1 if C > highest high of the previous 5 days; −1 if C < lowest low of the previous 5; else 0.
- a3 trend: +1 if C > SMA20 and SMA20 > SMA20 five days earlier; −1 if both opposite; else 0.
- A = (a1 + a2 + a3) / 3.

**B — premium support/resistance (model B)**, per contract with ≥ 3 traded (volume > 0) daily bars in the previous
5 sessions:
- Support S = lowest low, resistance R = highest high of those previous bars (D excluded).
- Breakout +1 if close_D > R, breakdown −1 if close_D < S, else 0. Position p = clip((close_D − S)/(R − S), 0, 1).
- Contract strength = (breakout + (2p − 1)) / 2. Side score = mean over the side's contracts.
- b1 = (CE side score − PE side score) / 2.
- b2 delta-adjusted residual: per contract r = (close_D − close_{D−1} − δ_{D−1}·(S_D − S_{D−1})) / close_{D−1}
  (δ from D−1's implied IV). b2 = clip((mean r_CE − mean r_PE) / 0.10, −1, 1). This is the part of the premium move
  that spot (via delta) does not explain; theta roughly cancels in the CE − PE difference.
- B = (b1 + b2) / 2.
- Also recorded for the card (not scored): fractal swing highs/lows (3-bar) of each contract over 10 sessions, touches
  within 3 % of R or S, premium % change, OI change, IV, data flags.

**OI / IV (model D adds)**
- d1 = clip(((ΣΔOI_PE − ΣΔOI_CE) / Σ(OI_PE + OI_CE)) / 0.05, −1, 1) over the 9+9 contracts (put writing = bullish).
- d2 = −clip(VIX % change on D / 10, −1, 1).
- Dx = (d1 + d2) / 2.

## Models and classes
| Model | Score |
|---|---|
| A spot only | A |
| B premium only | B |
| C spot + premium | (A + B) / 2 |
| D spot + premium + OI/IV | (A + B + Dx) / 3 |

With threshold k: score ≥ k → **BULLISH**; score ≤ −k → **BEARISH**; otherwise **NO_EDGE** if the components point
opposite ways (one ≥ k and another ≤ −k), else **NEUTRAL** (range expected).
**INSUFFICIENT_DATA**: < 25 days of index history, or (models B/C/D) fewer than 5 usable contracts on either side.

k is chosen on DEV only, from {0.10, 0.20, 0.30, 0.40}, maximising O1 hit rate among BULLISH/BEARISH calls subject to
calling at least 30 % of DEV days. It is then frozen for VALIDATION and HOLDOUT.

## Outcomes (D+1), defined now
- **O1 close-to-close**: up if C_{D+1} > C_D, down if lower; |change| < 1 point excluded.
- **O2 first touch**: which of C_D ± 0.5·ATR14_D is reached first on D+1 (a gap open beyond a level counts as that level
  first). Intraday order from Dhan 1-minute spot; if only one level is reached the daily bar decides; both reached and
  no 1-minute data → excluded (counted and reported).
- **O3 previous-day level**: BULLISH right if H_{D+1} > H_D; BEARISH right if L_{D+1} < L_D. Compared with the base rate.
- **O4 tradable**: index points in the called direction from D+1 open to D+1 close, minus 3 points round-trip cost;
  expectancy, total, max drawdown. (Spot-point proxy, not an option P&L.)
- **NEUTRAL** is right when |C_{D+1} − C_D| < 0.3·ATR14_D.

## Periods (same as the 20-point study)
| Period | Forecast dates D | Use |
|---|---|---|
| DEV | 2024-10-14 → 2025-10-31 | choose k; look at anything |
| VALIDATION | 2025-11-01 → 2026-05-31 | one look, no re-tuning |
| HOLDOUT | 2026-06-01 → 2026-10-13 | opened once, at the end |

Walk-forward (reported alongside): quarterly from 2025-11; for each quarter k is re-chosen on all earlier days only.

## Baselines
Always-UP; previous day's direction; existing `buildNextDayPick` (`backend/nextday/outlook.ts`, its bias); model A.

## Metrics
Hit rate with 95 % Wilson interval and binomial p vs 50 %; bullish/bearish precision and recall; confusion matrix;
balanced accuracy; % of days per class (incl. NO_EDGE); O2/O3/O4 as above. Splits: trend (C vs SMA50), next-day gap
(> ±0.5 %), days to expiry (≤ 1 vs more), VIX (< 14, 14–18, > 18). No probabilities are reported unless calibrated.

## Decision rule (fixed now)
Premium levels **add value** only if model B, C or D beats model A on O1 hit rate by ≥ 3 points in **both**
VALIDATION and HOLDOUT, and the paired bootstrap 95 % interval of the difference on VALIDATION + HOLDOUT excludes 0.
A model has a **usable edge** only if its HOLDOUT O1 Wilson lower bound is > 50 % and it beats always-UP and
previous-day direction. Otherwise the verdict is NO_VALIDATED_EDGE and premium levels are not added as a directional
input. No claim of 90–95 % accuracy will be made without such evidence.
