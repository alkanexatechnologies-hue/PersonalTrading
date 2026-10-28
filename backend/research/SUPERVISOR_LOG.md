# ProTrader (supervisor) log

Every trading-logic change is reviewed by ProTrader (`.claude/agents/protrader.md`) before it goes
live. One entry per verdict, newest at the bottom.

## 2026-10-18 · Changes approved by the OWNER (before the supervisor gate existed)

These were approved directly by the owner after the 12–16 Oct comparison. They are not supervisor-reviewed and are
queued for its first review.

**Changes:**
- P8 plan lock
- fix 3 (duplicates by level, conflict → stand aside)
- P2 range day
- P7 no 5-min break alerts before 09:30
- P9 Target 1 at the OI wall in front

**Evidence:** current 11 trades, 55% wins, 4 SL → with the changes 7 trades, 71% wins, 2 SL. One week only, index points
before costs, no premium test.

**Status:** live since commit c7db560. **PENDING SUPERVISOR REVIEW** on ≥ 60 sessions with premium P&L.

## Open audit points for the supervisor (option-buyer audit, 2026-10-18)

1. Breakout entry has the weakest record (15-min upside breakouts: 28% follow-through), while sweeps did better.
2. No premium stop (Thursday: SENSEX 74200 CE fell −39% before the index stop).
3. Time decay and days-to-expiry are ignored (Friday: index +74, premium −6%).
4. No IV / VIX check.
5. NIFTY and SENSEX can both be open: one correlated bet, twice.
6. No ₹ position sizing or daily loss cap.
7. No event calendar.
8. Review weights and A/B/C cut-offs are unvalidated.
9. No trailing stop after Target 1.
10. Opening-drive days are always MISSED.

## 2026-10-18 · ProTrader premium backtest #1 (≈2 years, real Dhan premiums)

Details: `backend/research/protrader/RESULTS.md`.

- **System:** NOT PROFITABLE for an option buyer after costs.
  - Live logic B: NIFTY 484 trades, 37% win, −5.7% per trade, −₹1.50 L (1 lot).
  - SENSEX 508 trades, 40% win, −3.6% per trade, −₹1.05 L.
- **P2 range-day filter: APPROVE.** Better in development and validation for both indices, and lower drawdown.
- **P8 lock + fix 3: APPROVE** (bug fix).
- **P9 wall in front: NEED MORE DATA** (no OI history; the OI-minute log is accumulating).
- **−30% premium stop: REJECT** (helps NIFTY, hurts SENSEX in both periods).
- **Main loss driver:** 41% of trades hit the stop at −26.6% average. Entries after 14:00 and expiry-day entries are the
  worst. These are the next tests.
- **ProTrader advice to the owner until an edge is validated:** paper or minimum size only.

## 2026-10-18 · ProTrader premium backtest #2: four tests (`protrader/RESULTS2.md`)

- **APPROVE: skip the index's own expiry day + retest entry** (T2 + T3a).
  - Better in development and validation for both indices.
  - NIFTY: −₹1.50 L → −₹0.32 L. SENSEX: −₹1.05 L → −₹0.44 L.
  - SENSEX validation turned positive (+2.5% per trade). Drawdowns much lower.
  - **Implemented** in the co-pilot: an expiry-day trigger is shown but not given; a trigger becomes "waiting for the
    retest" (30 min), and the trade is given on the retest, else "no retest, not given".
- **REJECT:** no entry from 14:00 (not robust); wider stop (NIFTY worse); sweep entry (worse over 2 years).
- **Status:** not yet proven profitable. Paper or minimum size until forward results confirm.

## 2026-10-18 · Expiry-day study (`protrader/RESULTS_EXPIRY.md`)

**Requested by the owner:** do not simply skip the expiry day.

**What was tested:**
- 6 strategy families.
- A 24-version grid: chosen on development, judged on validation.

**Result:** no profitable expiry-day buyer strategy is validated.
- The pre-chosen pick failed validation (overfit).
- Expiry management roughly halves to quarters the loss, and lifts the win rate from 23% to 43–48%, compared with today's
  logic on expiry day.

**Verdict:**
- Live: expiry-day skip stays.
- Proposed to the owner: a labelled paper / minimum-size forward test of the EMA20-pullback ITM method.

## 2026-10-18 · Owner's decision: EXPIRY MODE as a paper / minimum-size forward test

The owner does not want expiry day skipped. Given the expiry study, the owner chose **"Expiry mode, paper / min size"**.

