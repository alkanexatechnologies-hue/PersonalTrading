# Autonomous Paper-Trading Engine - Logic Document

This document describes how the built-in **paper-trading engine** works: how it
opens and closes simulated trades automatically, how it sizes positions, and
every rule that protects capital. It is a *simulation* - no real orders are ever
placed. Source: `src/paper/engine.ts`. Wiring / data feeds: `src/routes/api.ts`.

---

## 1. Purpose

You define two starting amounts in the morning - one for **options (FNO)** and
one for **swing** trades. For N trading days (default 20) the engine runs
completely autonomously during market hours:

1. Pulls fresh trade "ideas" from the same models that power the dashboard.
2. Applies safety gates, opens trades that pass, sizes them by risk.
3. Marks every open position to market each second (with theta decay).
4. Exits on target / stop / decay / stall / trend-reversal / OI-flip / EOD.
5. Records realised & unrealised P&L, writes a per-trade "why" remark.
6. Persists everything to disk (`data/paper-state.json` + CSVs).

No human input is needed after you press **Start** with your capital.

---

## 2. Capital, pools and run length

- Two independent pools: `option` and `swing`, each with `startCapital` and
  live `cash`.
- `days` = number of trading days the run lasts (default 20). A day is counted
  once per unique IST calendar date the engine ticks on.
- The run ends (sets `active=false`) when `tradingDaysElapsed > days`, or when
  the total-profit target is hit (see 7).

---

## 3. Data feeds (dependency injection)

The engine itself is pure logic. All live data is injected via `TickDeps` from
`api.ts`, so the engine never calls the network directly. Key providers:

| Dependency | What it supplies |
|---|---|
| `getSpot(symbol)` | Current underlying price (Groww live). |
| `getOptionIdeas()` | Safety-gated option plays from the 15-min hourly model. |
| `getSwingIdeas()` | Breakout/swing candidates. |
| `getZeroHeroIdeas()` | Deep-OTM index lottery ideas (expiry only, Groww only). |
| `getOiBias(symbol)` | Live OI verdict: Bullish / Bearish / Neutral. |
| `getRegime(symbol)` | Trend vs Range + direction + ADX (from 15m ADX). |
| `marketOpen`, `minutesIST`, `istDate`, `nowEpoch` | Time / session context. |

Each option idea carries: strike, premium, premium target/stop, spot
target/stop, lot size, expected move %, **confidence** (0-100), theta %/day,
DTE, and a human `strikeReason` (why that strike - OI liquidity + delta + theta).

---

## 4. Two engine entry points

- **`markPaper(deps)`** - fast mark-to-market, called ~every second by the UI.
  Refreshes open-position prices and processes **target/stop exits only**. No new
  entries, no day counting. Safe to call at high frequency.
- **`tickPaper(deps)`** - the full cycle (default hourly + on demand): day
  counting, all exit rules, then new entries. This is where trades are opened.

---

## 5. Entry rules (when a new trade is opened)

### 5.1 Timing and frequency gates
- **Options open from 9:20 AM IST**; **swing from 9:30 AM IST**
  (`OPT_START_MIN` / `SW_START_MIN`). Analysis is visible earlier on the tabs,
  but the engine won't *open* before these times.
- **Max 3 new trades per day** (`MAX_TRADES_PER_DAY`), shared across options +
  swing. Zero-hero is a separate bucket (see 8) and is NOT counted here.
- **30-minute throttle** between entries of the same vertical
  (`lastOptEntryEpoch` / `lastSwEntryEpoch`), and the throttle only arms after a
  *real* entry.
- Max concurrent positions: **2 options** (`MAX_OPT`), **3 swing** (`MAX_SW`).
- No new entries at/after EOD (`minutesIST >= 920` -> ~15:20 IST).

### 5.2 Option quality gates (each idea must pass ALL)
1. **Not already held** for that symbol.
2. **Near-expiry filter:** skip if `dte <= 1` *unless* `confidence >= 80`
   (only a very high-conviction, fast move can beat brutal expiry-day theta).
3. **Range-bound gate:** if `getRegime` says the underlying is `Range`, skip -
   a bought option in a choppy market just bleeds theta.
4. **Confirmation floor:** `confidence >= 55`. Below that the multi-factor
   signal (technicals + OI + futures + index alignment) is treated as a possible
   bluff/trap and skipped.
