# ProTrader: complete trading-logic audit (as of 2026-10-25)

**Scope.** Results quoted here come from the latest 15 sessions (1–23 Oct 2026) unless marked "2 years". Everything is
**exploratory, not validated**. The two-year Phase 2 test has **not** been run.

**Labels used throughout:**

| Label | Meaning |
|---|---|
| **LIVE** | Implemented in the app today (advisory only; no orders are placed). |
| **RESEARCH** | Exists only in `backend/research/…`. The app does not use it. |
| **PROPOSED** | Designed and tested, but not adopted. |

**Safety switches (LIVE):**
- `AI_MODE=ADVISORY_ONLY` and `LIVE_ORDER_EXECUTION=false`.
- Trade calls for NIFTY and SENSEX only.
- Every change to the live trading logic must first pass ProTrader's backtest and be logged in
  `backend/research/SUPERVISOR_LOG.md`.

---

## 1. Strategy architecture: from data to exit

### 1.1 Data ingestion and freshness

**LIVE:**
- **Feed:** Dhan v2 (quotes, option chain, intraday candles) via `backend/data/dhanProvider.ts`.
- **Data status:** each screen payload carries a data status (`api.ts:7729`):
  - `LIVE` if the last candle is ≤ 1.5 × its interval old;
  - `DELAYED` if ≤ 3 ×;
  - `STALE` beyond that.
- **The co-pilot acts only when `dataStatus === "LIVE"`** (`api.ts:9401`).
- **Fallback when Dhan's chart API is down** (as on 23 Oct): candles are rebuilt from recorded quote and chain ticks
  (`backend/data/liveBars.ts:97`, `fallbackCandles`).
- **Data Control** blocks requests from screens that are switched off.

**RESEARCH:**
- **Source:** Dhan `/charts/rollingoption` 1-minute data.
  - Index: close only, every minute.
  - ATM ± 3 option strikes: O / H / L / C, volume, OI and IV.
- **Cache:** `data/research-nifty20/raw1m` and `data/research-multi/SENSEX/raw1m`, refreshed daily at 15:50.

**Known gaps:**
- There are no 1-minute index highs and lows.
- A strike exists in the data only while it is inside the rolling ±3 band.
- The app's ±10-strike OI minute log is complete on only 6 of the 15 sessions.

### 1.2 Candle construction

**LIVE:**
- Dhan 5-min and 15-min candles.
- Only **closed** 15-min candles drive plan triggers and stops; forming candles are display only.

**RESEARCH:**
- 5 / 15-min candles are rebuilt from 1-minute closes, anchored at 09:15, 09:15–15:30 only.
- Only candles whose period has fully ended are used.
- Because only closes exist, wicks are slightly understated.

### 1.3 Market regime and choppy-market detection

**LIVE (gates that block new trades):**
- **Range day (P2, approved 18 Oct):** by the 10:15 close, the first hour broke one level up and one level down → no new
  trades that day (`api.ts:7916`).
- **Fast market (P5, approved 24 Oct):** the last 4 closed 15-min candles average ≥ 1.5 × ATR15 → no new trade
  (`copilot.ts:137`).
- **Plan conflict:** the Bear start is at or above the Bull start → stand aside.

**LIVE (warnings only, never block):** VIX high, fast or quiet market, expiry day, range day, trading against the trend
(`tradeCheck.ts:44`).

**RESEARCH:** the Market Regime Detector (`backend/research/regime/marketRegime.ts:85`).
- **Labels:** CHOPPY / TRENDING_UP / TRENDING_DOWN / COMPRESSION / TRANSITION / UNKNOWN_DATA.
- **Inputs:** efficiency ratio over 10 candles, ADX14 with ±DI, EMA21 slope ÷ ATR, VWAP crosses (TWAP proxy), ATR
  compression, premium agreement.
- **Status: NOT VALIDATED.**
  - 2 years: its trend calls were right 12–13% of the time, the same as the base rate and the simple EMA21 baseline.
  - Last 15 days: removing CHOPPY helped C2 a little (+₹459 vs +₹362 per trade).

### 1.4 Support / Resistance levels

**LIVE plan ladder** (`traderView.ts:116`):
- **Level types:**
  - previous-day high / low / close and floor pivots R1 / R2 / S1 / S2;
  - today's high / low (display only);
  - previous-week high / low;
  - trendlines through confirmed swings;
  - **OI walls** (largest call OI above spot, largest put OI below, plus the major call / put OI strikes).
