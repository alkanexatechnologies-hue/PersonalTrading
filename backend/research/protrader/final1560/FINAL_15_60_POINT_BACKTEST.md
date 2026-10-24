# FINAL 15–60 point backtest: LAX vs C2, EMA, ORB and random

**How to reproduce:**
- `npx tsx backend/research/protrader/final1560/backtest.ts` regenerates all tables in `FINAL_15_60_POINT_BACKTEST_raw.md`
  and the trade-level audits `lax_trades.csv` and `comparison_trades.csv`.
- Unit tests: `npx tsx --test backend/research/protrader/final1560/strategy.test.ts` (9 / 9 pass).
- Data audit: `dataAudit.ts` → `DATA_AUDIT_raw.txt`.
- The strategy and acceptance criteria were committed before this run (commit `789102f`).

## Data and set-up

**Data:**
- Real Dhan 1-min NIFTY, BANKNIFTY and SENSEX, 2024-10-14 → 2026-10-23, 501 sessions each.
- The ATM CE and PE were present at 100% of the 09:30–14:30 five-minute closes.
- BANKNIFTY data was missing after 12 Oct. It was downloaded for this test; the daily refresh covers only NIFTY and SENSEX.

**Periods:**
- DEV = the first 60% (to 2026-01-07) · VAL = the next 20% · TEST = the last 20%. One session is purged at each boundary.
- **Primary out-of-sample (OOS) = VAL + TEST, excluding DEV15** (1–23 Oct 2026, where the ideas were developed).

**Engine check:** the re-implemented C2 reproduces Phase 1 **exactly** (121 trades, 48 / 60 / 13, +₹362 per trade).

**Index points are reported literally.** 15 points is a much smaller move for BANKNIFTY / SENSEX (about 0.3 ATR) than for
NIFTY (about 0.7 ATR). That is why NIFTY's reach rates are lower.

**Option figures:**
- ATM option, ₹ per lot (NIFTY 75, BANKNIFTY 30, SENSEX 20).
- Base costs: slippage + ₹40 brokerage + statutory charges.
- Conservative: + 0.5% slippage per side and a 1-minute execution delay.
- "Reach +X" = the index moved X points in the trade's favour **before** the stop or thesis invalidation.

## Concise comparison: primary OOS (identical sessions and cost model)

| Strategy | Trades | Reach +15 / +30 / +45 / +60 % | Median MFE / MAE (pts) | Win % (net > 0) | Net per trade ₹ [95% CI] | Conservative per trade ₹ [95% CI] | PF (cons) | Max DD (cons) ₹ |
|---|---|---|---|---|---|---|---|---|
| **LAX (candidate)** | 323 | 61 / 46 / 41 / 35 | 21.4 / 15.2 | 36.8 | **−143** [−248, −52] | **−226** [−322, −142] | 0.50 | 73,999 |
| C2 (LAX exit) | 2,276 | 66 / 55 / 47 / 40 | 24.3 / 14.6 | 38.7 | −106 [−159, −58] | −209 [−268, −146] | 0.58 | 4,87,667 |
| C2 (its own E1 exit, Phase-1 costs) | 2,276 | — | — | — | **−146** | — | — | — |
| EMA baseline (NIFTY + SENSEX) | 816 | 58 / 48 / 39 / 33 | 21.0 / 9.9 | 33.1 | −92 [−147, −29] | −179 [−236, −116] | 0.61 | 1,48,698 |
| Simple ORB benchmark | 623 | 62 / 50 / 41 / 34 | 22.5 / 14.2 | 36.3 | −167 [−270, −83] | −313 [−417, −235] | 0.41 | 1,97,735 |
| Random entry benchmark | 26,496 | 52 / 39 / 31 / 25 | 16.4 / 11.8 | 33.2 | −146 [−160, −135] | −276 [−294, −259] | 0.38 | — |

**DEV15** (the development window itself; in-sample):

| Strategy | Trades | Net per trade ₹ |
|---|---|---|
| LAX | 27 | **−357** (+15 reached 44%) |
| C2 with the LAX exit | 190 | +6 |
| C2 with its own E1 exit | 190 | +262 |

**Every period, LAX** (net per trade, conservative in brackets):