**Live rules** (`backend/premium/expiryMode.ts`):
- **When:** the index's own expiry day only. Entries 10:30–13:30, max 2, one at a time.
- **Entry:** EMA20 pullback with the day's trend, on a closed 5-min candle.
- **Strike:** one strike in the money.
- **Exits, on the premium:** −40% stop · half at 1.5× · then stop at the entry premium · rest at 2.5× · 40-min time
  stop · out by 15:15.
- **Label:** "EXPIRY MODE · PAPER / MIN SIZE", scored separately in the closing statement as "expiry-mode (paper)".
- **Normal plan triggers on expiry day** stay "shown, not given".

**Status:** NOT validated as profitable. Promote to normal size only if 6–8 forward expiries are positive after costs.

## 2026-10-18 · Owner's idea: "direction first, enter on the liquidity sweep" (`protrader/RESULTS_STRUCTURE.md`)

**Tested:** 7 versions plus a direction filter on the live logic.

**Verdict: REJECT, all versions.** None beats the live logic in development and validation for both indices. NIFTY stop
rate is 67% with candle stops; wider structural stops leave too few trades; the direction filter is worse per trade in 3
of 4 cells.

**Live logic unchanged:** plan trigger + retest entry, expiry-day plan trades not given (expiry mode is paper).

## 2026-10-18 · ProTrader daily routine set up (owner's request)

- **15:30 daily review** with the closing statement:
  - stop-loss reasons from the recorded facts (late entry, range day, review grade and failed checks, premium lost)
  - triggers shown but not given (no retest, range day, expiry day, review C, conflict)
  - the forward scoreboard, live and expiry mode (`data/protrader-forward.json`)
  - a BTSD reminder
- **15:50** silent data refresh (`refreshData.ts`).
- **Friday 16:05** weekly re-check (`weekly.ts`). The first dry run, data to 16 Oct:
  - NIFTY: 2-year −0.8% per trade; last 20 sessions +1.9%.
  - SENSEX: 2-year −2.8%; last 20 sessions −0.1%.
  - Both "in line with the long run".

## 2026-10-24 · Phase-2 proposals from the 19–23 Oct audit — backtest #3 (`protrader/RESULTS3.md`)

**Tested** (pre-registered, one change at a time vs the live co-pilot, real Dhan premiums 2024-10-01 → 2026-10-23,
NIFTY + SENSEX, development / validation): wider stop, hard touch stop, no chasing, premium targets, time filter,
fast-market skip, and no-chasing + fast-market together.

**Verdict:**
- **APPROVE P2 + P5 together:** at the retest, no trade if the premium is 10%+ above its price at the trigger close, or if
  the last 4 closed 15-min candles of the day average ≥ 1.5 × ATR15. Better in all four cells, fewer stop losses, lower
  drawdown. Implemented in `copilot.ts` (`chased`, `fastMarket`) + the co-pilot retest step; recorded as "not given"
  (LATE ENTRY / FAST MARKET) with a Telegram note.
- **REJECT** wider stop, hard touch stop, premium targets (half at +50%), time filter.

**Still not proven profitable** — paper / minimum size.

## 2026-10-24 · FAKE-DOWN / FAKE-UP label accuracy — owner asked for ~90 % on 5-min or 15-min (`protrader/RESULTS_FAKE_MOVE.md`)

**Tested:**
- the live detector on 2 years of NIFTY + SENSEX data, 5-min and 15-min candles, development / validation
- variants: follow-through, hold 2 bars, day-average side, higher-TF structure, their combinations, and a target sweep
- each against a same-stop baseline

**Verdict:**
- **NO EDGE.** Validation right % is about 54–65% on 5-min and 39–58% on 15-min, always within about ±3 points of the
  same-stop baseline; avg R ≈ 0 or negative.
- **90% is not reachable honestly:** a 0.25-ATR target gives about 80% right with negative avg R.
- **No change to live logic.** Keep the label as information only. Next: premium confirmation, and OI at the level once
  the 1-min OI log has 60+ sessions.

## 2026-10-24 · Candle-level breakdown / breakup for the fake-move label (`RESULTS_FAKE_MOVE.md` §3)

**Tested:** previous candle H/L, higher-TF candle H/L and day high/low as levels, on 5m and 15m, both as fake (reclaim)
and as break (two closes beyond).

**Verdict:**
- **NO IMPROVEMENT.** Fake is equal to or below the live levels. Break is within about ±3 points of the same-stop
  baseline; the few validation gains are absent in development.