- **Confluence:** levels of different kinds within 0.2 × ATR are flagged as confluence.

**RESEARCH "major" levels** (Phase 1 / C2):
- **PDH / PDL / PDC.**
- **Opening-range high / low**, from 09:30.
- **Owner S/R** (`priceActionLevels.ts:15`): clusters (within 0.2 × ATR15) of ≥ 2 confirmed 15-min swing points from the
  previous 5 sessions.
- **"Minor" levels:** intraday 5-min pivots (a high or low above the 2 candles on each side, confirmed 2 candles later,
  formed ≥ 30 minutes earlier).
- Every level is known before the signal candle.

**Difference:** the live ladder has pivots, weekly levels, trendlines and OI walls but **no opening range and no owner
S/R**. The research major levels have the reverse.

### 1.5 Breakout and rejection detection

**LIVE plan trigger** (`traderView.ts:151` and `:301`):
- **Zone:** the nearest level beyond the plan's anchor price. Levels within 0.75 × ATR15 of each other form one zone, at
  most 1 × ATR wide.
- **Start (entry level):** the far edge of the zone ± a buffer of max(1, round(0.1 × ATR15)).
- **Trigger:** a closed 15-min candle closes beyond the start.
- **Radar states:** IDLE → APPROACHING (≤ 0.3 ATR away) → ARMED (forming candle beyond) → TRIGGERED → FAILED (closed back
  past the trigger) or MISSED (already past Target 1).

**LIVE fake-move badge** (`analyst/fakeMove.ts:179`, display only):
- It looks at the last 4 candles with a 0.04% threshold.
- **CONFIRMED** means a close beyond the level followed by a close back.
- 2 years: no edge. In the audit it was right 31–36% at 1:1, the same as a random entry with the same stop.

**RESEARCH** (`srPhase1/phase1.ts`; ATR = ATR14 of 5-min index candles):
- **H1 rejection** (line 106):
  - the previous close was on the safe side;
  - the low comes within 0.1 × ATR of the level (or below it);
  - the candle closes at or above the level;
  - the lower wick is ≥ 40% of the candle's range and the close is in the upper half.

  Mirror rules apply at resistance.
- **H2 breakout** (line 109): a close beyond the level by more than 0.1 × ATR, coming from the other side.

### 1.6 Breakout acceptance

**LIVE retest rule** (approved 18 Oct; `copilot.ts:124`):
- After a 15-min trigger, the trade is given only if, **within 30 minutes**, a closed 5-min candle comes back to within
  0.25 × ATR15 of the broken level and closes still beyond it.
- Otherwise the result is "NO RETEST, NOT GIVEN".

**RESEARCH H2 acceptance:**
- The **next** 5-min candle closes beyond the level and its extreme does not re-enter by more than 0.1 × ATR.
- Entry is at that candle's close.
- **H2a** (entry on the breakout candle itself, without acceptance) was tested as the comparison.

### 1.7 OI positioning

**LIVE:**
- **Wall Builder** (`backend/oi/wallBuilder.ts:36`). Each strike's OI change over 1 / 5 / 15 minutes is typed:
  - W (write) = OI up, premium down;
  - B (buy) = OI up, premium up;
  - SC (short-cover) = OI down, premium up;
  - U (unwind) = OI down, premium down.

  It is labelled "positioning, not a forecast" (2 years: OI walls revert no better than any strike).
- **Trade review "OI flow" check** (`tradeReview.ts:14`).

**RESEARCH OI classification** (`phase1.ts:81`):
- **What it looks at:** the opposite-side option at the level strike, over the last 15 minutes (the last minute before
  t − 900 s vs the last minute before t).
- **Unknown:** missing data, or a gap > 1,500 s → `n/a`.
- **Flat:** |ΔOI| < 0.5% of OI → `FLAT`.
- **Otherwise:**

  | OI | Premium | Type |
  |---|---|---|
  | up | down | WRITE |
  | up | up or flat | BUY |
  | down | up | COVER |
  | down | down | UNWIND |

- **Limitation:** this is a price / OI inference, not proof of who acted. A rise in OI while the premium falls can also be
  buying into a falling premium.

### 1.8 EMA and premium momentum

**LIVE:**
- The option terminal shows the premium's EMA 9 / 21, swing structure (R1 / R2 / S1 / S2) and the pullback zone (display
  only).
