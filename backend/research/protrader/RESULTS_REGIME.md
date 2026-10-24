# Market Regime Detector: research validation (2026-10-25)

**Code (research only, not used by the live app):**
- `backend/research/regime/marketRegime.ts` (11 unit tests)
- `backend/research/protrader/regimeStudy.ts`
- Full output: `RESULTS_REGIME_raw.txt`

**Features:**
- ER10 (15m), ADX14 / ±DI (15m), EMA21 slope / ATR (15m)
- VWAP crosses over the last 12 completed 5m candles (TWAP proxy; the index has no volume)
- ATR compression + 8-candle range width
- ATM CE / PE premium agreement

**Labels:** CHOPPY / TRENDING_UP / TRENDING_DOWN / COMPRESSION / TRANSITION / UNKNOWN_DATA. Thresholds are the proposed
research defaults (configurable, **unvalidated**).

**Data and setup:**
- **Data:** NIFTY + SENSEX, 2024-10-01 → 2026-10-23.
- **Evaluation points:** 19,400 (every completed 15m close, 09:45–14:30).
- **Periods:** DEV 60% / VAL 20% / TEST 20%, one session purged at each boundary.
- **Forward truth over the next 60 min:** TREND if ER ≥ 0.4 and the move is ≥ 1 ATR15; CHOP if ER < 0.25.
- **Base rates:** trend up about 12%, trend down about 13%, chop about 50%.

## Classification quality

| | DEV | VAL | TEST |
|---|---|---|---|
| TRENDING call right (same-direction trend in the next hour) | 13.2% | 11.6% | 12.8% |
| Baseline (EMA21) trend call right | 13.4% | 13.4% | 12.6% |
| Opposite trend after a TRENDING call | 10.8% | 10.3% | 12.1% |
| Missed trends (detector / baseline) | 87.7% / 49.7% | 87.9% / 53.7% | 86.8% / 54.4% |
| CHOPPY call followed by chop (base about 50%) | 51.2% | 45.4% | 47.2% |
| Backward trend episodes detected (detector / baseline) | 40.7% / 84.4% | 40.4% / 81.2% | 39.0% / 80.8% |
| Mean regime duration (15m candles) | 3.1 | 3.2 | 3.2 |
| Label shares, TRANSITION / CHOPPY / UP / DOWN / COMPRESSION | 57 / 14 / 12 / 11 / 6% | 56 / 10 / 10 / 18 / 6% | 57 / 12 / 12 / 15 / 5% |

- **Trend and chop calls do not beat the base rates or the simple baseline** in any period. The detector is more
  conservative: it detects about 40% of trend episodes vs the baseline's about 81%.
- **Ablations:** removing ER, ADX, slope, VWAP crosses, compression or premium each changes trend-call precision by
  about 1 point or less, with no consistent sign. **No feature adds measurable predictive value.**
- **By index, time of day and expiry day:** trend calls are right 12–15% everywhere, equal to the base rate.
- **When a backward trend episode is detected, it is detected at once** (median delay 0 candles), because the same past
  data defines both.

## Applied to the PT signals (premium EMA 9 × EMA 21 trigger)

| Win % at 1:1 (n) | Last 15 sessions | DEV | VAL | TEST |
|---|---|---|---|---|
| NIFTY, all PT | 60.5% (38) | 46.8% (626) | 49.8% (211) | 52.7% (205) |
| NIFTY, GATE (CE in UP / PE in DOWN only) | 66.7% (6) | **63.3% (49)** | 45.5% (22) | 46.7% (15) |
| SENSEX, all PT | 63.6% (44) | 50.4% (633) | 54.4% (228) | 60.3% (224) |
| SENSEX, GATE | 71.4% (7) | 58.3% (48) | 46.7% (30) | 61.9% (21) |
| Removing CHOPPY only, NIFTY / SENSEX | 60.0% / 65.9% | 47.0% / 50.8% | 49.5% / 54.6% | 52.0% / 61.7% |

- **Last 15 sessions:**
  - The gate kept 6 of 38 NIFTY and 7 of 44 SENSEX signals and won 67% / 71%, but it also turned most winners into
    WAIT.
  - SENSEX 22 Oct: the gate would have stopped all 4 losers (labelled UNKNOWN, CHOPPY, TRANSITION, TRANSITION).
- **2 years:** the gate looked strong in DEV (NIFTY 63% vs 47%) but **reversed in VAL** (46% vs 50% NIFTY, 47% vs 54%
  SENSEX) and was mixed in TEST. Removing CHOPPY alone changes nothing.

## Verdict (ProTrader)

- **Not validated.** With the proposed thresholds the regime labels do not predict the next hour better than base
  rates or the EMA21 baseline, and gating PT by regime does not hold beyond DEV.
- **Keep it research-only:** no live use and no WAIT override from it.
- **Next options:**
  - tune thresholds on DEV only, then re-check VAL / TEST;
  - a longer truth horizon (rest of the session);
  - use the regime as a display label rather than a gate.
