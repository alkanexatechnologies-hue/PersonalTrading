# ProTrader premium backtest #2: four pre-registered tests (run 2026-10-18)

**Setup:** the same as backtest #1 (`RESULTS.md`): ~2 years of real Dhan 1-minute premiums, the live plan code, the
co-pilot's trade rules, after costs, development ⅔ / validation ⅓.

**Base B:** the live logic with the range-day filter.

Script: `premiumBacktest2.ts`.

**Expiry days are read from the data:** a day is an expiry day when the at-the-money straddle at the close is under 35%
of its median. That found 98 per index: NIFTY on Tuesdays and SENSEX on Thursdays recently (e.g. 13 / 15 Oct).

## The tests (rules fixed before running)

| Test | Rule |
|---|---|
| T1 | No new trade from 14:00 |
| T2 | No trade on the index's own expiry day |
| T3a | Enter only on a retest: within 30 min a 5-min candle comes back within 0.25 ATR of the broken level and closes beyond it; else skip |
| T3b | Stop 0.75 ATR beyond the trigger level |
| T4 | Sweep entry: a 5-min candle takes a level and closes back inside. Stop on a 5-min close beyond the sweep extreme; Target 1 = next level ≥ 0.5 ATR (else 1 ATR); 09:30–14:00 |

## Results (₹ = 1 lot)

| Version | NIFTY development | NIFTY validation | SENSEX development | SENSEX validation |
|---|---|---|---|---|
| B (live) | 332 trades, −6.4%, −1,16,470 | 152, −4.3%, −33,523 | 343, −3.6%, −77,991 | 165, −3.7%, −26,685 |
| T1 no entry from 14:00 | −96,459 | −28,588 | −59,208 | −29,291 ✗ |
| **T2 skip expiry day** | **−59,408** | **−19,279** | **−56,495** | **−13,020** |
| **T3a retest entry** | **−59,276** | **−3,755** | **−72,254** | **+18,251** |
| T3b wider stop | −1,28,424 ✗ | −40,525 ✗ | −72,998 | −24,398 |
| T4 sweep entry | −47,611 | −71,960 ✗ | −1,46,879 ✗ | −72,088 ✗ |
| T1 + T2 | −54,231 | −20,471 | −42,047 | −15,898 |
| **T2 + T3a** | **145, −1.0%, −28,313** | **75, −0.5%, −4,012** | **171, −5.5%, −63,935** | **85, +2.5%, +19,770** |

**Max drawdown, B → T2 + T3a:**
- NIFTY: −1,24,977 → −42,637
- SENSEX validation: −41,244 → −6,227

## Verdicts

| Test | Verdict |
|---|---|
| **T2 skip expiry day + T3a retest entry** | **APPROVE.** Better than B in development AND validation for both indices, with lower drawdown and fewer stop losses. Implemented. |
| T1 no entry from 14:00 | **REJECT.** SENSEX validation got worse, and on top of T2 it worsened validation for both indices. |
| T3b wider stop | **REJECT.** NIFTY worse in both periods. |
| T4 sweep entry | **REJECT.** Worse over 2 years. Last week's 80% bull-sweep record was a small sample. |

**Still not proven profitable.** NIFTY about −1% / −0.5% per trade; SENSEX −5.5% in development, +2.5% in validation.
The system now loses far less, and SENSEX validation is positive. Keep paper or minimum size until forward results confirm.
