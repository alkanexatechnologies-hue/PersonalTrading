# ProTrader study: the owner's idea, "direction first, enter on the liquidity sweep" (run 2026-10-18)

**Data and method:** the same as backtest #2. About 2 years of real Dhan 1-minute premiums after costs; non-expiry days;
earlier ⅔ of days = development, later ⅓ = validation. Script: `structureSweep.ts` and the `structFilter` flag in
`premiumBacktest2.ts`.

## The rules (the owner's idea in ProTrader's own words)

1. **Direction:** the last two confirmed 15-min swings. UP = higher high + higher low; DOWN = lower high + lower low;
   otherwise no trade.
2. **Sweep:** with the trend, a 5-min candle takes the latest 5-min swing low (high) and CLOSES back inside, while the
   15-min higher low (lower high) holds. That is the "move-start" candle.
3. **Entry:** price crosses that candle's high (low) within 15 min.
4. **Stop:** that candle's low (high).
5. **Targets:** Target 1 = the swing high before the pullback (at least 0.8× the risk away). There: book half, stop to
   entry, then trail under new 5-min higher lows. Target 2 = 3× the risk.
6. **Discipline:** entries 09:45–14:30, max 2 a day, exit by 15:12.

## Results (average per trade; development | validation)

| Version | NIFTY | SENSEX |
|---|---|---|
| **Live logic** (plan + retest, expiry skip) | **−1.0% \| −0.5%** | **−5.5% \| +2.5%** |
| S1 structure + sweep, ATM, cross | −4.9% \| −3.2% (29% win, SL 67%) | −2.2% \| −2.0% |
| S2 the same, 1 ITM | −4.0% \| −2.8% | −2.2% \| −1.9% |
| S3 the same, 5-min close entry | −5.9% \| −5.5% | −2.4% \| −1.6% |

**Round 2, chosen on development:**

| Version | NIFTY | SENSEX |
|---|---|---|
| R2d: + 15-min EMA20 trend filter (the development pick) | −4.0% \| −4.2% | −1.8% \| −1.9% |
| R2a: stop under the 15-min structure | −8.2% \| −1.6% (only 25 / 10 trades) | −4.1% \| −4.3% |
| R2a + R2d | 17 / 8 trades: too few to judge | 11 / 8 trades: too few to judge |

**The direction filter on the live logic** (CE only in an UP structure, PE only in DOWN):

| | NIFTY | SENSEX |
|---|---|---|
| Per trade | −1.4% \| −6.2% | −7.0% \| −1.9% |
| Trades | 61 (vs 220 live) | 79 (vs 256 live) |

It is worse per trade in 3 of 4 cells.

## Verdict: REJECT, all versions

None beats the live logic in both periods for both indices.

**What the data says:**
- Intraday 15-min swing structure did NOT improve these entries. Trades taken with the structure did worse.
- Stops at a single 5-min candle sit inside the noise (NIFTY stop rate 67%).
- Wider structural stops leave too few trades with enough room to Target 1.

**What a human does that these rules do not capture yet:**
- choosing which levels matter today
- skipping choppy, low-range days
- reading volatility and news

Those are candidates for the next study, together with the owner's own BTSD trade journal. The owner's real decisions
can be measured once enough trades are recorded.