- **No change to live logic.**
- **Side-by-spot quirk noted:** accepted breaks are almost never reported, and the "Swing High" wording is wrong. This
  is a display fix only.

## 2026-10-24 · Candle fake at support / resistance (`RESULTS_FAKE_MOVE.md` §4)

**Tested:** previous-candle fake-down / up counted only near a live S/R level or an owner S/R level (0.3 / 0.15 ATR),
or together with the live-level fake, on 5m and 15m, NIFTY + SENSEX, development / validation.

**Verdict:**
- **NO IMPROVEMENT.** The best development cell, SENSEX 5m at both S/R types (68.5% vs 57.1%), falls to 34.0% vs 53.6%
  in validation.
- NIFTY 15m fake-up at owner S/R is +2 / +5 points on n ≈ 70, and SENSEX does not confirm it. Watch only.
- **No change to live logic.**

## 2026-10-24 · Fake-move grid search, 22,304 combinations (`RESULTS_FAKE_MOVE.md` §5)

**Tested:** every combination of up to 3 of 16 filters, fixed 1 : 1 scoring, selection on development only.

**Verdict:**
- **80% not reachable reliably.** The development → validation correlation of the edge is 0.11.
- **One family held** in development and both validation halves on both indices: **5m FAKE-UP at an owner S/R
  level + call writing + level touched earlier today**. It was right 61–81% vs a 54–55% baseline, +0.17 to +0.50 R,
  and the ATM PE gained +3.7% to +14.8% per trade before costs.
- **The mirror FAKE-DOWN fails.**
- **PROMISING, NOT APPROVED:** it was picked from 22k rules, has a small n, and works one way only. Forward paper test
  first; no change to live logic.

## 2026-10-24 · Quantitative audit of the live fake-move detector (`protrader/RESULTS_FAKE_AUDIT.md`)

**Baseline reproduced exactly:** 70,103 evaluations, 0 mismatches vs the live functions.

**Results:** 1:1 trade precision DEV 31.0% / VAL 36.0% / TEST 32.8%, equal to the same-stop baseline. Net after costs
−8.4% / −6.5% / −4.8% per trade, with CIs below zero.

**Reconciliation:** the earlier 55–60% comes from a 1-ATR target vs a 2.2-ATR median stop.

**Ablations:** none of 13 one-change variants passed the pre-registered DEV gate (≥ +3 points, n ≥ 100). Nothing
was frozen.

**Main false-positive source:** breaks ≥ 1 ATR (85% of signals; level picker tolerance + side by spot). The confidence
score is anti-calibrated (100 → 28.6%).

**Verdict:**
- **REJECT** as a trade signal.
- 90% is not supported; the best validated precision is 50.3% [44.8–55.8], 1.6 signals per session, no DEV support.
- Display-only proposals go to the owner.
- No live code changed.

## 2026-10-25 · Index EMA 21 break + premium EMA 9/21 cross (`protrader/RESULTS_EMA_CROSS.md`)

**Owner's question:** the win probability.

**Results:**
- **Alone:** 47% at 1:1, the same as random; −2% per option trade after costs.
- **With the same-candle premium cross:** DEV 60% → VAL 37.5% → TEST 53% (n 91 / 32 / 15). Pooled 54%, unstable,
  and the option net is about 0 or negative.

**Verdict:** NO EDGE. Information only; no change to live logic.

## 2026-10-25 · ATR / volatility filters on the EMA 21 + premium cross (`RESULTS_EMA_CROSS.md`, last section)

**Results:**
- **Nothing frozen.** NIFTY M1 + signal candle ≤ 1 ATR wins 52–57% vs about 49% random in DEV / VAL / TEST, but the
  option net after costs is −1.5% / 0.0% / −0.8%.
- **SENSEX failed TEST.**
- **Expanding ATR is the worst condition.**

**Verdict:** no change to live logic. Information only.

## 2026-10-25 · Owner's 8-point buffer beyond EMA 21 (`RESULTS_EMA_CROSS.md`, last section)

**Results:**
- **The buffer alone hurts** (−1 to −4 points vs random).
- **NIFTY M1 + candle ≤ 1 ATR + buffer:** 54 / 56 / 64% vs about 49%. Built after TEST of the base had been seen, so
  TEST is not untouched. Small n; option net about breakeven.
- **SENSEX fails.**

**Verdict:** no change to live logic. Forward-test candidate only.

