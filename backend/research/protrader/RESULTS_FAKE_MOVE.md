# FAKE-DOWN / FAKE-UP label: how often is it right? (2026-10-24)

Scripts: `fakeMoveStudy.ts` (#1, filters) and `fakeMoveStudy2.ts` (#2, 5-min vs 15-min, confirmations, target sweep).

**Data:** real Dhan 1-min spot data, 2024-10-01 → 2026-10-23, 487 sessions each for NIFTY and SENSEX. Development is the
first ⅔ of sessions and validation the last ⅓.

**Detector:** the live `detectFakeMoveTF`. Its levels are the live screen's: the last 6 swing points, PDH / PDL and the
ORB high / low. OI walls are left out because there is no OI history for them.

**Scoring:**
- **RIGHT** means the target (1 × ATR14 of the timeframe) is hit before the stop (the 4-bar sweep extreme), within
  60 min on 5-min candles and 120 min on 15-min.
- **avg R:** RIGHT = target ÷ stop distance, WRONG = −1, TIME = the move at the horizon ÷ stop distance.
- **Same-stop baseline:** an entry at every candle close with the same stop width (0.25-ATR buckets) and the same target.

## Validation results (right % · avg R | baseline right % · avg R)

| | NIFTY 5m | NIFTY 15m | SENSEX 5m | SENSEX 15m |
|---|---|---|---|---|
| FAKE-DOWN, live label | 55.9% · −0.07 \| 56.0% · −0.08 | 41.3% · −0.10 \| 41.8% · −0.08 | 54.5% · −0.08 \| 55.4% · −0.08 | 39.7% · −0.12 \| 42.1% · −0.08 |
| FAKE-DOWN, follow-through | 59.7% · −0.05 \| 59.3% · −0.07 | 42.9% · −0.08 \| 43.9% · −0.08 | 58.4% · −0.08 \| 58.9% · −0.08 | 39.1% · −0.08 \| 43.9% · −0.08 |
| FAKE-UP, live label | 59.3% · −0.03 \| 62.6% · +0.01 | 53.0% · +0.06 \| 53.4% · +0.06 | 62.6% · 0.00 \| 62.3% · 0.00 | 51.9% · +0.03 \| 53.6% · +0.06 |
| FAKE-UP, follow-through | 64.2% · −0.02 \| 65.5% · −0.01 | 58.0% · +0.06 \| 58.7% · +0.05 | 65.1% · 0.00 \| 65.3% · −0.01 | 53.9% · +0.02 \| 59.5% · +0.06 |

The other variants were hold 2 bars, the day-average side, the higher-timeframe structure and their combinations. In
development and validation each one stays within about ±3 points of its same-stop baseline, with no consistent sign.

**Target sweep on the live label** (NIFTY 5m validation, FAKE-DOWN):

| Target | Right | avg R |
|---|---|---|
| 0.25 ATR | 78.9% | −0.09 R |
| 0.5 ATR | 71.8% | −0.07 R |
| 1 ATR | 55.9% | −0.07 R |
| 2 ATR | 32.3% | −0.08 R |

Every index, timeframe and direction tops out at about 80–83% right with the smallest target, and avg R stays negative.

## Verdict (ProTrader)

**The label has no measurable edge on either 5-min or 15-min candles.**
- Its "right %" equals the same-stop baseline, so the result comes from where the stop sits, not from the signal.
- 15-min is worse than 5-min.
- 90% right cannot be reached honestly: the only way to get near it is a tiny target, which loses money (negative avg R).

**Keep the label as information only.** Do not use it as an entry signal or as a reason to give a trade.

**Next candidates** (untested; they need data the price-only test lacks):
- premium confirmation (the CE / PE premium makes a higher high on the reclaim)
- OI behaviour at the swept level, using the 1-min OI log once it has 60+ sessions
- using the label as a *trap warning* against breakdown / breakout trades rather than as an entry

## Study #3: candle levels for breakdown / breakup (`fakeMoveStudy3.ts`, owner's idea)

The same detector was given the high / low of a reference candle instead of the swing / PDH / ORB levels:
- **C1:** the previous candle of the same timeframe
- **C2:** the last completed higher-TF candle (15m for the 5m chart, 1h for the 15m chart)
- **C3:** the day's running high / low

Each break was scored two ways:
- **FAKE:** break, then a close back; trade the reclaim.
- **BREAK:** two closes beyond the level; trade the break.

Validation right % vs the same-stop baseline:

| | NIFTY 5m | NIFTY 15m | SENSEX 5m | SENSEX 15m |
|---|---|---|---|---|
| FAKE-DOWN, live levels | 56.0 / 56.0 | 40.2 / 41.1 | 54.7 / 55.5 | 39.6 / 42.1 |
| FAKE-DOWN, prev candle | 53.5 / 53.7 | 40.2 / 41.0 | 53.1 / 53.5 | 40.0 / 41.6 |
| FAKE-DOWN, higher-TF candle | 53.7 / 55.0 | 39.9 / 41.1 | 52.4 / 54.4 | 39.4 / 42.5 |
| FAKE-UP, prev candle | 58.5 / 60.4 | 51.4 / 54.3 | 58.0 / 59.8 | 49.9 / 53.7 |
| BREAK-DOWN, prev candle | 46.5 / 45.6 | 44.8 / 42.0 | 43.8 / 44.6 | 44.4 / 41.3 |
| BREAK-UP, prev candle | 37.6 / 38.6 | 32.1 / 32.1 | 38.0 / 37.7 | 33.3 / 32.4 |

**Results:**
- **FAKE on candle levels** is equal to or slightly worse than the live levels: −0.5 to −5 points vs baseline, in both
  development and validation.
- **BREAK** is within about ±3 points of baseline in most cells. A few validation cells are higher, e.g. the 15-min
  day-low break-down at 56.3 vs 44.8 (n = 176). None of them hold in development (42.4 vs 42.9), so they reflect the
  falling market of the validation months, not the signal.
- **avg R is not usable for BREAK:** the 2-bar stop is often tiny, so a few trades produce very large R values.

**Verdict:** candle levels do not improve the indicator. No change to live logic.

**Detector finding, display only:** the live screen sets a level's side from where the spot is
(`api.ts` `side: p >= spot ? …`). Once price closes beyond a level, that level switches sides, so the detector's
BREAKOUT / BREAKDOWN ACCEPTED states can practically never fire. This is also why the badge read "closed below
Swing **High**". Fixing it means using the level's role: highs are resistance, lows are support.

## Study #4: candle fake AT a support / resistance level (`fakeMoveStudy4.ts`, owner's idea)

**Event:** a previous-candle fake (study #3 C1). It counts only when the swept candle level sits within 0.3 × ATR of a
support / resistance level.

**Variants:**
- **K1:** at a live S/R level (swing points, PDH / PDL, ORB)
- **K2:** at an owner S/R level (`priceActionLevels`: 15-min turn clusters and flip zones of the previous 5 sessions)
- **K3:** the live-level fake fires on the same candle
- **K4:** any S/R level, tight (0.15 × ATR)
- **K1 + K2**

Right % vs the same-stop baseline (development → validation):

| Variant | NIFTY 5m DOWN | NIFTY 15m UP | SENSEX 5m DOWN | SENSEX 15m UP |
|---|---|---|---|---|
| K0 candle fake alone | 56.5/57.1 → 53.5/53.4 | 51.2/52.0 → 51.4/53.6 | 55.8/56.4 → 53.1/53.1 | 49.1/49.9 → 49.9/53.0 |
| K1 at live S/R | 56.4/57.6 → 52.4/53.6 | 51.2/52.2 → 51.6/53.8 | 54.6/56.8 → 48.8/53.3 | 49.2/49.8 → 49.3/53.1 |
| K2 at owner S/R | 53.8/57.2 → 53.7/52.8 | 53.6/51.7 → 57.7/53.1 (n 78) | **62.0/56.8 → 40.5/53.2** | 48.7/49.8 → 50.5/53.5 |
| K1 + K2 | 59.8/57.3 → 52.3/52.9 | 54.1/52.0 → 58.7/53.1 (n 63) | **68.5/57.1 (n 130) → 34.0/53.6 (n 50)** | 47.3/49.9 → 48.8/53.4 |

**Results:**
- **No variant beats the baseline in both periods for both indices.**
- The best development result, SENSEX 5m FAKE-DOWN at live + owner S/R (68.5% vs 57.1%), reverses in validation to
  34.0% vs 53.6%. This is the classic sign of a chance pattern.
- **NIFTY 15m FAKE-UP at owner S/R** is better in both periods (+2 → +5 points), but n is only 63–78, and SENSEX 15m
  FAKE-UP does not confirm it (−1 → −3). Watch only.

**Verdict:** no improvement. No change to live logic.
