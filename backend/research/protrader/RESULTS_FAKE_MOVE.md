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
