# Final blocker and capability report: the 15–60 index-point objective

## The direct answer

**NO.** I built and fully tested a 15–60 point capture strategy (LAX), and it does not show a repeatable edge in two-year
out-of-sample validation.

- **Validation was possible and conclusive.** The candidate failed 5 of its 6 pre-registered criteria. Conservative net
  was −₹226 per trade [−322, −142], negative on all 3 indices and in all 5 half-years.
- **The same is true of C2, the EMA baseline and the simple ORB benchmark** on the same two years.
- **C2's +₹362 per trade from the 15-day window does not hold out of sample:** with its own exit it makes −₹146 per trade.

**Why NO and not PARTIALLY:** no data or code blocker prevented the validation. The evidence is negative.

## 1. Which module prevents the objective?

**None prevents building or validating it.** The binding limitation is the **economics of the signal relative to the
option-trade costs**. This is measurable, not a matter of opinion:

| Layer | What the evidence shows |
|---|---|
| **Signal** (levels + acceptance, `strategy.ts`) | There **is** a directional bias: the index reaches +15 points before invalidation in 61% (LAX) and 66% (C2) of trades, vs 52% for random entries, a significant difference. But the move against the trade is almost as large as the move for it: median MFE 21 vs MAE 15 points. |
| **Exit** (`indexExit`) | Captures **+2.3 index points per trade on average**. Breakeven and thesis exits cut the many moves that reverse; the 45-point target is reached in only about 35–40% of trades. |
| **Option monetisation** (ATM, `optionPnl`) | Option gross ≈ 0.51 × index points × lot − ₹23. Costs average ₹143 per trade. **Break-even needs about 4.7 (NIFTY), 13.8 (BANKNIFTY) and 9.8 (SENSEX) index points per trade**, and the strategy captures 2.3. |

## 2. What kind of blocker it is

**Weak strategy design relative to costs.** The level / acceptance features give a real but small directional edge,
worth about +9 to +14 points of "+15 reach" over random. That is too small to pay for an option round trip.

**Not an implementation defect:**
- The engine reproduces C2's Phase-1 trades exactly (121 / 48 / 60 / 13 / +₹362).
- 9 unit tests cover the entry, rejection and exit rules and the costs.
- The cost model is the ProTrader standard.

**Data limitations that exist but do not change the verdict:**
1. **No 1-min index highs / lows.** Stops and targets act on 1-min closes, which is slightly optimistic for stops and
   pessimistic for targets.
2. **No bid / ask history.** Slippage is modelled (0.25%, and 0.75% conservative), not measured.
3. **Expiry dates are inferred** from the straddle collapse. There is no contract master.
4. **OI exists only for the rolling ATM ± 3 strikes.** The app's ±10-strike OI log has only 6 complete sessions.
5. **No VIX or news history** in the research data.
6. **The BANKNIFTY daily refresh is missing** (fixed by hand for this test).

**A reasoning limitation in my earlier work:** C2 was selected from 15 sessions. Its +₹362 was a small-sample result, and
the two-year test shows it does not generalise. That is exactly what the pre-registered, out-of-sample protocol was there
to catch.

## 3. What would resolve each limitation

| Limitation | Fix | Effort |
|---|---|---|
| Edge too small vs cost | Test **cheaper or more convex monetisation** with the data already held: 1-strike ITM options (higher delta), or an ATM–OTM+2 debit spread within the ±3 band. Pre-register, then test on DEV → OOS. | Can run now |
| Too many breakeven / thesis exits | Pre-register **one** alternative exit (e.g. a structure trail on 5-min swing lows) and test OOS. Do not tune. | Can run now |
| OI-based logic untestable | Keep the app's ±10-strike 1-min OI log running (`data/oi-minute`). After 60+ complete sessions, test OI-wall breakouts and rejections. | Wait about 3 months |
| No 1-min index OHLC | Store 1-min index OHLC from the live feed going forward (Dhan intraday candles), or download index 1-min OHLC history. | Small code change |
| No real fills | Log bid / ask with every live paper signal, to measure slippage. | Small code change |
| BANKNIFTY refresh | Add BANKNIFTY to `refreshData.ts`. | Small code change (needs approval) |

## 4. What I can implement and test now (done or ready)

**Done:**
- The data audit.
- The pre-registered LAX candidate (entry, WAIT / NO-TRADE reasons, room and freshness checks, the risk layer, the
  index-driven exit).
- The cost model and a 1-minute execution delay.
- Day-clustered bootstrap confidence intervals.
- Chronological DEV / VAL / TEST validation on 3 indices.
- Trade-level CSV audits.
- An exact C2 reproduction.
- The EMA, ORB and random benchmarks.

**Ready to run next**, each pre-registered first:
- ITM or spread monetisation of the same LAX / C2 signals;
- one alternative trailing exit;
- C4 (fake-up + call writing at owner S/R, the only rule family that held up over two years earlier) with its own
  2-year paper record.

## 5. What cannot be validated with the evidence available

| Item | Why |
|---|---|
| OI-wall levels and full-chain positioning as entry filters | Only ATM ± 3 OI history; the ±10 log has 6 sessions. |
| VIX- or news-based regime filters | No VIX / news history in the research set. |
| Exact stop slippage and fills | No bid / ask or 1-min index highs / lows. |
| Futures as the trading vehicle | No futures history. Estimated from spot: futures statutory costs alone (about ₹340 per NIFTY lot) exceed the average capture, so this does not fix the problem. |

## 6. Next-best alternative architecture

**Use the directional bias as context, not as the trade.** Accepted breakouts at market levels predict direction modestly
(+15 reach 61–66% vs 52%). On their own, they cannot pay for an option round trip.

The proposed architecture:
1. **Direction context:** the market-level acceptance state (LAX / C2 rules) → allow CE only / PE only.
2. **Entry from a setup with a demonstrated two-year edge:** C4, the fake-up at owner S/R with call writing (61–81% vs a
   54–55% baseline in its 2-year test). It is in a live paper test from 26 Oct.
3. **Exit and monetisation, chosen once on DEV and then tested OOS.**

This combination has **not** been tested. I'm proposing it, not claiming it works.