## 2026-10-25 · PT: premium EMA 9 × EMA 21 trigger with the index already past EMA 21 (owner's 19 Oct example)

**Results:**
- **SENSEX:** 50 / 54 / 60% vs about 49% random; option net about 0.
- **NIFTY:** 47 / 50 / 53%; no DEV edge.
- **Not stable across indices.**

**Verdict:** no change to live logic. SENSEX forward-test candidate only.

## 2026-10-25 · Market Regime Detector, research (`protrader/RESULTS_REGIME.md`)

**Built:** a pure classifier (ER, ADX / ±DI, EMA slope / ATR, VWAP crosses, compression, premium agreement; configurable
unvalidated thresholds) with 11 unit tests.

**Validation:** 19,400 points, DEV / VAL / TEST.
- Trend calls are right 12–13% vs a 12–13% base rate and the EMA21 baseline's 13%. Chop calls are right 45–51% vs a
  50% base.
- No feature adds value in the ablations.

**PT regime gate:** DEV NIFTY 63% vs 47%, but VAL 46% vs 50% → not robust.

**Verdict:** NOT VALIDATED. Research only; no live change.

## 2026-10-25 · Fine-tuning the PT logic, 2 years (`protrader/ptSl5/RESULTS_PT_IMPROVE.md`)

**Diagnosis:** the ₹5 stop = 0.45 × NIFTY and 0.12 × SENSEX premium ATR; about half the stopped trades reached +40
later.

**Variants:** stops sized by premium ATR raise the win rate (SENSEX up to 40–47%) but nothing is profitable in DEV.
The owner's SL 5 / T 40 is negative in DEV and VAL on both indices (the last 15 days were favourable). A pullback limit
entry is worse. Index-candle agreement helps SENSEX in every period, but DEV is still negative.

**Verdict:** REJECT for live use. No change. The entry signal lacks an edge after costs.

## 2026-10-25 · FINAL 15–60 index-point candidate LAX (`protrader/final1560/`)

**Setup:**
- **Pre-registered:** commit `789102f`, before evaluation.
- **Data:** NIFTY / BANKNIFTY / SENSEX, 2024-10-14 → 2026-10-23.
- **Periods:** DEV / VAL / TEST; the primary out-of-sample (OOS) excludes the 15 development sessions.
- **Engine check:** the C2 re-implementation reproduces Phase 1 exactly.

**Results:**
- **LAX OOS:** 323 trades; +15 reach 61% vs random 52%; net −₹143 per trade; conservative −₹226 [−322, −142]; PF 0.50;
  all indices and half-years negative.
- **Acceptance:** 1 of 6 criteria pass.
- **C2 two years (own exit):** −₹146 per trade. EMA −₹92, ORB −₹167, random −₹146.

**Diagnosis:** a real but small directional bias. The exits capture +2.3 index points per trade on average vs a
break-even of 4.7–13.8 points, after ATM option delta (~0.51) and costs (~₹143 per trade).

**Verdict:** REJECT. No live change.

**Next:**
- pre-registered ITM / spread monetisation and one trailing exit;
- C4 paper results;
- OI-wall tests after 60+ sessions of the ±10 OI log.

## 2026-10-25 · LAX ITM1 monetisation test (pre-registered, commit `4d323df`)

**Change:** only the strike (1 in the money).

**Primary OOS:** conservative −₹239 per trade [−345, −147] vs −₹226 at ATM; PF 0.51; 0 / 3 indices and 0 / 5 half-years
positive. 1 of 6 criteria pass.

**Verdict:** REJECT. LAX is dropped, as pre-registered. No live change.

## 2026-10-24 · C4 audit: existing rule replayed over 2 years with costs (`protrader/RESULTS_C4_AUDIT.md`)

**First net-after-costs figures for C4:**
- 299 signals (NIFTY + SENSEX); +₹265 per trade; conservative +₹193; PF 1.47 / 1.33; max DD (conservative) ₹20,027.
- DEV +₹210 / VAL +₹371.
- Half-years: 2024-H2 −₹150 · 2025-H1 −₹13 · then +₹353 / +₹499 / +₹355.

**Caveats:** the rule was selected from 22,304 combinations, so these figures carry selection bias.

**C2 direction filter:** no added value (C2 DOWN +₹278 vs C2 UP +₹281).

**Live paper records:** none yet (the test starts 2026-10-26).

**Verdict:** CONTINUE PAPER TESTING. Not a proven edge.