| Period | Trades | Net per trade ₹ |
|---|---|---|
| DEV | 501 | −95 (−205) |
| VAL | 179 | −128 (−224) |
| TEST excl. DEV15 | 144 | −161 (−228) |

**Half-year blocks:** all 5 negative at conservative costs.

## LAX splits (primary OOS)

**By index:**

| Index | Trades | Reach +15 % | Win % | Net per trade ₹ | Conservative ₹ |
|---|---|---|---|---|---|
| BANKNIFTY | 114 | 68 | 42.1 | −108 | −269 |
| NIFTY | 105 | 50 | 27.6 | −233 | −221 |
| SENSEX | 104 | 66 | 40.4 | −90 | −183 |

**By side, net per trade:**

| Index | CE | PE |
|---|---|---|
| BANKNIFTY | −₹93 | −₹125 |
| NIFTY | −₹163 | −₹316 |
| SENSEX | −₹27 | −₹154 |

**By level, net per trade:** ORH −₹143 · ORL −₹195 · PDC −₹52 · PDH −₹135 · PDL −₹17.

**By entry time, net per trade (conservative):**

| Entry time | Trades | Net per trade ₹ |
|---|---|---|
| 09:35–10:00 | 167 | −207 (−264) |
| 10:00–10:30 | 79 | −146 |
| 10:30–11:00 | 40 | −56 |
| 11:00–11:35 | 37 | +61 (−226) |

**Hindsight day labels (reporting only):**

| Day type | Net per trade (conservative) ₹ |
|---|---|
| Trend day | −97 (−217) |
| Range day | −170 (−231) |
| High-volatility day | −34 (−137) |
| Low-volatility day | −222 (−290) |

**Expiry day:** +₹66 (conservative +₹92) on 46 trades, CI [−176, +382] → not significant. Other days: −₹177.

**WAIT / NO-TRADE decisions (all periods, three indices):**

| Reason | Count |
|---|---|
| Not accepted (next candle closed back) | 1,552 |
| Stale (> 1 ATR consumed) | 1,665 |
| No room | 460 |
| Chop (level already crossed) | 248 |
| Risk > 1.5 ATR | 177 |
| Portfolio blocks (open trade / cooldown / 2 trades a day) | 71 |
| **Signals traded** | **922** |

DEV15 has every trade and every rejected setup, with its reason, in the raw file.

## Pre-registered acceptance criteria (primary OOS)

| Criterion | Result | Pass |
|---|---|---|
| A1 conservative net per trade > 0 and 95% lower bound > 0 | −₹226 [−322, −142] | **FAIL** |
| A2 +15 reach ≥ 60% and ≥ random + 10 points (CI excludes 0) | 61.3% vs random 52.4%; difference +8.9 points, CI [5.2, 13.7] | **FAIL** (above random, but not by 10 points) |
| A3 profit factor (conservative) ≥ 1.2 | 0.50 | **FAIL** |
| A4 max DD ≤ 10 × average loss | ₹73,999 vs ₹6,573 | **FAIL** |
| A5 positive in ≥ 2 of 3 indices and ≥ 60% of half-years | 0 / 3 indices; 0 / 5 half-years | **FAIL** |
| A6 ≥ 100 OOS trades | 323 | PASS |

**Result: 1 of 6. The candidate is rejected.**

## Where the money is lost (diagnostic, not a new rule)

Regressing the option result on the index move, over the 323 OOS LAX trades:
- **Option gross ≈ 0.51 × (index points × lot) − ₹23.** The ATM option moves about half as much as the index, plus a small
  time-decay drag.
- **Costs average ₹143 per trade:** NIFTY ₹134, BANKNIFTY ₹195, SENSEX ₹95.
- **Average index points captured per trade: only +2.3.** NIFTY −1.3, BANKNIFTY +6.7, SENSEX +1.1.

**Break-even capture needed** = (costs + drag) ÷ (0.51 × lot):
- NIFTY ≈ 4.7 points per trade;
- BANKNIFTY ≈ 13.8;
- SENSEX ≈ 9.8.

**The signals do carry a directional bias.** +15 reach is 61% (LAX) and 66% (C2) vs 52% for random entries, and the
difference is significant. But the average captured move is far below the break-even.