- Trade review "premium confirming" = the trade-side premium is RISING.

**RESEARCH:** B0 / PT and its variants (`emaCrossStudy.ts`). See section 2.

### 1.9 Candidate selection and CE / PE direction

**LIVE co-pilot** (`api.ts:9466–9490`):
- **Bull plan → CE; Bear plan → PE.**
- **Before a trade is given:**
  - the trigger must be confirmed on 2 consecutive polls;
  - only between 09:30 and 14:30;
  - only one open trade per index, with a 15-minute cooldown after a close.
- **Trade review grade** (`tradeReview.ts:14`):
  - **Checks:** trend, 15-min close, not chasing, R:R, room, VWAP side, premium, OI flow, liquidity, arbiter, risk gates,
    time, break record, Market Eye, discipline (2 losses today → stop).
  - **Grades:** A (score ≥ 75) = normal size; B (≥ 60) = half size; C (or any critical check failed) = watch only.
- **Not given** (each reason is logged): INVALID PLAN (`tradeCheck.ts:12`), RANGE DAY, EXPIRY DAY, REVIEW C,
  CONFLICT, NO RETEST, LATE ENTRY, FAST MARKET.

**RESEARCH:** CE for an upside setup and PE for a downside setup, for every entry variant (section 2).

### 1.10 Entry timing and strike

**LIVE:**
- **When:** at the retest 5-min close (after the 15-min trigger).
- **Strike:** the chain strike nearest the plan's start level (`traderView.ts:151`).
- **P2 no-chase gate (approved 24 Oct):** no trade if the premium at the retest is more than 10% above its price at the
  trigger close (`copilot.ts:133`).

**RESEARCH:**
- **When:** at the close of the signal candle.
- **Strike:** ATM at that moment.
- **Price:** the premium's 1-minute close of the minute that ends at the entry time. No trade if that premium is more than
  180 s old.

### 1.11 Initial stop and target

**LIVE** (index levels, `traderView.ts:151`):
- **Stop:** start ∓ 0.5 × ATR15, judged on a **15-min close** beyond it.
- **Target 1:** the next level ≥ 0.5 × ATR beyond the start (or start ± 1 ATR if there is none).
- **Target 2:** the next level ≥ 0.5 × ATR beyond Target 1.
- **P9 (approved 18 Oct):** an OI wall in front of Target 1 becomes Target 1.
- **Shown alongside:** realistic risk = stop distance + 1 × ATR15 (`tradeCheck.ts:33`).

