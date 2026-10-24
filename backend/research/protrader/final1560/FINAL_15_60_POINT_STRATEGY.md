# LAX: Level-Acceptance eXpansion. The 15–60 index-point research candidate

**Status:** research candidate only. It is not wired into the app; no production or live logic is changed.

**Pre-registration:** the rules, evaluation protocol and acceptance criteria below were written and committed **before**
the two-year evaluation was run. Git history shows this file committed ahead of `FINAL_15_60_POINT_BACKTEST.md`.

**Code:**
- `final1560/strategy.ts`: pure signal and exit functions.
- `final1560/strategy.test.ts`: unit tests.
- `final1560/backtest.ts`: the evaluation.

## 1. Why this design (evidence it is built on)

1. **Phase 1, last 15 sessions:** breakouts **accepted** by the next 5-min candle at **market-wide levels** were the only
   entry family clearly better than random (+₹298 per trade vs −₹151).
   - Entering on the breakout candle itself was much weaker (+₹33).
   - Minor intraday pivots and owner turn-levels lost as breakout levels.
2. **The profit was concentrated in the opening two hours** (09:30–10:30: +₹678 per trade). The afternoon lost.
3. **The EMA entries were late:** 74 of 76 came after ≥ 2 ATR of the move. A fresh entry needs a cap on the points already
   consumed.
4. **A 15–60 point target needs room:** an opposing level just above the entry caps the move. Requiring room makes the
   thesis "≥ 15 points plausible" explicit.
5. **Choppy levels:** a level that price has already crossed back and forth today is not a clean acceptance.
6. **Not used:**
   - **OI:** the opposing-OI filter added only +₹64 per trade in Phase 1, and OI exists only for the ATM ± 3 band.
   - **The regime detector:** its 2-year validation failed.
   - **The 3-plan exit:** it reduced expectancy.

## 2. Rules (pre-registered; `strategy.ts`, config `LAX`)

**Instruments:** NIFTY, BANKNIFTY, SENSEX.
- **Candles:** completed 5-min index candles.
- **ATR:** ATR14 of 5-min candles (continuous across sessions).
- **Decisions:** at candle closes only.

**Levels (known before the candle):**
- PDH, PDL and PDC (previous session high / low / close);
- the opening-range high and low (09:15–09:30), usable from the 09:30 candle.

### Entry, long (short is the exact mirror → PE)

1. **Breakout candle** B starts between **09:30 and 11:25**. The previous candle closed at or below level L, and B closes
   above **L + 0.1 × ATR**. Only the first breakout of each level, in each direction, per day is considered.
2. **Acceptance:** the next candle A closes above L, and its low stays above **L − 0.1 × ATR**.
3. **Entry:** at A's close (index price = A.close). **Buy the ATM CE** at the premium's 1-min close of the minute ending
   at that time.