5. **Clean-move gate** (`CLEAN_MIN = 45`): options are only bought on stocks that
   trend **cleanly**. Each idea carries a clean-move rating (Kaufman efficiency +
   ADX + move size + follow-through, minus choppiness/whipsaw); anything below 45
   is skipped because a choppy underlying bleeds theta even when it moves. Ideas
   arrive sorted cleanest-and-highest-conviction first (blend of clean rating,
   confidence and expected move), so the best clean movers are taken first within
   the per-day cap. The chosen grade is recorded on the position/strike note.

6. **Reward:risk floor** (`OPT_RR_MIN = 1.3`): an option trade is only taken if
   its target payoff is at least 1.3x the risk to its stop. Poor-payoff setups
   are skipped.
7. **Portfolio-heat cap** (`HEAT_CAP_PCT = 6%`): the sum of open risk across ALL
   positions may not exceed 6% of combined starting capital. New trades that
   would breach this are skipped, so total exposure stays bounded.

### 5.3 Option position sizing (risk-based, confidence-scaled)
- Risk per trade = `1% of option startCapital` (`RISK_PER_TRADE`) times a
  **confidence scale** `confScale = clamp(confidence / 75, 0.6, 1.3)`.
  Weaker (55-65%) signals get smaller size; strong (85%+) get larger.
- `lossPerLot = (premium - premiumStop) * lotSize`.
- `lots = floor(risk / lossPerLot)`. If that rounds to 0 but a single lot's risk
  is `<= 5% of the pool`, allow **1 lot** (one index lot often exceeds a strict
  1% cap on a modest account).
- Reject if the premium outlay exceeds available `cash`.

### 5.4 Swing quality gates and sizing
- Enter at the **current** market price (not the stale breakout trigger).
- Reject if price is already at/through the stop or past the target.
- Require **reward:risk >= 1.5:1** from the current price.
- `riskPerShare = max(0.05, price - stop)`; `qty = floor(1% of swing capital /
  riskPerShare)`; reject if `qty < 1` or cost exceeds cash.

---

### 5.5 Realistic execution costs

Paper P&L is booked **net of costs and slippage** so it isn't rosier than live:

- **Slippage:** ~0.4% of premium per side on options (`OPT_SLIP`), ~0.05% on
  equities (`EQ_SLIP`).
- **Charges:** brokerage (~Rs 20/leg), STT, exchange transaction fee, GST, and
  stamp duty - a simplified but representative Indian F&O / equity cost model
  (`tradeFriction`).

Each closed trade records `grossPnl`, `costs`, and net `pnl`; the summary shows
total costs paid, and the CSV export includes gross vs net.

## 6. Exit rules (how a trade is closed)

Every tick, each open position is marked and evaluated. Options use
`evalOptionExit`, checked in this order:

1. **Target** - spot reaches `spotTarget` -> exit at `premiumTarget`.
2. **Stop** - spot reaches `spotStop` -> exit at `premiumStop`.
3. **Trailing profit-protect** - once the mark ran to `>= +40%` (`TRAIL_ARM`)
   then gave back to `+12%` (`TRAIL_GIVE`), lock the win (`reason: trail`).
4. **Decay cut** - if the marked premium bleeds to `<= 80%` of entry
   (`DECAY_CUT`, i.e. -20%), cut it early rather than waiting for the spot stop.
5. **Stall** - after `30 min` (`STALL_MIN`) if spot has moved `< 25%`
   (`STALL_PROGRESS`) of the way toward target, exit before theta eats more.
6. **OI flip** (in `tickPaper`) - if live OI bias flips **against** the position
   and price isn't following (favourable move < 50% of expected), cut it.
7. **Trend reversal** (in `tickPaper`, non-zero-hero) - if `getRegime` direction
   flips against the position and the trade is **not in profit**, cut it
   (`reason: reversal`). This is the "extra check on a reversed direction."
8. **EOD** - intraday options are flattened near close; never held overnight.
9. **End** - run finished.

**Option mark-to-market** (`optionMark`): premium is interpolated linearly
between entry and the target anchor as spot moves, **minus theta decay** scaled
to the fraction of the trading day held (`thetaPctPerDay` x heldFraction). Floor
of 0.05 so a premium never goes negative.

**Swing exits:** target hit, stop hit, or max hold of **10 trading days**
(`SWING_MAX_HOLD`), or run end.

---

## 7. Portfolio-level profit target

After exits each tick, `bookIfProfitTarget` checks total equity (cash + marked
open positions across both pools). If it reaches **+15%** of combined starting
capital (`PROFIT_TARGET_PCT`), the engine **books every open position** at its
current mark and **stops the run** (`reason: profit`). This locks the gain
rather than risking a give-back.

### 7.1 Loss circuit breakers (symmetric capital protection)

