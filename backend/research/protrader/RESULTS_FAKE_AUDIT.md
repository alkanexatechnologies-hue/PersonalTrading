# Quantitative audit of the live FAKE-DOWN / FAKE-UP detector (2026-10-24)

Script: `fakeMoveAudit.ts` (research only; no live code changed). Equivalence tests: `fakeMoveAudit.test.ts`.
Full output: `RESULTS_FAKE_AUDIT_raw.txt`.

## Step 1: baseline reproduced

**Equivalence:** the audit's copy of the detector equals the live `detectFakeMoveTF` + `buildFakeMoveResult` on
**70,103 bar evaluations with 0 mismatches**, covering 5m, 15m, the signal and the confidence. Unit tests add the
documented patterns and 8,000 random cases.

**Data:** real Dhan 1-min NIFTY + SENSEX spot, plus ATM±3 option legs (price, OI, volume), 2024-11-04 → 2026-10-23,
487 sessions per index.

**Periods (chronological):**
- DEV: 292 sessions, to 2026-01-07
- VAL: 96 sessions, 2026-01-08 → 2026-06-03
- TEST: 97 sessions, 2026-06-04 → 2026-10-23
- One session purged at each boundary.

**Baseline:**
- **Detector:** live, 4 bars, 0.04%.
- **Candles:** 5m, and 15m **including the forming candle** (as the live feed).
- **Levels:** PDH / PDL, ORB (after 09:30) and the last 6 swing points per timeframe; side by spot.
- **Signal:** a FAILED_BREAKDOWN / BREAKOUT / EARLY_REJECTION headline with a confirmed timeframe, first per day /
  direction / level.

**Deviations from live:**
- No OI-wall levels: there is no full-chain OI history.
- Swing points come from 5 days of candles; live uses 30 / 45 days.

**Outcomes (pre-registered):**
- **Trade:** 1R target vs the 4-bar sweep stop (floored at 0.25 ATR5), 60 min on 1-min closes. Strict precision =
  target ÷ all signals.
- **Direction:** at least 0.25 ATR5 in the signal direction at +60 min.
- **Net:** ATM CE / PE, with costs of max(0.5, 0.25%) per side + ₹40 per lot.

| | DEV | VAL | TEST |
|---|---|---|---|
| Eligible setups (level interactions) | 9,339 | 3,099 | — |
| Signals (both indices) | 6,236 | 2,086 | 2,084 |
| Signals per session, both indices (false) | 10.7 (7.4) | 10.9 (7.0) | 10.7 (7.2) |
| **Trade precision, 1:1** [95% CI] | **31.0%** [29.8–32.1] | **36.0%** [34.0–38.1] | **32.8%** [30.8–34.8] |
| Same-stop random-entry baseline | 31.9% | 34.4% | 33.3% |
| Precision of decided trades (target or stop) | 48.5% | 52.3% | 48.6% |
| Direction correct / wrong | 44.6% / 47.1% | 46.0% / 46.4% | 46.1% / 47.0% |
| Recall (of reversal-positive setups) | 63.7% | 68.1% | 66.2% |
| **Net per trade after costs** (ATM option, % of premium) [CI] | **−8.4%** [−11.5, −5.3] | **−6.5%** [−10.8, −1.3] | **−4.8%** [−8.8, −2.0] |

**No ambiguous bars occurred:** the data has 1-min closes only, so a target and a stop crossed inside one minute
cannot be seen.

**Reconciling the earlier "55–60%":** with the earlier definition (a 1-ATR target vs the 4-bar stop, time =
not right), the same signals score **54.7–58.1%**. The median stop is **2.0–2.3 ATR** away against a 1-ATR target,
so that number came from the geometry, not from the signal. At 1:1 the decided precision is about 48–52%, a coin
flip.

## Step 2: where the false positives come from (DEV)

1. **Deep breaks.** 85% of signals break the level by ≥ 1 ATR, and they carry **87.5% of all losers**. The level
   picker accepts any level inside the 4-bar range (a 1% tolerance), and the side comes from the current spot, so a
   deep move through a level and a partial pull-back is labelled a "fake". Breaks under 1 ATR score 43% — but so does
   the same-stop baseline (44%), so this is geometry again.
2. **The "best" setups are the worst.** When 5m and 15m both confirm (confidence 100), precision is 27.5–28.6%: the
   lowest of all. **The confidence score is anti-calibrated:** 35 → 33.8%, 45 → 42.7%, 55 → 37.4%, 100 → 28.6%.
3. **Afternoon (13:30–15:30):** 26.4% precision, −23% net.
4. **Expiry day:** precision is normal, but the option net is **−33%** per trade because the premium decays.
5. **Option-volume spikes (≥ 1.5× pace):** 26.9% precision, −20.8% net.
6. **Level type, prior touches and volatility:** all within ±2 points of the baseline.
7. **Wick-only rejections** (the WATCH state, never shown as confirmed): 42.1% vs a 42.5% same-stop baseline. No
   edge either.
8. **Follow-through is real but arrives too late.** Signals whose next candle follows through score 46% (vs 20%
   without), but entering on that candle (A9) scores 20.4% vs 25.5%: the move has already happened.