**RESEARCH (E1, the Phase 1 default):**
- **Stop:** SL0 = max(₹5, 1 × premium ATR14 of today's completed 5-min premium candles; ₹5 if fewer than 3).
- **Target:** 2 × SL0. **Time limit:** 60 minutes.
- **Alternatives tested:**
  - E2: target 3 × SL0;
  - E3: the owner's ₹5 / ₹40;
  - fixed +₹5 / 10 / 15 / 20 targets;
  - a trailing stop;
  - the three-plan engine (section 4).

### 1.12–1.14 PLAN 1 / 2 / 3, switching, profit protection, thesis exit

- **PROPOSED / RESEARCH only:** `srPhase1/c2Audit.ts:107`. Details in section 4.
- **LIVE equivalent (simpler):**
  - at Target 1, book half and move the stop to breakeven (entry spot, judged on a 15-min close);
  - exit the rest at Target 2;
  - a plan that closes back past its trigger becomes FAILED, and the radar says stand aside (`copilot.ts:69`).

### 1.15 Time-based exits

**LIVE:**
- No new trigger after 14:30. No retest after 14:45. Trade review: no new buys after 14:45.
- **Time exit at 15:12** (`copilot.ts:69`).
- **Expiry day:** normal plans are shown but not given. A separate paper "expiry mode" runs instead.

**RESEARCH:** exit after 60 minutes (E1 / E2) or by 15:15 / 120 minutes (trailing stop and the three-plan engine).

### 1.16 Costs, slippage, sizing and risk

**LIVE:**
- No orders are placed.
- Size guidance: A = normal size, B = half size.
- Discipline: stop for the day after 2 losses.
- Warnings in every message (VIX, fast market, expiry, against the trend, late).

**RESEARCH cost model** (ProTrader standard):
- **Costs:** max(₹0.5, 0.25% of premium) per side + ₹40 per lot (NIFTY lot 75, SENSEX lot 20).
- **Pessimistic stop fill:** min(stop, the minute's close).
- **Conservative:** pessimistic + 0.5% extra slippage per side.
- **Ambiguous** (target and stop touched in the same minute) = a stop.

### 1.17 Alerts and decision logs

**LIVE:**
- **Telegram kinds allowed** (`api.ts:9346`): plan, open913, best, oi15, trade, paper.
- **Logs:**
  - `data/copilot-log.txt`;
  - decision ledger `data/decision-ledger/<date>.jsonl` (`backend/decision/service.ts`);
  - "not given" reasons, stored and summarised at the 15:30 closing statement and daily review;
  - fake-up paper test: `data/paper-fakeup.json`.

**RESEARCH:** every verdict is logged in `SUPERVISOR_LOG.md`; results files are in `backend/research/protrader/`.

---

## 2. Entry strategies

All are RESEARCH unless marked. **Common elements:**
- **ATR:** ATR14 of 5-min index candles.
- **Entry:** at the signal candle's close, buying the ATM option.
- **Exit:** E1.
- **Results:** last 15 days, both indices, ₹ per lot after costs.

### B0: EMA baseline, "PT" (`emaCrossStudy.ts:91`)

- **Signal:**
  - the index 5-min close is on one side of its EMA 21 (continuous across days) and did **not** cross it on this candle;
  - the ATM option of that side (CE above / PE below) has its **premium EMA 9 cross above its premium EMA 21** on this
    candle.
- **Premium EMAs:** built from 5-min premium closes, joining the previous session unless that was an expiry day.
- **Timing:** signal closes from 09:20 to 14:30.
- **Strength:** no strong / moderate / weak grading is defined.
- **Result:** 76 trades, 31.6% target hits, −₹88 per trade, profit factor 0.85.
- **Failure modes:**
  - it is **late**: 74 of 76 signals came after the index had moved ≥ 2 ATR, and 32 came a median 15 minutes after a
    same-direction major S/R entry;
  - it loses after 12:30 and after an opposite signal.
- **2 years:** no edge (47–53% vs 49% random at 1:1).

### C1: rejection at a major level

- **Signal:** H1 (section 1.5) at a **major** level, with a rejection wick ≥ 60% of the candle's range, on a signal
  candle starting before 12:30.
- **Levels:** PDH / PDL / PDC, opening range, owner S/R.
- **Direction:** CE at support, PE at resistance.
- **Index stop:** the candle extreme ∓ 0.1 × ATR.
- **Rejects:** any minor (intraday) level; a wick under 60%; after 12:30.
- **Result:** 32 trades, 28.1% target hits, +₹445 per trade (+₹351 conservative), profit factor 1.91. 10 of the 32 ended
  as time exits.
- **Failure modes:**
  - opening-range-high rejections lost (−₹529 per trade, 8 trades);
  - SENSEX CE lost;
  - the sample is small.

### C2: breakout acceptance at a major level, without opposing OI (primary candidate)

Full detail in section 3.

### C3: filtered EMA

- **Signal:** B0, with the signal candle before 12:30 and no opposite B0 signal in the previous 60 minutes.
- **Result:** 40 trades, 37.5% target hits, +₹160 per trade (+₹63 conservative), profit factor 1.31.
- **Limitation:** the filters are on top of a late entry, and the edge almost disappears under conservative slippage.

### C4: fake-up + call writing + earlier touch (in the LIVE paper test)

- **Signal** (`fakeMoveGrid.ts`), all of:
  - the live detector reports a CONFIRMED fake-up (a close above the level, then a close back below, within 4 candles)
    at an **owner S/R** level;
  - over that window the ATM CE OI rose while the CE premium fell (call writing);
  - the level was touched ≥ 30 minutes earlier, within 0.15 × ATR.
- **Trade:** buy PE.
- **Result:** 13 trades, 61.5% target hits, +₹730 per trade, profit factor 3.28.
- **2 years:** held in all periods (61–81% vs a 54–55% baseline).
- **Status:** a forward paper test runs daily after 15:50 (`fakeUpPaper.ts`), with the verdict after about 30 signals.
- **Failure mode:** **the mirror fake-down at support loses** (−₹392 per trade); call writing added nothing beyond the
  plain fake-up in these 15 days.

### Other experimental entries (all RESEARCH, none adopted)

| Entry | Definition | Result |
|---|---|---|
| H2a | Breakout without acceptance | 15 days: +₹33 at major levels; acceptance adds about +₹270 per trade |
| H4 / M0, M1 | Index and premium price cross EMA 21 on the same candle / within 1 candle | 2 years: no edge |
| S0 / S2 / SS | Premium EMA 9 × 21 with an index EMA 21 break | 2 years: unstable |
| B8a / B8b | 8 / 26-point buffer beyond EMA 21 | Worse on its own |
| "Small candle" filter | Signal candle ≤ 1 ATR | NIFTY 52–57% vs 49% at 1:1; about breakeven on options |
| Fake-move variants A1–A9 | Stable side, ATR threshold, touches, 15m confirmation, volume / volatility, premium, OI, no-trade filter, follow-through | 2 years: no change passed |
| Grid of 22,304 combinations | — | Only C4's family held |
| Regime gate | CE only when TRENDING_UP, PE only when TRENDING_DOWN | Not validated |

---

## 3. C2: the complete original definition (unchanged)

**Code:** `srPhase1/phase1.ts` (H2 + filters), evaluated in `phase1Complete.ts` and `c2Audit.ts`.

### Levels and the breakout

1. **Major levels only:** PDH, PDL, PDC, opening-range high / low (from the 09:30 candle) and owner S/R from the
   previous 5 sessions. Intraday pivots are excluded.
2. **Breakout:** 5-min candle *i* (start 09:30–14:25), with the previous close on or below level L, closes above
   **L + 0.1 × ATR**. The breakdown mirror applies below support.
3. **One-candle acceptance:** candle *i + 1* closes above L, and its low stays above **L − 0.1 × ATR**.
4. **Entry:** at the close of candle *i + 1*, buying the ATM CE (PE for a breakdown).

### The opposing-OI filter

**Required:** the opposite-side option at the level strike shows WRITE or FLAT over the last 15 minutes.
- **Which strike:** for an upside breakout, the PE at floor(L / step) × step; for a breakdown, the CE at
  ceil(L / step) × step.
- **Excluded:** UNWIND, COVER and BUY.
- **Unknown (`n/a`) → no trade.** Ambiguity is never treated as support.

### De-duplication

- The first event per level, direction and day.
- An entry sitting on several levels at once counts as **one** trade.

### Verified result (E1 exit, 15 days)

**121 trades: 48 target / 60 stop / 13 time / 0 ambiguous.**
- 39.7% target hits.
- 48.8% net winners.
- **+₹362 per trade (+₹236 conservative).**
- Profit factor 1.63. Max drawdown ₹10,680.

### Behaviour by group (15 days; net per trade)

**By index and side:**

| | CE | PE |
|---|---|---|
| NIFTY (+₹419 overall) | +₹126 | +₹655 |
| SENSEX (+₹312 overall) | +₹168 | +₹436 |

**By level type:**

| Level | Net per trade |
|---|---|
| ORB high | +₹647 (58% target hits) |
| PDC | +₹1,119 |
| PDH | +₹346 |
| PDL | +₹390 |
| ORB low | +₹326 |
| **Owner S/R** | **−₹45** (36 trades) |

**By time of the breakout candle:**

| Time | Net per trade |
|---|---|
| 09:30–10:30 | +₹678 (70 trades) |
| 10:30–12:30 | +₹106 |
| 12:30–14:30 | −₹259 |

**By regime:** trending up +₹510, transition +₹392, **choppy −₹233**.

**Expiry day:** +₹18 vs +₹425 on other days.

### What is supported, and what is only a hypothesis

**Supported in these 15 days:**
- C2 beats random entry (−₹151 per trade) and the EMA baseline (−₹88).
- **Breakouts at major levels** beat the same breakout at all levels (+₹298 vs −₹56).
- **One-candle acceptance** beats entering on the breakout candle (+₹298 vs +₹33).

**Hypotheses only (in-sample, small groups):**
- the OI filter's extra value (+₹64 per trade);
- every level-type, time-of-day and regime split above.

**Why owner S/R and minor breakouts did poorly (interpretation, not proof):**
- Owner S/R levels are **turn** levels that price respects. They work for **rejections** (C1 +₹1,033) and **fake-ups**
  (C4), but price often stalls there, so breakouts through them fail.
- Minor intraday pivots break all the time (284 events); most are noise.

---

## 4. PLAN 1 / PLAN 2 / PLAN 3 (PROPOSED; exact implementation in `c2Audit.ts:107`)

### How it works

- **Decisions:** only at completed 5-min closes, using the index close, the premium close, the premium EMA 9 (seeded at
  the entry premium) and OI at the level strike over the last 15 minutes.
- **Between closes:** only the resting stop and limit can fill, on 1-minute premium highs and lows.
- **Stops only move up.**
- **SL0:** the initial stop distance, = max(₹5, 1 × premium ATR).

### State at each close (`stateAt`, line 117)

| State | Rule |
|---|---|
| **INVALID** | The index close is back through the breakout level → **exit at this close, in every plan** |
| **WEAK** | Any of: premium close < EMA 9 · index < 0.2 ATR beyond the level · opposite-side OI is UNWIND / COVER / BUY (`n/a` is ignored) · the nearest opposing major level is < 0.5 ATR away · time ≥ 14:45 |
| **STRONG** | All of: index ≥ 0.5 ATR beyond the level · premium close > EMA 9 · a premium closing high within the last 2 closes · ≥ 1 ATR of room (or no opposing level) · OI not against · time < 14:00 |
| **MODERATE** | Anything else |

### The three plans (`setOrders`, line 127)

| | **PLAN 1, Major** | **PLAN 2, Medium** | **PLAN 3, Minimum** |
|---|---|---|---|
| Selected when | STRONG at entry; or STRONG at 2 consecutive closes while in PLAN 2 and in profit (upgrade) | MODERATE at entry; or MODERATE while in PLAN 1 (downgrade) | WEAK at entry or at any later close (never upgrades) |
| Objective (resting limit) | entry + 3 × SL0 | entry + 2 × SL0 | entry + ₹M (M = ₹5 / 10 / 15 / 20 tested; ₹10 is the headline) |
| Stop movement | After a +1 × SL0 peak → entry + ₹1. After a +2 × SL0 peak → highest premium close − 1 × SL0 (trailing) | After a +1 × SL0 peak → entry + 0.25 × SL0. After a +1.5 × SL0 peak → entry + 0.75 × SL0 | Stop tightened to entry − 0.5 × SL0 |
| Exit at a close | INVALID | INVALID | INVALID; unrealised ≥ M (book); peak ≥ M but unrealised < M/2 (protect); WEAK at a 2nd consecutive close (deteriorating) |
| Switches | MODERATE → PLAN 2 · WEAK → PLAN 3 | WEAK → PLAN 3 | none |
| Always | exit by 15:15 or after 120 min | same | same |

**No contradictions:** INVALID is checked first in every plan, so no plan can hold a trade after its thesis is
invalidated.

### Result (same 121 C2 entries, 15 days)

| Exit | Net per trade | Win (net > 0) | Avg win | Avg loss | Profit factor | Max drawdown |
|---|---|---|---|---|---|---|
| **Baseline E1** | **+₹362** | 48.8% | ₹1,925 | −₹1,126 | 1.63 | ₹10,680 |
| Three-plan, M = ₹10 | +₹82 | 48.8% | ₹863 | −₹661 | 1.24 | ₹7,827 |
| Three-plan, M = ₹20 | +₹112 | 44.6% | ₹1,074 | −₹663 | 1.30 | ₹7,428 |

- **74 of 121 trades ended in PLAN 3.** The WEAK trigger fires on normal pullbacks.
- **Fixed +₹5 / +₹10 targets** reach 83% / 76% wins but **lose money** (−₹91 / −₹36 per trade).
- **Recommendation:** keep the E1 exit for C2. The three-plan engine is not adopted.

---

## 5. Not yet covered

The owner's brief was cut off at section 4 (PLAN 2). The remaining requested sections are not known and will be added
when received.

## 6. Improvement backlog (hypotheses; each needs ProTrader's test before any live use)

1. **Validate C2 exactly as defined on 2 years** (Phase 2, awaiting approval).
2. **Possible C2 entry refinements** (in-sample, must be pre-registered):
   - exclude owner S/R breakouts;
   - restrict to 09:30–10:30;
   - skip CHOPPY.
3. **Unify the level sets:** the live ladder has no opening range or owner S/R; the research major levels have no
   pivots, weekly levels or OI walls.
4. **Use the thesis exit as an alert** (a 5-min close back through the level preceded 25 of 62 C2 losses).
5. **Replace B0 / PT:** it is structurally late.