Two downside breakers mirror the profit target:

- **Max-drawdown kill switch** (`bookIfMaxDrawdown`, `MAX_DRAWDOWN_PCT = 10%`):
  if total equity falls to **-10%** of combined starting capital, the engine
  books every open position at its mark and **stops the run** (`reason: risk`).
  Checked every tick *and* every 1-second mark-to-market, so it fires promptly.
- **Per-day loss cap** (`dailyLossCapHit`, `DAILY_LOSS_CAP_PCT = 3%`): once the
  day's **realised** loss (sum of trades closed today) breaches **-3%** of
  starting capital, the engine **halts all new entries** for the rest of that day
  (options, swing and zero-hero). Open positions are still managed and exited
  normally - it stops digging, it doesn't abandon existing trades.

Both thresholds are surfaced in the summary (`todayRealisedPnl`,
`dailyLossCapHit`, `maxDrawdownPct`) and shown on the Paper Trading tab as a
"Capital guard" line.

---

## 8. Zero-Hero lottery (separate bucket)

Once per day (`zeroHeroToday`), from 9:20 AM, the engine may take **one** small
deep-OTM index bet (NIFTY/BANKNIFTY/SENSEX), expiry-only, with a directional
bias. Rules:

- **Stake = 2% of option capital** (`ZH_BUDGET_PCT`) - this is the *max loss*,
  since a zero-hero can expire near zero. Lots scale up with account size.
- **Hard cap 5%** of the pool (`ZH_HARD_CAP_PCT`) and available cash.
- **Not counted** against the 3-trades/day cap.
- Held to **target / -60% / expiry** - deliberately NOT cut on small decay,
  because a lottery needs room. Exception: if after ~2 hours the index has moved
  `< 15%` toward the strike, it's cut early (`stall`) to stop pure theta bleed.

---

## 9. Why-it-won/lost remarks

Every closed trade gets a plain-English `remark` (`buildRemark`) describing the
spot move, whether direction was right, and which rule closed it (target, stop,
decay, stall, trail, profit, reversal, eod, time, end). It also records
`capturedPct` = realised P&L as a % of the projected potential - how much of the
expected move you actually captured.

---

## 10. Persistence and daily review

On every `save()`:

- **`data/paper-state.json`** - full engine state (pools, open, closed, counters).
- **`data/paper-trades.csv`** - every closed trade: entry/exit IST timestamps,
  entry->exit price, P&L, P&L %, exit reason, remark.
- **`data/paper-daily.csv`** - per-day summary: trades, wins/losses, gross
  profit, gross loss, net P&L, worst trade, win rate.

`dailyReview()` (API `/api/paper/daily`) groups closed trades by the IST date
they closed on and reports per-day gross loss, net, worst single trade, and
overall totals (net, total loss, loss-day count, worst day). This answers "how
much loss happened daily" and feeds evening backtesting.

---

## 11. Key constants (tuning knobs)

| Constant | Value | Meaning |
|---|---|---|
| `MAX_TRADES_PER_DAY` | 3 | New trades/day (ex zero-hero). |
| `MAX_OPT` / `MAX_SW` | 2 / 3 | Max concurrent option / swing positions. |
| `OPT_START_MIN` / `SW_START_MIN` | 9:20 / 9:30 | Earliest entry times (IST). |
| `RISK_PER_TRADE` | 1% | Risk per trade of that pool. |
| Confirmation floor | 55 (80 if dte<=1) | Min confidence to trade. |
| `CLEAN_MIN` | 45 | Min clean-move rating of the underlying for an option buy. |
| `OPT_RR_MIN` | 1.3 | Min reward:risk for an option entry. |
| `HEAT_CAP_PCT` | 6% | Max total open risk across all positions. |
| `OPT_SLIP` / `EQ_SLIP` | 0.4% / 0.05% | Per-side slippage (option / equity). |
| `DECAY_CUT` | 80% | Cut option at -20% premium. |
| `STALL_MIN` / `STALL_PROGRESS` | 30 min / 25% | Cut a non-progressing trade. |
| `TRAIL_ARM` / `TRAIL_GIVE` | +40% / +12% | Trailing profit-protect band. |
| `PROFIT_TARGET_PCT` | 15% | Book-all & stop target. |
| `DAILY_LOSS_CAP_PCT` | 3% | Halt new entries once day's realised loss breaches this. |
| `MAX_DRAWDOWN_PCT` | 10% | Book-all & stop the run (kill switch). |
| `SWING_MAX_HOLD` | 10 days | Max swing hold. |
| `ZH_BUDGET_PCT` / `ZH_HARD_CAP_PCT` | 2% / 5% | Zero-hero stake / hard cap. |