9. **Excursions:** the median MAE of winners and the median MFE of losers are both 0.26 ATR. Winners and losers look
   the same early on.

## Step 3: one-change ablations (edge = precision − same-stop baseline, change vs the baseline edge)

| Change | DEV n | DEV prec | DEV Δedge | VAL n | VAL prec | VAL Δedge | VAL net |
|---|---|---|---|---|---|---|---|
| A1 stable level identity (side frozen before the break) | 4,613 | 42.7% | +0.7 | 1,607 | 43.1% | −1.8 | −7.5% |
| A2 ATR threshold 0.05 / 0.1 / 0.2 | 6.6–6.7k | 32.8–33.6% | 0.0 to +0.2 | 2.1k | 37.3–38.1% | +0.3 to +0.9 | −3.6 to −4.6% |
| A3 prior touches ≥ 1 / ≥ 2 | 4,449 / 2,266 | 31.0 / 32.2% | −0.2 / +0.5 | 1,549 / 736 | 36.0 / 37.8% | −0.8 / +0.2 | −8 / −10% |
| A4a completed 15m only | 6,339 | 31.0% | −0.1 | 2,141 | 35.3% | −0.5 | −6.0% |
| A4b completed-15m structure not against | 3,113 | 31.0% | −0.2 | 997 | 34.5% | −2.4 | −6.4% |
| A5 option volume ≥ 1.5× / ATR ≥ 1.2 / ATR < 0.8 | 1.2k / 2.1k / 1.6k | 26.9 / 29.6 / 31.6% | +1.3 / −2.8 / +1.1 | 476 / 600 / 508 | 33.6 / 34.5 / 41.7% | +0.3 / −2.0 / +5.0 | −13 / −9 / −0.1% |
| A6 premium reaction | 4,954 | 29.1% | 0.0 | 1,642 | 34.2% | −0.1 | −1.1% |
| A7 opposite-side ATM OI writing (OI data present 98.4%) | 4,416 | 30.3% | +0.1 | 1,454 | 35.7% | +1.0 | −5.6% |
| A8 no-trade filter (no expiry day, break < 1 ATR, 09:30–15:00) | 725 | 43.9% | +0.5 | 312 | 50.3% | +3.4 | −0.2% |
| A9 follow-through entry (post-hoc) | 2,652 | 20.4% | −4.2 | 896 | 26.2% | −2.9 | −4.5% |

**Selection:**
- **Pre-registered rule:** promising = DEV n ≥ 100 and edge ≥ +3 points. **No change qualified.**
- **No combinations were built and nothing was frozen.** A5c and A8 improve VAL only, so they fail the DEV-first rule.

## Step 5: final test (untouched by this audit)

**Baseline:**
- **Precision:** 32.8% [30.8–34.8] vs 33.3% same-stop; NIFTY 32.1%, SENSEX 33.5%.
- **Net:** −4.8% per trade [−8.8, −2.0].
- **By half-year (2024-H2 → 2026-H2):** 29.5% / 29.3% / 33.0% / 35.1% / 33.3%, never more than 1.4 points above its
  same-stop baseline, and net always negative (−5% to −9%).
- **Regimes:**
  - High-volatility days: 37.3% vs 33.0%, net +1.7% [−0.4, 3.7].
  - Low-volatility days: 29.5%, net −9.5%.
  - The regime label uses the full day's range, so it is known only after the close and cannot be traded.

**Disclosure:** these 487 sessions were also used by the earlier fake-move studies (§1–5 of RESULTS_FAKE_MOVE.md).
TEST is untouched with respect to this audit's choices; truly unseen data starts with the paper test on 2026-10-26.

## Step 6: decision gate

**DO NOT DEPLOY the fake-move label as a trade signal.**
- In every period, on both indices, in every half-year and across 13 one-change variants, precision equals what a
  random entry with the same stop gets.
- Net expectancy after costs is negative with confidence intervals excluding zero (DEV, VAL, TEST).
- **90% precision is not supported.** The best validated precision of any pre-specified variant is **50.3%
  [44.8–55.8]** (A8, VAL n = 312, 1.6 signals per session, recall 14%), against a same-stop baseline of 45.4%. That
  gain did not appear in DEV (+0.5 points), and its net was −0.2% [−1.8, 1.4].

**Recommended (proposals; display only, for the owner's decision):**
1. **Show the badge as context, not a call.** Remove or relabel the confidence % (it is anti-calibrated), and add
   "historically ≈ coin flip at 1:1".
2. **Fix the level picker so the label is truthful:**
   - the interaction must be near the level (not anywhere in a 1% window);
   - the side is frozen before the break (A1).

   This changes counts and wording, not accuracy (A1 Δedge +0.7 / −1.8).
3. **Warn option buyers:** fake-move setups on expiry day (−33% net) and after 13:30 (−23% net) are where money is
   lost.
4. **Open research:**
   - OI-wall levels, once the 1-min OI log has 60+ sessions;
   - the separate owner-S/R + call-writing fake-up rule, already in its forward paper test (RESULTS_FAKE_MOVE.md §5).