4. **Freshness:** points consumed = entry − L must be **≤ 1.0 × ATR**. Otherwise WAIT (stale).
5. **Chop guard:** L must have been crossed by a 5-min close **at most once** earlier today. Otherwise WAIT.
6. **Room:** the nearest opposing level above the entry (any market-wide level, or today's high so far) must be
   **≥ max(20 points, 1 × ATR)** away. Otherwise WAIT (no room).
7. **Risk:** stop = min(B.low, A.low) − 0.1 × ATR. If entry − stop > **1.5 × ATR** → NO TRADE.
8. **Conflict:** a long and a short signal on the same index and candle → no trade.

### Exit (index-driven)

| Exit | Rule |
|---|---|
| **Target** | entry + min(**45 points**, room − 0.1 × ATR), so always ≥ ~19 points |
| **Thesis invalidation** | the first 5-min close back below L → exit at that close |
| **Breakeven** | after a 1-min close ≥ entry + **15**, the stop moves to entry + 2 from the next minute |
| **Stop** | the initial stop, on a 1-min close |
| **Time** | **60 minutes** after entry |

The option is sold at the minute the index exit happens.

### Risk controls (portfolio layer)

- One open trade per index.
- At most **2 trades per index per day**.
- **Stop that index for the day after 2 losing trades.**
- **15-min cooldown** after any exit.
- Size: 1 lot per trade (NIFTY 75, BANKNIFTY 30, SENSEX 20).

### Missing data

- No premium within 2 minutes of the entry → NO TRADE (counted).
- Sessions with < 300 index minutes are excluded.

### Costs

- **Base:** slippage max(₹0.5, 0.25%) per side + ₹40 per lot brokerage + statutory (0.1% of sell value + 0.04% of
  turnover).
- **Conservative:** base + 0.5% extra slippage per side **and** a 1-minute execution delay on entry and exit.

## 3. Evaluation protocol (pre-registered)

**Sessions:** 501 per index (2024-10-14 → 2026-10-23).
- **Chronological split:** DEV = the first 60% · VAL = the next 20% · TEST = the last 20%. One session is purged at each
  boundary.
- **DEV15:** the 15 sessions of 1–23 Oct 2026, used to develop the idea (they sit inside TEST).

**Primary out-of-sample (OOS) = VAL + TEST, excluding DEV15.** Nothing in the rules was tuned on these sessions.

**Contamination note:** earlier ProTrader studies looked at the same two years for other rules. This rule set was never
evaluated on them before.

**Outcomes:**
- **Index:** reach of +15 / 20 / 30 / 45 / 60 points before invalidation; MFE / MAE.
- **Option:** P&L, win rate (net > 0), expectancy, profit factor, max drawdown, at base and conservative costs.

**Comparisons, on the same sessions and the same cost model:**
1. **C2 baseline:** a faithful re-implementation, checked against the 121 Phase-1 trades, with its own E1 option exit.
2. **EMA baseline:** B0 / PT signals (NIFTY and SENSEX only; the study code has no BANKNIFTY support), with the LAX index
   exit.
3. **Simple benchmark (ORB):** the first 5-min close beyond the opening-range high / low by > 0.1 ATR between 09:30 and
   11:25, with no acceptance, freshness, room or chop rules. Same exit engine; stop = the breakout candle's extreme
   ∓ 0.1 ATR.
4. **Random benchmark:** every 5-min close between 09:35 and 11:30, both directions, stop 1 × ATR, same target / thesis /
   time rules (thesis level = the entry candle's open). Used for the reach-rate baseline.

## 4. Acceptance criteria (pre-registered; all on the primary OOS)

| # | Criterion |
|---|---|
| **A1** | Mean net per trade at **conservative** costs > 0, with the **95% day-clustered bootstrap lower bound > 0**. |
| **A2** | +15 reach before invalidation **≥ 60%**, and ≥ 10 percentage points above the random benchmark, with the bootstrap CI of the difference excluding 0. |
| **A3** | Profit factor at conservative costs **≥ 1.2**. |
| **A4** | Max drawdown at conservative costs (1 lot each, time order) **≤ 10 × the average losing trade**. |
| **A5** | **Repeatability:** conservative net > 0 in ≥ 2 of 3 indices **and** in ≥ 60% of the half-year blocks across all periods. |
| **A6** | **≥ 100 OOS trades.** |

**Verdict mapping:**
- **YES:** A1–A6 all pass.
- **PARTIALLY:** implemented, and a criterion fails or cannot be evaluated because of a stated data limitation.
- **NO:** the candidate fails on the evidence.

## Addendum (pre-registered 2026-10-25, before running): ITM1 monetisation test

**The change:** the only change is the option strike. Buy **1 strike in the money**: CE at ATM − step, PE at ATM + step.
Run with `LAX_STRIKE=ITM1`.

**Everything else is identical:**
- the signals, index exits and portfolio rules;
- the costs;
- the periods and the primary out-of-sample sample;
- acceptance criteria A1–A6.

**Reason:** the ATM option moved about 0.51 × the index, and break-even needed 4.7–13.8 index points per trade. An ITM
option has a higher delta.

**Verdict rule:** if A1–A6 do not all pass, LAX is dropped.