---

## 12. End-to-end flow (per tick)

```
tickPaper:
  if !active or market closed -> return
  count new trading day; reset per-day counters on date change
  for each open position:
     mark to market (option: interpolate premium - theta; swing: spot)
     evaluate exits: target/stop/trail/decay/stall/OI-flip/reversal/EOD/end
     close if any rule fires (record P&L + remark)
  if total equity >= +15% -> book all, stop (profit target)
  if total equity <= -10% -> book all, stop (drawdown kill switch)
  if run finished -> stop
  if day's realised loss <= -3% -> HALT new entries (manage open only)
  else open new trades (options >=9:20, swing >=9:30):
     apply timing, frequency, quality, range, confidence gates
     size by risk x confidence; push position
  maybe take ONE zero-hero lottery (>=9:20, once/day)
  save() -> json + CSVs
```

---

## 13. Failure & degraded-data handling

The engine is defensive: a single bad data call never aborts the whole tick.

- **`getSpot` returns null / times out:** that position is **skipped** for the
  tick (`if (spot == null) continue`) - it is NOT marked with stale data and no
  exit is evaluated for it. Other positions still process. It re-marks on the
  next successful tick.
- **`getOptionIdeas` / `getSwingIdeas` / `getZeroHeroIdeas` throw:** wrapped in
  try/catch - that vertical simply opens nothing this tick; exits still run.
- **`getOiBias` / `getRegime` throw:** caught per position; the extra OI-flip /
  reversal check is skipped, the base target/stop/decay/stall logic still runs.
- **Non-Groww feed:** live option OI is returned as *unavailable* (options are
  Groww-only), so option ideas don't build and no option entries are taken;
  existing positions keep marking from `getSpot`.
- **Restart mid-run:** state is reloaded from `data/paper-state.json` and the run
  resumes. Open positions are re-marked against **current** live spot on the next
  tick. There is no separate re-validation pass beyond that re-mark.

## 14. Idea selection & prioritization

- Option ideas come from `runHourlyScan()`, which returns safety-gated plays
  **sorted by `expectedPremiumMovePct x confidence` (descending)**. The engine
  consumes them in that order, so the highest expected-move-x-conviction play is
  taken first until the per-day / concurrent caps are hit.
- **Position uniqueness is per `kind + symbol`.** The engine will not open a
  second option on a symbol it already holds - so it never runs two different
  strikes on the same underlying at once. The same applies to swing.
- **Zero-hero is a separate bucket** and is not deduped against a regular option
  on the same index symbol - it is possible (though capped at one zero-hero/day)
  to hold both a normal index option and a zero-hero lottery on the same index.
- **Confidence** (the number that gates and sizes almost everything) is not a
  black box: it is defined in `market-understanding-logic.md` (technical
  confidence `|score| x 0.6 + agreement x 0.4`, then blended with OI + futures
  agreement/conflict). The engine treats it as a calibrated input.

## 15. Controls, capital and operations

- **Start / Stop / Reset:** `startPaper` begins a fresh run (overwrites state);
  `stopPaper` sets `active=false` but **keeps** the state/history; `resetPaper`
  clears everything. There is no distinct "pause & resume to active" - to
  continue you start a new run.
- **No mid-run capital add/withdraw:** starting capital is fixed for the run.
- **`startCapital = 0` for a pool:** sizing yields 0 lots (and cost > cash), so
  that pool simply sits idle - no error, no trades.
- **No authentication / access control on the API routes.** The server is meant
  to run locally; do not expose it to a network without adding auth.

## 16. Known gaps (not yet implemented)

Called out honestly, since the engine's stated goal is protecting capital:

- **Swing is long-only** - no short swing trades.
- **No corporate-action handling** - splits/dividends during a multi-day swing
  hold are not adjusted in the stop/target.
- **No unit tests** yet on `evalOptionExit`, `optionMark`, or the sizing math;
  correctness currently rests on the backtester and live paper results, not on a
  dedicated test suite. (Candidate improvement: add tests that assert each exit
  rule fires on crafted inputs.)

## 17. Honest limitations

- **Simulation only** - no slippage, no real fills, no partial fills; premiums
  are modelled (linear-to-target + theta), not tick-by-tick option quotes.
- Lot sizes for some F&O stocks are approximate (indices are accurate).
- Option decisions depend on live Groww OI/greeks; quality degrades without the
  live feed.
- Past paper results do not guarantee live performance. Use it to study the
  logic and win-rate, not as a promise of profit.
