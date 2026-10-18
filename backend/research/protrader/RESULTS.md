# ProTrader premium backtest #1 (run 2026-10-18)

**What was replayed:**
- The live plan code: `planInit` / `planStep` (forward-only, as locked), `plans`, `ladder`, `levelBreak`.
- The co-pilot's exact trade rules: one trade at a time per index · Target 1 = book half and move the stop to entry ·
  Target 2 · Stop Loss on a 15-min close · 15:12 exit · conflict = stand aside · trigger de-duplicated by level.

**Data:** about 2 years of real Dhan 1-minute data (rolling-option ATM±3 premiums + spot), 1 Nov 2024 → 16 Oct 2026,
NIFTY and SENSEX weeklies.

**Premium P&L:**
- **Strike:** the at-the-money strike at entry. Its real premium is read at the entry, Target 1 and exit minutes.
- **Costs:** per unit and side, the larger of 0.5 point or 0.25% of premium, plus ₹40 per lot.
- **Lots:** NIFTY 75, SENSEX 20.

**Split:** development = first ⅔ (to 19 Feb 2026), validation = last ⅓.

**Limitations:**
- No historical OI walls (only ATM±3 stored).
- Bars are built from 1-minute closes.
- Levels = previous day, pivots, previous week, trendlines.

Script: `premiumBacktest.ts` (≈7 s).

## Results (₹ = 1 lot)

| Version | Index | Trades | Win % | T1 (T2) | Stop Loss | Avg / trade | Total ₹ | Max drawdown |
|---|---|---|---|---|---|---|---|---|
| A: before 18 Oct | NIFTY | 556 | 36% | 249 (78) | 238 | −5.5% | −1,82,000 | −2,05,802 |
| A | SENSEX | 590 | 39% | 284 (88) | 234 | −4.1% | −1,23,557 | −1,37,426 |
| **B: live (range-day filter)** | NIFTY | 484 | 37% | 219 (71) | 206 | −5.7% | **−1,49,993** | −1,74,896 |
| **B** | SENSEX | 508 | 40% | 247 (77) | 198 | −3.6% | **−1,04,676** | −1,18,545 |
| C: B + −30% premium stop | NIFTY | 490 | 34% | 204 (69) | 133 + 110 prem-SL | −4.7% | −1,29,720 | −1,57,656 |
| C | SENSEX | 513 | 37% | 235 (69) | 137 + 88 prem-SL | −3.7% | −1,17,853 | −1,33,705 |

**Development / validation (total ₹):**

| | A | B | C |
|---|---|---|---|
| NIFTY development | −1,21,027 | −1,16,470 | −98,624 |
| NIFTY validation | −60,973 | −33,523 | −31,096 |
| SENSEX development | −80,659 | −77,991 | −89,609 |
| SENSEX validation | −42,898 | −26,685 | −28,244 |

## Where the money goes (B, both indices, 992 trades)

**By outcome:**

| Outcome | Trades | Avg | Total ₹ |
|---|---|---|---|
| Stop Loss | 404 (41%) | **−26.6%** | −7,19,179 |
| Target 2 | 148 | +30.5% | +3,10,283 |
| Target 1 then time exit | 117 | +26.1% | +1,95,639 |
| Target 1 then breakeven | 201 | −1.8% | (costs eat the half booked) |
| Time exit | 122 | −8.5% | |

**By entry time:**
- 09:30–11:30: −2% to −7% per trade.
- 12:00–13:30: roughly flat to slightly positive.
- **14:00: −10.5%. 14:30: −18.6%.**

**By weekday:** Tue −8.7% and Thu −8.3% (the expiry days) are the worst. Fri −0.9%, Mon −1.4%.

## ProTrader verdicts

| Item | Verdict | Why |
|---|---|---|
| **The system as a whole** | **NOT PROFITABLE for an option buyer** | Over ~2 years, after costs, every version loses (−3.6% to −5.7% per trade). |
| P2 range-day filter | **APPROVE** | It improves P&L in development AND validation for both indices, and lowers max drawdown. |
| P8 plan lock + fix 3 | **APPROVE** | Bug fix; the replay is the forward-only plan. |
| P7 5-min cutoff | Not gated (alerts only) | |
| P9 wall in front of Target 1 | **NEED MORE DATA** | No historical OI walls. The 1-minute OI log (since 8 Oct) must accumulate; re-test in 2–3 months. |
| −30% premium stop (candidate) | **REJECT** (as defined) | It helps NIFTY in both periods but hurts SENSEX in both. |

## Next tests (rules fixed before running)

1. No new entries from 14:00.
2. No entries on the index's own expiry day.
3. The stop structure (41% of trades stopped at −26.6%): wider structure stop vs smaller size, entry after a retest.
4. The sweep / reclaim entry as the primary entry.