## 2026-10-25 · C4 shown live on Market Command (owner's request) — display only, rule unchanged
- **What:** `premium/c4Live.ts` evaluates the unchanged C4 rule at each closed 5-min candle (NIFTY, SENSEX); `/api/c4-live`;
  a C4 card under Key Levels; an amber "▼ C4 PE" mark on the main chart (owner approved this one main-chart addition).
- **Rule parity:** `c4Live.test.ts` replays 120 real sessions per index; the live scan fires on exactly the research
  signals (39 NIFTY, 44 SENSEX: same candle, level, entry, stop). Live-feed spot check: NIFTY 21 Oct 09:55, 22 Oct 11:50,
  SENSEX 21 Oct 10:05 reproduced; 23 Oct none (as research).
- **Not a logic change:** no entry, exit, plan or co-pilot behaviour changed; the card states the tested record and
  "positive result, not a proven edge". Verdict on C4 itself still waits for 30 live paper signals (from 26 Oct).

## 2026-10-28 · TP27 "premium W at a key level" (the experienced trader's 27 Oct calls as a rule) — `protrader/traderPattern.ts`

**Proposal (written before the run):** ATM option, 3-min candles. The premium makes a base ≥ 20 % under its session high,
then a green engulfing / strong candle closes within 30 % of the base, while the index's 15-min extreme sits at a key
level (PDH / PDL / PDC, first-15-min high / low, call wall for PE / put wall for CE). Stop = base × 0.98, target 2R,
time exit 15:15.

**Data:** Dhan 1-min rolling options, NIFTY 503 / SENSEX 502 sessions (2024-10-14 → 2026-10-27), DEV ⅔ / VAL ⅓.

**Result (after costs, ₹ per lot):**
- 1,760 trades; 522 target / 1,157 stop / 81 time; win 32.7 %; −₹137 per trade (conservative −₹285); PF 0.82.
- Negative in DEV (−₹92) and VAL (−₹222), and for NIFTY and SENSEX on their own.
- Without the level (control) −₹159: the key level adds about ₹22 per trade, not an edge.
- Best sub-groups, both picked after the fact: put wall DEV +₹177 → VAL −₹113; PDH DEV +₹35 → VAL −₹97. Neither holds.
- The rule does catch 27 Oct: 22800 PE at 10:15 and 22750 CE at 10:00 both hit target.

**Verdict:** REJECT. No live change. The trader's results come from selection the rule cannot see (which days, which
bases). Next step: log the trader's calls forward, with the context at each call, and re-test after 30+ calls.

## 2026-10-28 · "One Trade" — fixed 1:2 target, one trade at a time across NIFTY + SENSEX — `protrader/oneTradeStudy.ts`

**Owner's request:** a single 🎯 One Trade tab: the system picks the best trade, no new trade until the open one is
closed, target fixed at 1:2.

**Proposal (written before the run):**
- Entries unchanged: the approved co-pilot plan (15-min close beyond the start, 5-min retest within 30 min, 14:45 cut-off,
  expiry-day and range-day skips).
- Exit change: one full exit at entry ± 2 × (entry − plan stop) on the index, instead of T1 half + T2 / breakeven.
  The stop stays the plan's 15-min close; time exit 15:12.
- Across NIFTY + SENSEX, a trade is taken only after the previous one closed.

**Data:** real Dhan 1-min index + ATM premiums, 2024-11-19 → 2026-10-26, 298 sessions with trades. DEV before
2025-10-28, VAL after. Net of costs, ₹ per lot.

**Result:**

| | LIVE (T1/T2) | FIXED 1:2 |
|---|---|---|
| NIFTY DEV / VAL | −₹192 / −₹127 | −₹146 / −₹7 |
| SENSEX DEV / VAL | −₹341 / −₹26 | −₹309 / −₹4 |
| One at a time, both · DEV / VAL | −₹274 / +₹23 (PF 0.67 / 1.03) | −₹226 / **+₹106 (PF 0.74 / 1.15)** |
| Win % (one at a time, all) | 36.8 % | 44.6 % |

The 1:2 exit is better than LIVE in every split, for both indices and in both halves. One-at-a-time changes little,
but it removes the clashing second trade.

**Verdict:** APPROVE for the One Trade tab (fixed 1:2, one at a time). This is better than the current exits, but it is
not a proven edge: the DEV year is still negative after costs. The tab must say so. The Telegram co-pilot's T1/T2
messages are not changed by this verdict.

## 2026-10-28 · "Three trades" — the 28 Oct best day as a rule (owner: "I need that strategy", 3 lots) — `protrader/threeTradesStudy.ts`

