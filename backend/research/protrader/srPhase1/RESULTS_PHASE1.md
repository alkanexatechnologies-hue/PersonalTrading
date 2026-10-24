# Phase 1: logic development on the last 15 sessions (1–23 Oct 2026). PRELIMINARY, NOT VALIDATED

Script: `phase1.ts`. Full output with every trade: `RESULTS_PHASE1_raw.txt`. Research only.

## Data confirmed

- **Index:** 1-min CLOSE only, all 15 sessions. There is no 1-min OHLC, so 5m candles come from minute closes and the
  wicks are understated.
- **ATM ±3 option legs:** 1-min O/H/L/C, volume, OI (changes almost every minute) and IV. A strike is present only while
  inside the rolling ±3 band.
- **The app's ±10-strike OI log:** complete on only 12, 15, 16, 19, 21 and 23 Oct (partial on 8, 9, 13, 14, 22), so the
  OI tests use the ±3 legs.
- **Levels** are all known before the candle: PDH / PDL / PDC, opening range (from 09:30), owner S/R (turn clusters of
  the previous 5 sessions) and intraday 5m pivots (confirmed, formed ≥ 30 min before).

## Common exits

- **X1 (option):** ATM option, SL = max(₹5, 1 × premium ATR), target 2 × SL, 60 min, after costs. "Pess" fills stops
  at the minute's close.
- **X2 (index):** the setup's own stop, target 2R, 60 min.
- **Random baseline:** every 5m close, both directions.

## Results (both indices; each entry counted once)

| Setup | n | Option target / SL | Option net ₹ per trade (pess) | Index 2R hit · avg R |
|---|---|---|---|---|
| Random (every candle) | 3,600 | 25% / 62% | −4.05 (−5.31) | 37% · +0.16R |
| B0, current PT logic | 76 | 32% / 61% | −0.75 (−1.20) | 39% · +0.41R |
| H4, earlier entry (index + premium cross EMA 21 together) | 51 | 25% / 65% | −3.48 (−4.37) | 27% · +0.05R |
| H1, S/R rejection (all levels) | 142 | 27% / 54% | −0.82 (−1.68) | 40% · +0.24R |
| H1 + opposite writing at the level | 77 | 26% / 61% | −2.66 (−3.51) | 34% · +0.05R |
| H2a, breakout, no confirmation | 429 | 27% / 63% | −3.09 (−4.36) | 34% · +0.07R |
| H2, breakout accepted (next candle holds) | 328 | 30% / 62% | −1.52 (−2.65) | 27% · +0.07R |
| H2 + opposite writing at the level | 261 | 33% / 59% | +1.16 (−0.03) | 28% · +0.13R |
| H5, fake-up at owner S/R + call writing (paper rule) | 13 | 62% / 38% | **+25.25 (+25.03)** | 15% · +0.58R |

## Why and when (diagnostics)

- **The current PT fires late:** 74 of 76 signals came after the index had already moved ≥ 2 ATR from the last hour's
  extreme.
- **PT by time of day:**
  - 09:30–10:30: 40% targets, +₹7.3
  - 10:30–12:30: −₹1.8
  - 12:30–14:30: −₹6.5
- **PT after an opposite signal within 60 min:** −₹7.3.
- **Rejection (H1):**
  - Works at major levels: owner S/R +₹10.1 (26), ORB low +₹10.9 (12).
  - Not at minor intraday pivots: ≈ 0 (109).
  - A ≥ 60% wick beats 40–60% (+3.1 vs −1.6).
  - After 12:30 it loses (−₹7.7).
- **Breakout (H2):**
  - Major levels work: ORB high +₹24.8 (27), PDC +₹34 (15), PDH +₹12 (14).
  - Minor pivot breakouts are the bulk and lose (−₹7.0, 284).
  - At the level strike, opposite-side UNWIND (−₹11.3), COVER (−₹42) or BUY (−₹15.8) all lose.
  - Waiting one candle for acceptance helps slightly (−1.5 vs −3.1).
- **OI "writers defending the level" does NOT help rejections in this window** (H1 + OI is worse than H1).
- **An earlier entry (H4) is worse than PT.** The late entry cannot be fixed just by entering at the first index cross.

## Combinations (chosen AFTER seeing these sessions; hypotheses for Phase 2 only)

| Combination | n | Option target / SL | Option net ₹ per trade (pess) | Index 2R · avg R |
|---|---|---|---|---|
| C1: rejection, major level, wick ≥ 60%, before 12:30 | 32 | 28% / 41% | +7.45 (+6.91) | 59% · +0.78R |
| C2: breakout accepted, major level, no unwind / cover / buy at the level strike | 121 | 40% / 50% | +10.97 (+9.82) | 32% · +0.25R |
| C3: current PT, before 12:30, no flip | 40 | 38% / 50% | +7.89 (+7.30) | 53% · +0.82R |
| C4: fake-up + call writing (paper rule) | 13 | 62% / 38% | +25.25 (+25.03) | 15% · +0.58R |
| Random before 12:30 (reference) | 2,160 | 25% / 60% | −4.36 (−5.60) | 37% · +0.17R |

## Most promising for Phase 2 (2-year validation, pre-registered exactly as above)

1. **C2, breakout acceptance at a major level without opposing unwinding / covering.** It has the largest sample, a
   clear mechanism (the other side gave up and nobody is closing against the move), and it works on both indices.
2. **C1, rejection at a major level** with a strong wick, in the morning.
3. **C4** is already in the forward paper test (it held over 2 years).

**C3 caution:** PT had no edge over 2 years. Its morning-only, no-flip version is a single new filter to test, not a
fix for the late entry.

**Limits:**
- 15 sessions; the combinations were chosen in-sample.
- Overlapping trades on the same days.
- Index wicks come from minute closes.
- OI covers only the ±3 band.
