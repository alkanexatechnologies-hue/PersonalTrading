# Investigating and fine-tuning the PT logic (2026-10-25)

Script: `ptImprove.ts`. Full output: `RESULTS_PT_IMPROVE_raw.txt`. Research only.

**PT entry:** the ATM premium EMA 9 crosses its EMA 21 while the index is past its EMA 21.

**Exits:** the first 1-min premium high / low touching the stop or target, else 15:25.

**Costs:** ₹0.5 or 0.25% per side + ₹40 per lot. "Pessimistic" fills a stop at the minute's close.

## Diagnosis (last 15 sessions)

- **The ₹5 stop sits inside normal noise:** it is 0.45 × the NIFTY and 0.12 × the SENSEX premium ATR (5m).
- **9 of 25 NIFTY and 12 of 22 SENSEX stopped trades reached +40 later the same day.**
- **Winners hardly dip in the first 15 min** (NIFTY ₹1 vs ₹17 for losers).

## Two years, net ₹ per trade (best / pessimistic) and win %

| Variant | NIFTY DEV | NIFTY VAL | NIFTY TEST | SENSEX DEV | SENSEX VAL | SENSEX TEST |
|---|---|---|---|---|---|---|
| E0 owner, SL 5 / T 40 | 9.6% · −1.90 / −2.94 | 11.8% · −1.24 / −2.31 | 11.7% · −0.78 / −1.58 | 12.6% · −3.14 / −6.89 | 12.3% · −3.71 / −7.92 | 20.5% · +0.50 / −2.65 |
| S1, SL 1 × pATR / T 40 | 18.4% · −1.63 / −2.52 | 25.6% · +0.09 / −0.99 | 15.6% · −1.99 / −2.61 | **40.3%** · −5.68 / −7.52 | **47.4%** · −5.63 / −7.64 | **46.9%** · +0.78 / −0.29 |
| S2, SL 1 × pATR / T 3 × SL | 22.8% · −1.80 / −2.64 | 26.1% · −1.30 / −2.41 | 23.4% · −2.31 / −2.86 | 23.2% · −4.65 / −7.20 | 25.4% · −6.71 / −9.88 | 31.3% · +5.49 / +4.16 |
| S3, SL 1.5 × pATR / T 3 × SL | 20.8% · −1.90 / −2.90 | 26.1% · −0.11 / −0.94 | 23.4% · −1.62 / −2.22 | 19.6% · −5.88 / −8.09 | 24.1% · +0.54 / −2.58 | 24.1% · +6.56 / +4.53 |
| P1, limit at premium EMA 9 + S2 | 24.4% · −1.36 / −2.11 | 23.2% · −2.90 / −4.12 | 15.5% · −3.67 / −4.27 | 17.5% · −10.63 / −12.92 | 20.5% · −13.15 / −16.06 | 16.0% · −8.83 / −10.88 |
| S2 + F4, index candle agrees | 22.3% · −2.17 / −2.97 | 25.2% · −2.12 / −3.41 | 23.7% · −2.08 / −2.57 | 24.1% · −3.02 / −5.50 | 27.9% · −1.98 / −4.96 | 34.7% · +9.47 / +8.45 |
| S2 + F2, ATR < 1.2 | 20.8% · −2.43 / −3.21 | 25.0% · −2.16 / −3.10 | 24.4% · −1.53 / −1.96 | 24.0% · −3.26 / −5.42 | 26.7% · −3.88 / −6.86 | 31.5% · +5.80 / +4.65 |

**Other variants** (no flip, time window, all filters combined) are in the raw file. None is positive in DEV.

**Last 15 sessions:** E0 was +₹2.94 / +₹1.83 (NIFTY) and +₹3.49 / −₹1.85 (SENSEX) per trade. Over 2 years the same rule
is negative in DEV and VAL on both indices, so the recent result was a favourable stretch.

## Verdict (ProTrader)

- **The stop is the cause of the low win rate, not the losses.** Sizing the stop to the option's noise lifts the win
  rate (SENSEX 13% → 40–47%, NIFTY 10% → 18–26%).
- **No exit or filter makes the logic profitable in DEV.** The entry itself has no edge after costs. The premium
  EMA 9 / 21 cross is a delayed copy of the index move, so by the time it fires much of the move is done.
- **A pullback limit entry is worse:** the trades that fill are mostly the ones that keep falling (adverse selection).
- **Only F4 (index candle agrees) improves SENSEX in all three periods**, but DEV is still negative.
- **No change to live logic.** Further gains need a different source of information (OI / positioning, as in the
  fake-up paper test), not more tuning of this entry.