**Proposal (written before the run):** keep the approved plan entry (15-min close + retest), and add two entries.
- **Sweep-reclaim:** a 5-min candle trades through a ladder level and closes back inside; stop beyond the wick.
- **Day-range breakout:** the first 5-min close beyond the session's high or low so far, 10:30–14:30; stop at the
  candle's other end.

All entries use a fixed 1:2 target, one trade at a time across NIFTY + SENSEX, a 14:45 cut-off and a 15:12 exit.

**Data:** real Dhan 1-min data, 2024-11-19 → 2026-10-26. DEV / VAL split. Net of costs, 3 lots.

**Result (one at a time, both indices):**

| | Trades | Win % | ₹ / trade (1 lot) | 3 lots, 2 years | Worst drawdown (3 lots) |
|---|---|---|---|---|---|
| One Trade 1:2 (approved) | 404 | 44.6 % | −₹67 (VAL +₹134) | −₹80,886 | −₹2.07 L |
| + sweep | 1,064 | 41.4 % | −₹148 | −₹4.72 L | −₹5.40 L |
| + breakout | 725 | 41.2 % | −₹106 | −₹2.31 L | −₹2.89 L |
| **Three trades** | 1,228 | 40.2 % | **−₹168** (DEV −₹205 / VAL −₹128) | **−₹6.20 L** | **−₹6.69 L** |

By entry type inside "three trades":
- **Sweep:** −₹167 / −₹92 (DEV / VAL).
- **Breakout:** −₹322 / −₹170.
- **Plan:** −₹216; it loses its best slots to the earlier sweep trades.
- Removing the range-day skip does not help (−₹146).

**Verdict:** REJECT. No live change. 28 Oct was a day when all three worked, but over two years the sweep and
breakout entries lose after costs in both halves, and they push out the approved trade. The lesson page keeps the day
as a learning example, labelled as hindsight.

## 2026-10-28 — 🗺️ Scenario Map odds (research + display, no live-logic change)
Owner asked for a probability chart of the next session: gap down / up 50–100, which level holds / breaks / recovers, liquidity
sweeps, and where a 40-point trade is. `scenarioStudy.ts` measured these on real Dhan 1-min data (2024-11 → 2026-10, 488 sessions
per index, DEV / VAL halves) → `premium/scenario-stats.json`, `RESULTS_SCENARIO.md`. Display only (One Trade tab); the co-pilot and
One Trade entry rules are unchanged, so no gate verdict is needed. ProTrader notes for the screen: every level type breaks more
often than it holds (hold 24–38%, break 50–65%), sweep-then-hold is only 10–24% — "levels ≈ coin flip, the reaction matters"
again. Setups positive in BOTH halves (≥ 8 trades each, before premium costs): NIFTY gap-up OR-high break long (+11.4 / +8.2 pts)
and OR-high sweep short (+12.3 / +7.3), NIFTY gap-down OR-low break short (+7.7 / +3.7), NIFTY PDH rejection short (+4 / +8.3) and
PDH break long (+5.3 / +4); SENSEX gap-up OR-high break long (+10 / +15.5). Samples are small (11–42 per half) — shown as
"✅ consistent", not approved entries; trades stay on the One Trade signal.

## 2026-10-29 · OWNER OVERRIDE: expiry-day plan trades are given again
The owner chose to allow the normal plan's trades on the index's own expiry day (option 3 of 3 offered), after being shown
the evidence: backtest #2 (APPROVE skip, 2026-10-18) and the expiry study (no expiry-day buyer strategy validated; the
normal plan lost ~23.6% / ~11% per trade in development / validation on NIFTY expiry days, ~8.5% per trade on average).
ProTrader's view is unchanged: **not recommended**. As the owner's decision it is implemented with safeguards:
- `EXPIRY_PLAN_TRADES = true` in routes/api.ts (one switch; false restores the skip).
- Same entry path as any day: 15-min close → 5-min retest within 30 min → Trade Review A/B → no chase (10%) → no fast market.
- Labelled **⚠️ EXPIRY DAY · HIGH RISK — 1 lot only** on Telegram (trigger + trade given), the Premium Center chip and
  the One Trade feed. EXPIRY MODE (paper / min size) keeps running alongside.
- Tracked: the trades land in the co-pilot / One Trade history (local SQL tables app_copilot_trades / app_one_trade) so
  the expiry-day results can be reviewed after 6–8 expiries.
