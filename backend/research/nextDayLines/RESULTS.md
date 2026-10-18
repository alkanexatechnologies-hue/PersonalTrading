# One-day trendlines and the next-day plan, tested on the next day (run 2026-10-18, research only)

**Data:** Dhan 5-min spot for NIFTY and SENSEX. 63 sessions, 20 Jul → 16 Oct 2026, aggregated to 15-min and 1-hour.

**Script:** `run.ts <dir with NIFTY.json / SENSEX.json>`

No app logic was changed: the user confirms any change to the main logic first.

## A. Trendlines drawn from ONE day and projected into the next day

**How the lines were drawn and graded:**
- **15-min:** the app's `significantLines` (2-bar swings).
- **1-hour:** `allLines` with 1-bar swings, because one day has only about 7 hourly candles.
- Only lines still unbroken at D's close were carried into D+1, graded on D+1's 15-min candles:
  - **RESPECTED:** touched, then 1 ATR away before a 15-min close through the line.
  - **BROKEN:** a 15-min close through the line came first.
  - **Never touched**, or **gapped through** at the open.
- **Control:** a FLAT line at the same price at D+1's open, graded the same way.

| | touched → respected / broken | never touched | gapped through | FLAT control (respected / broken) |
|---|---|---|---|---|
| NIFTY 15m seller | 9 → 5 / 4 | 6 | 4 | 4 / 4 |
| NIFTY 15m buyer | 8 → 4 / 4 | 2 | 5 | 4 / 3 |
| NIFTY 1h seller | 2 → 0 / 2 | 0 | 2 | 1 / 1 |
| NIFTY 1h buyer | 3 → 0 / 3 | 1 | 3 | 0 / 3 |
| SENSEX 15m seller | 8 → 5 / 3 | 6 | 7 | 4 / 3 |
| SENSEX 15m buyer | 10 → 4 / 6 | 1 | 3 | 3 / 6 |
| SENSEX 1h seller | 1 → 1 / 0 | 0 | 3 | 1 / 0 |
| SENSEX 1h buyer | 4 → 2 / 2 | 1 | 3 | 2 / 2 |

**Reading:**
- **15-min lines:** when the next day reached a one-day line, it held about half the time (18/35 overall). A flat line at the same price did almost the same (15/31). The slope adds nothing measurable, and the samples are small.
- **1-hour lines:** one day gives too few hourly candles to draw a real line. They were rare (4–8 in 62 days), often gapped through, and mostly broke. **One day of 1-hour data is not enough.** 1-hour lines need several days.
- About a third of the lines were gapped through or never reached the next day.

## B. The next-day plan built at D's close, applied on D+1

**Rules:**
- **Entry:** a 15-min close beyond the start, before 15:00.
- **No entry:** if that close is already past Target 1 (counted as MISSED, the live rule).
- **Exits:** Stop Loss on a 15-min close beyond the stop · Target 1 on a touch · time exit at 15:12.
- One trade a day; the gap re-anchor at the open is included.
- **Limitation:** there is no historical option chain, so OI walls are missing from these plans. The live plans use them.
- **Points are INDEX points before option costs** (spread, time decay, charges).

| | NIFTY | SENSEX |
|---|---|---|
| Days | 57 | 57 |
| Re-anchored on a gap open | 20 | 22 |
| MISSED (the move finished inside one candle) | 12 | 10 |
| Trades | 38 | 36 |
| Target 1 / Stop / Time exit | 16 / 18 / 4 | 20 / 14 / 2 |
| Winners | 19/38 (50%) | 21/36 (58%) |
| Average / median per trade | −1.8 / +5.5 pts | +21.7 / +40.4 pts |
| Total | −70 pts | +781 pts |

**Reading:**
- **NIFTY:** about break-even before costs, so negative after costs.
- **SENSEX:** positive before costs (+21.7 SENSEX pts ≈ +7 NIFTY-equivalent per trade). That's a small margin to survive option costs, from a sample this size.
- **Overall:** consistent with the earlier pre-registered studies. **No validated edge.**
