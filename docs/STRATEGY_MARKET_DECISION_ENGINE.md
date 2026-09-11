# Strategy & Market Decision Engine — Reverse-Engineered Specification

**Status:** Documentation only. No production code was modified to produce this
document. All claims are cited to `file:line` in the backend as it exists today.
Where the codebase disagrees with itself (multiple implementations of the same
concept), every version is documented — none are silently picked as "the" answer.

All paths are relative to `backend/` unless otherwise noted.

---

## 1. Executive Summary

This is a **discretionary-assist paper-trading system** for NSE index/stock
options — it computes signals, scores, and simulated (never live) trades, but
was built up incrementally as independent modules rather than one designed
engine. The investigation found:

- **Four independent market-regime classifiers** (`paper/ext/marketRegime.ts`,
  and three separate ADX-based ones in `routes/api.ts`) that use different
  labels, different thresholds, and never call each other.
- **Three parallel OI-verdict computations** (`oi/oi.ts` / `data/growwProvider.ts`'s
  ±1 score, `oi/oiChange.ts`'s ±100 5-factor score, and the trading-facing
  `oiDirection` relabel of the second one) that can and do disagree.
- **Five different PCR (put-call ratio) bullish/bearish threshold pairs** live
  simultaneously across five files.
- **The single most important architectural finding**: the "Master Trade
  Selector" arbiter (`paper/ext/tradeArbiter.ts`'s `arbitrate()`) that decides
  GO / WAIT / CONFLICT for the UI is **never consulted by the paper-trading
  engine** (`paper/engine.ts`) that actually opens positions. The two systems
  run in parallel and can disagree — the dashboard can show "CONFLICT ⚠" while
  a position opens anyway. See §10.
- **No position-scaling logic exists anywhere** — every entry is a brand-new,
  independent position; there is no add-on entry, no averaging in, no partial
  profit-taking, and (confirmed explicitly) no path that increases exposure
  because price moved against an existing trade.
- A meaningful amount of duplicate-logic cleanup (shared IST-time math, a
  shared ATR stop/target helper, a shared day-range helper, and centralizing
  the reused ±15 direction threshold into one constant) was already done in a
  prior session on this codebase — noted inline below where relevant so this
  document doesn't re-flag already-fixed issues as open problems.

---

## 2. Current Architecture

### 2.1 Module map

| Concern | File(s) |
|---|---|
| Technical indicators (EMA/RSI/MACD/ATR/Supertrend/ADX/Bollinger/VWAP) | `indicators/index.ts` |
| Technical signal score (6-factor, 100-scale) | `signals/score.ts`, `signals/engine.ts` |
| 4-Layer Direction Engine (Structure/Trend/Derivatives/Momentum) | `signals/direction4L.ts` |
| Bar-eligibility filters (trend/ADX/time) | `signals/filters.ts` |
| OI chain read, verdict #1 (±1 score) | `oi/oi.ts`, `data/growwProvider.ts` |
| OI baseline diff, buildup classification, verdict #2 (±100 score) | `oi/oiChange.ts` |
| OI walls, directional/scalp recommendation, conflict tally, model correlation | `oi/oiTrade.ts` |
| Move-agreement bulletin (5m/15m/1h) | `oi/bulletin.ts` |
| "Setup" price-structure entry rules (no RSI/MACD) | `paper/entryRules.ts` |
| Sentiment/Liquidity/Risk extension pipeline (regime→liquidity→sentiment→opening bias→premium→wall reaction→score) | `paper/ext/*.ts` |
| Master candidate arbitration (GO/WAIT/CONFLICT) | `paper/ext/tradeArbiter.ts` |
| Portfolio risk advisory | `paper/ext/riskComment.ts` |
| Re-entry suppression (fingerprint dedup) | `paper/ext/tradeDedup.ts` |
| Pre-trade risk scoring (volatility/ADX/time/volume/candle/premium-swing) | `options/riskRadar.ts` |
| "GainzAlgo v2" buy/sell checklist scorer | `options/highProbAlgo.ts` |
| Paper-trading engine (entry, sizing, exits, capital guards) | `paper/engine.ts` |
| Route composition, response assembly | `routes/api.ts` (`buildOiCommand`, `/oi-command` handler) |

### 2.2 The two parallel call chains (this is the crux of the architecture)

**Chain A — `buildOiCommand()` (`routes/api.ts:2928`)**, produces the OI/technical
read:
```
getOiCached(def)
  → recordOiBaseline + computeOiChange(...)           → oc          [oi/oiChange.ts]
  → loadBars() (15m/5m/60m/daily candles)
  → recommendOiTrades({...})                          → payload.recommendation   [oi/oiTrade.ts]
  → computeRiskRadar                                   → payload.riskRadar        [options/riskRadar.ts]
  → buildOiWalls                                        → payload.walls            [oi/oiTrade.ts]
  → correlateOiModels({...})                            → payload.correlate        [oi/oiTrade.ts]
  → buildOiLesson({...})                                → payload.lesson           [oi/oiTrade.ts]
  → REVERSE_RISK gate (api.ts:3327-3336) — mutates payload.recommendation in place
  → buildMoveBulletin, moodReview, quality, logging
  → return payload
```
`buildOiCommand()` returns here. **`payload.ext` does not exist yet.**

**Chain B — the `/oi-command` route handler (`routes/api.ts:3649-3680`)**, wraps
Chain A and adds the extension pipeline:
```
data = buildOiCommand(def)                              [Chain A above]
ext  = extForOiPayload(data)
         → assembleExtInputs()
         → scoreExtension()  (7 steps, paper/ext/pipeline.ts)
              1. computeMarketRegime      [paper/ext/marketRegime.ts]
              2. computeLiquidityGuard    [paper/ext/liquidityGuard.ts]
              3. computeSentiment4L       [paper/ext/sentiment4L.ts]
              4. computeOpeningBias       [paper/ext/openingBias.ts]  (first 30 min only)
              5. computePremiumSentiment  [paper/ext/premiumSentiment.ts]
              6. computeWallReaction      [paper/ext/wallReaction.ts]  (only if at a wall)
              7. computeTradeScore        [paper/ext/tradeScore.ts]  → finalScore, setupQuality
         → buildRiskComment()             [paper/ext/riskComment.ts]  (portfolio heat/drawdown, advisory)
         → extDedupPeek() (read-only — does not arm dedup)
         → build ArbiterCandidate[] for Directional + Scalp
         → arbitrate(candidates)          [paper/ext/tradeArbiter.ts]  → GO / WAIT / CONFLICT
reconcileOiState(...), checkArbiterWatchdog(...)   (logging only)
res.json({ ...data, ext })
```

**Chain C — the actual paper-trading entry path (`paper/engine.ts`)**, runs
**entirely independently** of Chain B's `arbitrate()` result:
```
tickPaper() / tickPaperScalps() (timers, every 5min / 90s)
  → getIndexOptionIdeas() / getStockOptionIdeas() / getScalpIdeas()  [routes/api.ts, calls oiGridToIdea() among others]
  → tryOpenOption(idea)
       → runExtPipeline(idea)  → scoreExtension() AGAIN (a fresh, separate call — not the same object as Chain B's)
       → confidence/RR/win-probability/regime/heat/cash/position-cap gates
       → open position, or reject with a reason string
```

`oiGridToIdea()` (`routes/api.ts:3401`) is the only bridge between Chain A/B's
OI recommendation and Chain C — it re-checks `rec.take && rec.algoReady` plus
bulletin agreement, and returns `null` (no idea at all) otherwise. **`arbitrate()`'s
GO/WAIT/CONFLICT verdict itself is never read by `paper/engine.ts`** — confirmed
by grep: `paper/engine.ts` imports `scoreExtension, logOpeningBias,
buildRiskComment, checkDedup, armDedup, releaseOnExit, observePrice,
logDecision` from `./ext`, but never `arbitrate` or `ArbiterCandidate`.
`arbitrate()` is called from exactly one place in the entire backend: the
`/oi-command` route handler, for display only (`api.ts:3556`, code comment:
*"This SHOWS what the modules say (read-only) — it does not open trades or arm
dedup."*).

---

## 3. Market Regime Logic

There is no single regime engine — **four independent classifiers** coexist:

| # | Location | Labels | Method | Scope | Hard gate? |
|---|---|---|---|---|---|
| 1 | `paper/ext/marketRegime.ts:60-103` | Trending / Compressed / Transitioning | 3+ consecutive fractal HH+HL or LH+LL swings (window step 8 bars) → Trending; ATR(14) < 85% of its 20-bar avg → Compressed; squeeze→fire burst release → Transitioning; else Transitioning (indeterminate default) | Per-candidate, feeds the extension pipeline's scoring | No — informational, feeds `tradeScore`'s ±4 bonus and `setupQuality`'s clarity points only |
| 2 | `routes/api.ts:412-431` | Trending (ADX≥25) / Weak trend (18-25) / Range-bound (<18) | ADX(14), **NIFTY 15m only** | Global status endpoint, feeds a separate `tradeZone` (TRADE-ON/SELECTIVE/NO-TRADE) verdict at `api.ts:432-472` | Feeds `tradeZone`, but `tradeZone` itself isn't consumed by the paper engine either (display-only status) |
| 3 | `routes/api.ts:5317-5328` (`deps.getRegime`) | Trending (≥25) / **Range** (<18) / Weak (18-25) | ADX(14), per symbol | Injected into the paper engine as `TickDeps.getRegime` | **Yes** — `"Range"` prohibits opening a non-OI-tagged, non-scalp directional idea (`paper/engine.ts:885-887`) |
| 4 | `routes/api.ts:2645-2671` (`classifyRegime`) | good / lottery / whipsaw / range (Hindi labels) | ADX≥23 → good; squeeze<0.7 & ADX<22 → lottery; ADX<20 & ≥3 EMA9/21 crossovers in last 12 bars → whipsaw; else range | Per-timeframe UI display (`5m`/`15m`/`1h`) and the `/signal/:symbol` route's `regime` field | No — display-only |

**Note the label collision**: classifier #2 uses `"Range-bound"`, classifier #3
uses `"Range"` — same ADX<18 condition, different string, so code that greps
for one literal will silently miss the other.

**Only classifier #3 actually blocks a trade**, and only for one idea class
(non-OI, non-scalp directional). Scalp ideas and any idea whose `strikeReason`
is OI-tagged bypass regime protection entirely (§14, problem 13).

---

## 4. OI Logic

### 4.1 Walls (support/resistance)

`buildOiWalls()` (`oi/oiTrade.ts:302-345`) computes **two tiers**:
- `immR`/`immS` — nearest strike above/below spot (the "immediate" wall).
- `bestR`/`bestS` — the strike with the **largest OI** on that side (the true
  "wall") — mapped to `payload.oiSummary.callWall`/`putWall` (`api.ts:3201-3210`).

A **third, cruder** notion exists in `oi/oi.ts:100-106` (duplicated verbatim in
`data/growwProvider.ts:530-535`): support/resistance = the single strike with
max PE/CE OI **across the whole chain**, not filtered by side-of-spot.

"Fever" (OI concentration near ATM, ±5 strikes): `putPct >= 55` → PUT fever
(bullish lean); `callPct >= 55` → CALL fever (bearish lean) (`oiTrade.ts:335-343`).

### 4.2 Writing / unwinding classification

`actionFor()` (`oi/oiChange.ts:67-72`), exact rule (per-strike, per-side, diffed
against the day's first-reading baseline):
```
oiChg > 0, CE → "Call writing ↑"     (bearish)
oiChg > 0, PE → "Put writing ↑"      (bullish)
oiChg < 0, CE → "Call unwinding ↓"   (bullish)
oiChg < 0, PE → "Put unwinding ↓"    (bearish)
oiChg == null → "building baseline"
oiChg == 0    → "flat"
```

### 4.3 PCR — five different threshold pairs live simultaneously

| File | Bullish | Bearish | Notes |
|---|---|---|---|
| `oi/oi.ts:133-136`, `growwProvider.ts:557-560` | ≥1.2 | ≤0.7 | ±1 verdict score |
| `oi/oiChange.ts:175-178` | ≥1.2 | ≤0.8 | contributes ±15 to the 5-factor `oiDirScore` |
| `oi/bulletin.ts:90-92` | ≥1.05 | ≤0.85 | move-agreement bulletin |
| `options/highProbAlgo.ts:90-94` | ≥1.1 (trap fail if ≤0.7) | ≤0.85 (trap fail if ≥1.2) | GainzAlgo checklist |
| `commentary/marketCommentary.ts:186-188` | ≥1.1 | ≤0.7 | narrative commentary |

**A PCR of 0.9, for example, reads "bearish" under `oiChange.ts`'s rule but
"neutral" everywhere else** — a genuine cross-module inconsistency, not a
deliberate design choice (§14, problem 2).

### 4.4 OI direction (UP/DOWN/FLAT) — the number that actually drives trading

`computeOiChange()`'s `oiDirScore` (`oi/oiChange.ts:167-194`), five additive
factors on a ±100 scale:

| Factor | Contribution |
|---|---|
| Net PE-writing vs CE-writing near ATM (bias) | ±25 |
| PCR ≥1.2 / ≤0.8 | ±15 |
| Futures buildup (Long buildup/Short covering vs Short buildup/Long unwinding) | ±20 |
| Distance to support vs resistance (closer to one wall) | ±10 |
| Max single-strike buildup "very high" flag | ±10 |

```
oiVerdict = oiDirScore >= 20 ? "Bullish" : oiDirScore <= -20 ? "Bearish" : "Neutral"
oiConfidence = min(100, |oiDirScore|)
```
`routes/api.ts` then relabels this 1:1 with no extra threshold:
`oiDirection = Bullish→"UP" / Bearish→"DOWN" / Neutral→"FLAT"`.

**A second, wholly independent verdict** exists in `oi/oi.ts:130-145` (and its
duplicate in `growwProvider.ts:555-567`): a coarse ±1 integer score (PCR ±1,
CE/PE whole-chain buildup ±1), `bias = score>=1 ? "Bullish" : score<=-1 ?
"Bearish" : "Neutral"`. This is **display-only** for the trading path (the
`oiDirection` that gates `recommendOiTrades` sources from `oiChange.ts`, not
`oi.ts`) but **is** consumed as a separate directional input elsewhere
(`signals/direction4L.ts:122`, `predict/dayOutlook.ts`), meaning the app can
show two different "OI bias" numbers for the same instant, sourced from two
unrelated formulas.

**Both-sides-writing case**: there is no explicit "conflicted OI" state. If CE
and PE are both writing roughly equally, the `bias` net-of-the-two calculation
(`oiChange.ts:133-141`) falls into `"Neutral"` — the same bucket as genuinely
flat/no-activity — losing the distinction between "nothing is happening" and
"both sides are fighting hard."

### 4.5 Conflict resolution — `buildOiLesson()`'s pay/reverse tally

`oi/oiTrade.ts:373-459`, a point tally (asymmetric thresholds):
```
pay += 1   if oiDir !== FLAT
pay += 2   if model consensus AGREE
rev += 2   if model consensus CONFLICT       rev += 1 if MIXED
pay += 1   if ADX >= 20                      rev += 1 if ADX < 16
pay += 1   if 5m candle agrees with direction
rev += 2   if 5m candle opposes with strength >= 0.6
rev += 1   if 5m candle is a Doji
rev += 1   if 15m reversal-pattern candle opposes direction
rev += 1   if capturedPct >= 80 (move already captured)
rev += 1   if data stale
rev += 1   if no same-day baseline yet
rev += 1   if price within 0.15% of the OI wall in that direction

mode = "PAY_CHANCE"    if pay >= rev + 2  AND oiDir != FLAT
mode = "REVERSE_RISK"  if rev >= pay + 1
mode = "UNCLEAR"       otherwise
```
Note the deliberate asymmetry: PAY_CHANCE needs a 2-point margin; REVERSE_RISK
only needs a 1-point margin — the system is built to default to caution on any
near-tie.

`correlateOiModels()` (`oi/oiTrade.ts:213-272`) — the model-agreement input
to the tally above — counts 5 non-OI "model votes" (VWAP, 4-Layer direction,
GainzAlgo pass/fail, last-5m-bar, futures buildup) against the OI direction:
```
against == 0 && agree >= 2  → "AGREE"
against >= 2                → "CONFLICT"
else                        → "MIXED"
```

---

## 5. Technical Logic

### 5.1 `signals/score.ts` + `signals/engine.ts` — the 100-scale, 6-factor score

```
WEIGHTS = { emaCross: 22, supertrend: 22, vwap: 18, macd: 18, rsi: 12, bollinger: 8 }
MAX_SCORE = 100
DIRECTION_THRESHOLD = 15   (centralized; reused by direction4L.ts, entryRules.ts, nextday/outlook.ts, routes/api.ts, options/suggest.ts)
```

| Indicator | Formula | Notes |
|---|---|---|
| EMA9/21 cross | `contrib = sign(ema9-ema21) * 22 * min(1, |spreadPct|/0.5)` | strength-scaled |
| Supertrend | `contrib = direction * 22` | **full weight, no scaling** — binary all-or-nothing |
| VWAP | `contrib = sign(price-vwap) * 18 * min(1, |diffPct|/0.4)` | strength-scaled |
| MACD histogram | `contrib = sign(hist) * 18 * max(0.4, min(1, |hist|/|macdLine|))` | **floor of 0.4** — never contributes less than 40% of its weight once non-zero |
| RSI(14) | `<30`→+12, `>70`→-12, `>=55`→+4.8, `<=45`→-4.8, else 0 | dead zone 45-55 |
| Bollinger(20,2) | `price>=upper`→-8, `price<=lower`→+8, else 0 | binary, no gradation |

```
score = clamp(round(Σcontrib), -100, 100)
confidence = clamp(round(|score|*0.6 + agreement*100*0.4), 0, 100)
label: score>=50→"STRONG BUY", >=15→"BUY", <=-50→"STRONG SELL", <=-15→"SELL", else "HOLD"
```

### 5.2 `signals/direction4L.ts` — 4-Layer Direction Engine (separate, more elaborate)

```
WEIGHTS = { structure: 40, trend: 25, derivatives: 20, momentum: 15 }
```
Each layer is a mean of `-1/0/+1` votes × its weight:

- **Structure (40%)**: PDH/PDL breakout (buffer = max(0.05% of price, 0.1×ATR)); opening range (09:15-09:45 IST) breakout; 2-bar fractal HH/HL vs LH/LL (40-bar window); day-range position (≥75%/≤25%).
- **Trend (25%)**: EMA9 vs EMA21 sign; Supertrend(10,3) direction; VWAP sign.
- **Derivatives (20%)**: OI bias (from `oi.ts`'s verdict, not `oiChange.ts`'s); OI buildup type; futures buildup; IV skew (±4% deadband). Futures basis and option volume sub-signals are explicitly omitted (feed doesn't provide them).
- **Momentum (15%)**: RSI ≥55/≤45; MACD histogram sign; price vs Bollinger mid; volume only counted if RVOL≥1.2.

```
score = clamp(round(Σ layerScore*weight), -100, 100)
direction = score>=15 ? "Bullish" : score<=-15 ? "Bearish" : "Neutral"
confidence = clamp(round(|score|*0.7 + layersAgree*7), 5, 97)
```

### 5.3 Risk Radar (`options/riskRadar.ts`) — display-only, not an entry gate

`SEVERITY_WEIGHT = {danger:35, caution:18, info:8}`. Seven rules:

| Rule | Threshold | Severity |
|---|---|---|
| ATR spike | ratio ≥1.4 (danger ≥1.8) | caution/danger |
| No clear trend | ADX <20 | caution |
| Opening 15 min | IST 09:15-09:30 | caution |
| Late session | IST ≥14:45 | caution |
| Unusual volume | RVOL ≥2 (danger ≥3) | caution/danger |
| Sharp candle | 5-bar range ≥2×ATR | caution |
| Premium sensitivity | 1-ATR move ≥25% of premium (danger ≥40%) | caution/danger |
| Theta reminder | always shown | info |

`spikeRisk = min(100, Σseverity_weight)`; `level = High(≥60)/Elevated(≥30)/Low`.
**This score is computed and displayed but is not read by `tryOpenOption()` or
any entry-gating code** — it is informational for the trader, not a system
veto (§14, problem 4/13 — arguably a missed opportunity, not a bug).

### 5.4 GainzAlgo v2 (`options/highProbAlgo.ts`)

`evaluateBuyAlgo()` — starts at score 36, **any single check failing fails the
whole evaluation** (all-must-pass, not a weighted sum with a floor): confidence
≥68, quality ≥52, market alignment not Conflict, decay not High near expiry,
theta/day ≤22%, OI bias agrees, PCR not a "trap," ADX ≥18, VWAP agrees, opening
range break agrees, `srRoomOk`, 4-Layer direction agrees (not Neutral), RVOL
≥0.85, not exhausted (>65% of daily ATR used), delta ≥0.4, premium ≥1.5.

---

## 6. Setup Engine (`paper/entryRules.ts`)

The codebase's own comments identify this module as **"the user's ruleset"** —
price-structure driven, deliberately excluding RSI/MACD, used only by the
paper engine's idea generators.

| Function | What it computes |
|---|---|
| `directionNoMomentum()` | Re-derives 4L direction excluding the Momentum layer (Structure 40 + Trend 25 + Derivatives 20 = 85, renormalized to 100). Threshold: same shared ±15. |
| `levelContext()` | PDH/PDL/PDC, day open, opening range (09:15-09:45 IST), VWAP, major S/R (heaviest OI wall, falls back to PDH/PDL), 2-bar swing fractal (40-bar window), and a 3-vote bias nudge (price vs dayOpen/PDC/VWAP). |
| `srRoomOk()` | `minRoom = max(spot*0.3%, 0.35×ATR)` — **raised from an earlier 0.15%/0.15×ATR** (code comment confirms this was already tightened in a prior session). |
| `capTargetAndStop()` | Volatility-scaled (not flat): `vm = clamp(atrDaily/spot / 1%, 0.7, 1.6)`; profit cap `15%×vm`, floor stop `12%×vm`; also holds ~1.3 reward:risk and clamps the spot target to the major wall. |

**`entryRules.ts` itself defines no standalone numeric "setup score" floor** —
its only quantitative gate is the shared ±15 direction threshold. It is also
**regime-agnostic**: none of its four functions read any regime value.

### Setup condition table (actual implementation)

| Condition | Required | Where enforced | Reason |
|---|---:|---|---|
| Direction not Neutral | Yes | `directionNoMomentum` via `getStockOptionIdeas` (`api.ts:5177`) | ±15 score threshold |
| Direction matches idea's proposed side | Yes | `api.ts:5177` | categorical check, no score margin |
| Level-context bias agrees (or neutral) | Yes | `api.ts:5179` | `lv.bias !== 0 && lv.bias !== direction` → reject |
| Room to major wall | Yes | `srRoomOk()`, `api.ts:5182` | 0.3%/0.35×ATR |
| OI | No (separate path) | not consulted by `entryRules.ts` | Setup and OI/Directional are independent codepaths (§7) |
| VIX-equivalent (ADX regime) | No, within `entryRules.ts` | only enforced downstream via `deps.getRegime` (§3, classifier 3) | not part of the Setup module itself |
| Minimum score | No explicit gate in this module | downstream consumers apply their own floors (below) | — |

The broader paper-trading pipeline that *consumes* Setup/OI ideas layers its
own floors on top (none of these live inside `entryRules.ts`):

| Constant | Value | File |
|---|---:|---|
| `CONFIRM_FLOOR` | 72 (55 for OI-tagged ideas) | `paper/engine.ts:279` |
| `WIN_PROB_MIN_DIR` / `WIN_PROB_MIN_SCALP` | 52 / 54 | `paper/engine.ts:275-276` |
| `OPT_RR_MIN` / `INTRADAY_RR_MIN` | 1.3 (net of cost) | `paper/engine.ts:293-294` |
| `tradeScore` clamp | floor 52, ceiling 62 | `config/arbitration.ts:10` |
| `OI_DIR_MIN` / `OI_SCALP_MIN` / `OI_ALGO_FLOOR` | 60 / 50 / 68 | `oi/oiTrade.ts:56-58` |
| `setupQualityMinForOverride` | 50 | `config/arbitration.ts:24` |
| `DISPLAY_QUALITY_MIN` | 30 | `config/arbitration.ts:14` |

**"SETUP DETECTED" vs "TRADE READY"**: the codebase draws these tiers
explicitly (§7 elaborates the directional side of this same ladder):
1. **Idea exists** — a direction/strike is computed at all.
2. **Take** — passes the module's own quality bar (`entryRules.ts`'s
   categorical checks, or `oiTrade.ts`'s confidence+room checks) and is shown
   as a recommendation.
3. **algoReady** — clears `OI_ALGO_FLOOR`(68) and was not REVERSE_RISK-downgraded.
4. **Actually opened** — passes `tryOpenOption()`'s independent, stricter gate
   stack (confidence, RR, win-probability, heat, cash, position caps).

---

## 7. Directional Engine

Two distinct codepaths compute CALL/PUT/NEUTRAL; they are independent and can
disagree.

### 7.1 `recommendOiTrades()` (`oi/oiTrade.ts:105-172`) — directional + scalp legs

Shared inputs: `OI_DIR_MIN=60`, `OI_SCALP_MIN=50`, `OI_ALGO_FLOOR=68`.
Volatility multiplier: `vm = clamp((expHigh/spot)/0.8%, 0.7, 1.6)`.

**Common skips** (both legs): no same-day OI baseline; chain stale (>90s); OI
FLAT; `status` starts with "AVOID"; no live premium; no CE/PE resolved.

**Directional leg**: additionally needs `oiConfidence >= 60` and `roomOk()`
(room ≥ max(expLow, 0.1% of spot) to the opposing wall). Target/stop:
`ltp × (1 ± 0.20/0.12 × vm)`. `algoReady = take && confidence >= 68`.

**Scalp leg**: needs `scalpConfidence >= 50` (base confidence +8 if premium
helpful, +5 if OI helpful, +7 if 5m bar agrees, **-12** if 5m bar opposes —
asymmetric penalty), `roomOk()`, premium not already falling, 5m bar not
opposing, and status not "BOOK" (move already captured). Target/stop:
`ltp × (1 ± 0.10/0.06 × vm)`.

### 7.2 The REVERSE_RISK feedback loop (`routes/api.ts:3327-3336`)

If `buildOiLesson()`'s mode is `REVERSE_RISK`: both legs get `confidence -= 15`
and **`algoReady` forced to `false` unconditionally** (regardless of whether
the post-penalty confidence still clears the floor). `take` is left untouched
— a REVERSE_RISK setup can still display as a recommendation, just not be
auto-tradeable, with an explicit reason appended to `leg.reasons`.

### 7.3 Bullish bias does NOT automatically mean BUY CALL

The code enforces a 4-tier ladder before a trade actually opens:

```
OI direction computed (UP/DOWN/FLAT)
        ↓
"take" — passes commonSkips + confidence floor + room check
        ↓
"algoReady" — take && confidence >= OI_ALGO_FLOOR(68) && not REVERSE_RISK-downgraded
        ↓
oiGridToIdea() — ALSO requires: 1h bulletin direction matches (directional),
                 or 5m AND 15m bulletin both match (scalp)
        ↓
tryOpenOption() — an entirely separate, independent gate stack:
  confidence >= CONFIRM_FLOOR(72, or 55 if OI-tagged)
  regime != "Range" (non-OI, non-scalp ideas only)
  extension pipeline: not vetoed/suppressed by dedup or "Decaying" premium
  reward:risk >= 1.3 (net of cost)
  win-probability >= 52 (directional) / 54 (scalp)
  portfolio heat under cap (hard, unless extension ran — then advisory)
  cash available, position-count cap for that pool not exceeded
        ↓
POSITION OPENED
```
Any stage can reject; there is no single point where "Bullish" alone commits
capital.

---

## 8. Scaling Engine

**Confirmed: no scale-in, add-on entry, or averaging logic exists anywhere in
this codebase.** Grepping the entire `paper/` directory for
averaging/scale-in/add-on terminology returns nothing, and the code
structurally prevents it: `tryOpenOption()` opens with a hard same-symbol,
same-pool block —
```ts
if (s.open.some(p => p.kind === kind && p.symbol === idea.symbol))
  return `पहले से ${idea.symbol} में position खुला है`;   // paper/engine.ts:879
```
Every new idea for a symbol/pool that already has an open position is rejected
outright. Every opened position is a brand-new object; nothing ever merges
quantity into an existing one.

### 8.1 Position limits

```
MAX_INDEX_OPT = 1      MAX_STOCK_OPT = 2      MAX_INTRADAY = 2      MAX_SCALP = 1
MAX_SCALPS_PER_DAY = 999   (no daily quota — quality gate only)
MAX_TRADES_PER_DAY  = 999   (no daily quota — quality gate only)
SCALP_THROTTLE = 45s   (anti-double-fill)      THROTTLE_SEC = 90s   (same-symbol spam guard)
```
(`paper/engine.ts:266-274`)

### 8.2 Capital / risk limits

```
RISK_PER_TRADE = 1%            HEAT_CAP_PCT = 6% of combined starting capital
DAILY_LOSS_CAP_PCT = 3%        MAX_DRAWDOWN_PCT = 10%
MAX_SINGLE_LOT_LOSS_PCT = 6%
```
(`paper/engine.ts:280,295-298,286`)

**Heat cap enforcement is inconsistent by codepath** (§14, problem 5): it is a
hard block for ideas that did *not* go through the extension pipeline (scalp,
or when `getExtInputs` is absent), but *advisory-only* (surfaced via
`riskComment`, not blocking) for directional ideas that did — a deliberate
choice per the code's own comment ("Portfolio HEAT is ADVISORY on the
extension path — it flexes with the user's per-trade judgment"), but a real
inconsistency depending on which path an idea took. `DAILY_LOSS_CAP_PCT` and
`MAX_DRAWDOWN_PCT` are hard backstops in both cases; the latter force-closes
every open position and sets the pool inactive (a true kill switch).

### 8.3 Exits — single target, one trailing-stop tier, no Target 1/2

```
Fixed target (non-scalp): +15% premium
TRAIL_ARM = 1.08 / TRAIL_GIVE = 1.04           (non-scalp trailing stop)
SCALP_TRAIL_ARM = 1.08 / SCALP_TRAIL_GIVE = 1.03  (scalp trailing stop)
Scalp hard rupee caps: +₹700/-₹350 per lot (NIFTY), +₹1000/-₹350 (other indices)
```
`closePosition()` always closes the **entire** position quantity in one call —
there is no partial-size exit function anywhere in `paper/engine.ts`. No
"Target 1 / Target 2" concept exists.

### 8.4 Re-entry — fingerprint + price-distance, not time-based

`paper/ext/tradeDedup.ts` — fingerprint = `mode|direction|strike|roundedEntryZone|wallRef`.
An **open** fingerprint blocks re-fire outright. An **exited** fingerprint
re-arms only if wall reaction, regime, or the wall reference itself changed,
**or** price has moved away by ≥1×ATR and returned. **There is no time-based
cooldown anywhere** (§14, problem 14) — this applies to directional trades
only; scalp re-entry is bounded solely by `MAX_SCALP=1` and the 45s throttle.

### 8.5 Explicit confirmation: no averaging down

Confirmed absent by direct inspection of `tryOpenOption()` and the tick-loop
entry code. The only reaction to adverse price movement is the exit-side logic
(stop/stall/decay/reversal checks) — which closes positions, never opens a
second one. The same-symbol block (§8, opening paragraph) structurally
prevents any path from adding exposure to a losing trade.

---

## 9. Scoring Engine — all systems in this codebase

| System | Scale | Minimum to matter | File |
|---|---|---|---|
| `computeSignal` (technical) | -100..100 | ±15 for BUY/SELL label | `signals/engine.ts` |
| 4-Layer Direction | -100..100 | ±15 for Bullish/Bearish | `signals/direction4L.ts` |
| `oiDirScore` | -100..100 | ±20 for Bullish/Bearish | `oi/oiChange.ts` |
| `oi/oi.ts` verdict | -1/0/+1 | ±1 for Bullish/Bearish | `oi/oi.ts` |
| OI recommendation confidence | 0-100 | 60 (dir) / 50 (scalp) take, 68 algoReady | `oi/oiTrade.ts` |
| `tradeScore.finalScore` | clamped 52-62 | n/a (always in-band by construction) | `paper/ext/tradeScore.ts` |
| `setupQuality` | 0-100 | 30 to display, 50 for arbiter clarity override | `paper/ext/tradeScore.ts` |
| GainzAlgo buy score | 0-100 (starts 36) | all-must-pass checklist, not a floor alone | `options/highProbAlgo.ts` |
| Risk Radar `spikeRisk` | 0-100 | n/a — display only, no gate | `options/riskRadar.ts` |
| Paper-engine confidence floor | 0-100 | `CONFIRM_FLOOR` 72 (55 if OI-tagged) | `paper/engine.ts` |
| Win-probability | 0-100 | 52 (dir) / 54 (scalp) | `paper/engine.ts` |

There is no single unified "the score" — a trade idea accumulates confidence
independently in at least three of these systems before it can open a
position, and none of them share a common scale or vocabulary (0-100 confidence
vs -100..100 direction vs a hard-clamped 52-62 composite).

---

## 10. Conflict Resolution

| Scenario | Actual resolution |
|---|---|
| **OI Bullish, EMA/VWAP/MACD mixed** | `signals/engine.ts`'s own weighted sum absorbs this — no separate conflict state; the 6-factor sum simply nets out. Only becomes a formal "conflict" if it also disagrees with OI (see next row). |
| **OI Bullish vs 4-Layer Bearish** | 4L direction is one of 5 votes in `correlateOiModels()`. If ≥2 of the 5 models oppose OI → `consensus="CONFLICT"` → `buildOiLesson` adds `rev+=2` → if `rev>=pay+1`, mode becomes `REVERSE_RISK` → both legs' `algoReady` forced `false` → `oiGridToIdea()` returns `null` → **no trade**. A single disagreeing model (`against==1`) only yields `"MIXED"` (`rev+=1`) and may not flip the mode — a genuine trade can still fire despite one dissenting model. |
| **Market Regime Bullish but Call OI = heavy resistance** | Not a single check — `srRoomOk()` (wall-distance) feeds only `GainzAlgo`'s pass/fail, which becomes one of the 5 `correlateOiModels` votes; it does **not** directly veto `tradeScore.ts` or `tradeArbiter.ts`. Separately, `wallReaction.ts`'s `REJECT` state (OI velocity + burst state + volume + regime bias) only affects `tradeScore`'s ±4 bonus, not a hard veto either. |
| **Score is high but breakout not confirmed** | No single unified check exists. `srRoomOk` failing is a categorical reject in `entryRules.ts`'s own consumer (`api.ts:5182`), but for the OI-driven path a high score can still proceed if `roomOk()` (a different, looser room check) passes even without an explicit breakout confirmation — these are two different room-distance formulas guarding two different codepaths (§14, problem 4). |
| **Directional and Scalp candidates both want to fire** | Resolved by `arbitrate()` (`paper/ext/tradeArbiter.ts:47-94`): rank by `finalScore` then `setupQuality`; single candidate → GO; same direction or >6-point score gap → leader GOes, other demoted; opposing direction within 6 points → clarity tie-break at `setupQuality>=50`, else genuine `"CONFLICT"` (both suppressed). |
| **`tradeArbiter` returns "CONFLICT"** | **Does not block auto-entry.** `arbitrate()` is called from exactly one place in the backend — the `/oi-command` display route. `paper/engine.ts` never imports it. A CONFLICT verdict only: (a) changes what the frontend Master Trade Selector shows, (b) logs an `ARBITER_CONFLICT` warning, (c) after 15 minutes persisting, triggers a log-only watchdog warning. **The paper engine can open a position via `tryOpenOption()`'s own independent gates while the UI simultaneously displays CONFLICT.** This is the single most significant finding of this investigation. |

---

## 11. Trade State Machine

Positions are strictly **binary** — `open` or `closed` — via `PaperState.open:
PaperPosition[]` / `closed: PaperTrade[]`. **No PENDING, ARMED, or ACTIVE
intermediate state exists anywhere** in the `PaperPosition`/`PaperState` types.
A position transitions from nonexistent directly to `open` (via `tryOpenOption`
or `openManual`), and from `open` to `closed` (via `closePosition()`), with no
state in between.

Terminal `exitReason` values — these ARE the state machine's only outcomes:
```
target | stop | eod | time | end | decay | stall | trail | profit | reversal | risk
```

The dedup fingerprint (§8.4) has its own small two-state machine, independent
of position state: `open` (armed, blocks re-fire) → `exited` (released on
close, may re-arm under the conditions in §8.4). This is the closest thing to
a "cooldown" state in the codebase, and it is condition-based, not time-based.

---

## 12. Risk Controls

| Control | Value | Hard or advisory | Scope |
|---|---:|---|---|
| `RISK_PER_TRADE` | 1% of pool | sizing input, not a gate | all entries |
| `HEAT_CAP_PCT` | 6% of combined starting capital | **Hard** for non-extension ideas; **advisory** for extension-scored directional ideas | portfolio |
| `DAILY_LOSS_CAP_PCT` | -3% realised today | Hard — blocks new entries | portfolio |
| `MAX_DRAWDOWN_PCT` | -10% total equity | Hard — force-closes everything, deactivates | portfolio |
| `MAX_SINGLE_LOT_LOSS_PCT` | 6% | sizing ceiling override | per-position |
| `OPT_RR_MIN` / `INTRADAY_RR_MIN` | 1.3, net of cost | Hard | per-entry |
| `WIN_PROB_MIN_DIR` / `_SCALP` | 52 / 54 | Hard | per-entry |
| Risk Radar (`spikeRisk`) | 0-100 | **Advisory only — not read by any entry gate** | per-symbol display |
| `riskComment` (portfolio heat/drawdown text) | — | **Advisory only**, even where the numeric heat cap is hard elsewhere | portfolio display |

---

## 13. Example Scenarios

### Example 1 — Strong Bullish (NIFTY)
```
Market Data:   NIFTY 15m, ADX 27, EMA9>EMA21, price>VWAP, MACD hist positive
OI Analysis:   oiDirScore +55 (net PE writing, PCR 1.3, long-buildup futures) → oiVerdict "Bullish" → oiDirection "UP", oiConfidence 55→ (further away-from-wall bonus) 65
Technical:     computeSignal score +62 "STRONG BUY"; 4L direction "Bullish" score +48
Regime:        marketRegime "Trending" (3 HH/HL swings); deps.getRegime "Trending" (ADX 27)
Setup:         directionNoMomentum "Bullish"; levelContext bias +1 (price above dayOpen/PDC/VWAP); srRoomOk passes (room to resistance > 0.35×ATR)
Directional:   recommendOiTrades directional leg: confidence 65>=60, roomOk passes → take=true, algoReady=true (65<68 — NOT yet algoReady on confidence alone)
               correlateOiModels: VWAP/4L/GainzAlgo/5m/futures nearly all agree → consensus AGREE → buildOiLesson pay=6,rev=0 → PAY_CHANCE (no REVERSE_RISK penalty)
Scaling:       no existing NIFTY index-option position open → MAX_INDEX_OPT(1) slot free
Final:         tryOpenOption: confidence needs re-evaluation post-extension (tradeScore may lift it into the 52-62 band as a separate number); RR/win-prob/heat/cash all clear → POSITION OPENED (CE)
```

### Example 2 — Strong Bearish (BANKNIFTY)
```
Mirror of Example 1: oiDirScore -58 (CE writing, PCR 0.75, short-buildup futures) → oiDirection "DOWN"
computeSignal score -60 "STRONG SELL"; 4L "Bearish" -50
marketRegime "Trending" (LH/LL fractal); deps.getRegime "Trending"
recommendOiTrades scalp+directional legs both clear thresholds; correlateOiModels AGREE
No existing position, capital/RR/win-prob clear → PUT position opened.
```

### Example 3 — Range Market
```
Market Data:   NIFTY chopping, ADX 14
OI Analysis:   CE and PE both writing at similar magnitude → net bias inconclusive → oiDirScore near 0 → oiVerdict "Neutral" → oiDirection "FLAT"
Technical:     computeSignal score ±8 "HOLD"
Regime:        deps.getRegime "Range" (ADX<18); classifyRegime "whipsaw" or "range" on lower timeframes
Setup:         directionNoMomentum likely "Neutral" (score inside ±15)
Directional:   recommendOiTrades commonSkips fires "OI FLAT — WAIT" on both legs → take=false
Scaling:       n/a — nothing to scale
Final:         Even if some other idea path proposed a directional trade, paper/engine.ts:885-887 explicitly rejects it: "regime=Range (flat market — theta risk में buy नहीं)" (non-OI, non-scalp ideas only) → WAIT / NO TRADE
```

### Example 4 — Bullish OI but Bearish Technicals
```
OI Analysis:   oiDirScore +30 → oiVerdict "Bullish" → oiDirection "UP", oiConfidence 65 (>=60, take=true)
Technical:     4L direction "Bearish" (EMA/Supertrend/VWAP all below), computeSignal score -20 "SELL"
Regime:        Transitioning (indeterminate)
correlateOiModels: 4L opposes (against+1); if VWAP also opposes (against+2) → consensus "CONFLICT"
buildOiLesson: rev+=2 (CONFLICT) plus possibly +1 more (ADX<16 or stale) → rev>=pay+1 → mode "REVERSE_RISK"
REVERSE_RISK gate (api.ts:3327): directional leg confidence 65-15=50, algoReady forced false, reason appended: "⚠ reverse-risk read (model conflict / weak trend / late move) — auto-trade disabled, size down or wait"
oiGridToIdea(): algoReady is false → returns null → no OptionIdea built
Final:         The UI can still show "take: true" with a visibly downgraded confidence and the reverse-risk reason, but no paper position opens (WAIT, effectively) — the arbiter's own CONFLICT-detection (if the two candidates were both offered to arbitrate()) would independently also show CONFLICT on the dashboard, though (per §10) that verdict is not what actually stopped the trade — the algoReady=false gate is.
```

### Example 5 — Breakout + OI confirmation
```
Market Data:   Price closes above PDH with a wide-range candle
OI Analysis:   PE writing accelerating at the strike just below (support forming), CE unwinding above → oiDirScore +45 → "Bullish", oiDirection "UP"
Technical:     4L Structure layer fires +1 (PDH breakout) and +1 (opening-range breakout, if within 09:15-09:45); Trend layer agrees; computeSignal STRONG BUY
Regime:        marketRegime "Transitioning" (squeeze→fire) or "Trending"; wallReaction "BREAK" (OI velocity + burst-state + regime bonus, e.g. +0.2 Trending or +0.3 Transitioning-with-prior-squeeze)
Setup:         srRoomOk passes (room opened up post-breakout); GainzAlgo evaluateBuyAlgo: ADX>=18 ✓, OI agrees ✓, PCR not a trap ✓, VWAP agrees ✓, OR-break agrees ✓, srRoomOk ✓, 4L agrees ✓, RVOL>=1.2 ✓ → pass=true
Directional:   correlateOiModels: GainzAlgo+VWAP+4L+5m all agree, 0 against → consensus "AGREE" → buildOiLesson pay high, rev low → "PAY_CHANCE"
               recommendOiTrades: confidence clears both OI_DIR_MIN and OI_ALGO_FLOOR → algoReady=true
Scaling:       no existing position for the symbol/pool
Final:         oiGridToIdea's bulletin-agreement check passes (1h dir matches) → tryOpenOption clears confidence/RR/win-prob/heat/cash/position-cap → POSITION OPENED
```

---

## 14. Current Problems

1. **Duplicate logic** — four market-regime classifiers (§3), three OI-verdict
   computations (§4.4), five PCR threshold pairs (§4.3), and a naming
   collision (`ceBuildup`/`peBuildup` means different things and is computed
   differently in `oi/oi.ts` vs `oi/oiChange.ts`). *Note: shared IST-time math,
   the ATR stop/target helper, the day-range helper, and the ±15 direction
   threshold were already centralized in a prior session on this codebase —
   not re-flagged here.*
2. **Conflicting rules** — the same PCR value can read "bullish"/"neutral"/"bearish"
   depending on which of five modules evaluates it (§4.3); the same ADX<18
   condition is labeled `"Range-bound"` in one place and `"Range"` in another,
   risking silent misses in any code that greps for one literal.
3. **Hardcoded thresholds** — virtually every threshold in this document is a
   hardcoded literal (many now named constants after prior cleanup, but still
   not centrally configured or derived from backtest data): the 6/50/15
   arbitration constants, the 52-62 tradeScore clamp, all six `signals/score.ts`
   weights, every PCR pair, every ADX cutoff.
4. **Missing confirmation** — `srRoomOk()` (Setup module) and `roomOk()`
   (OI-trade module) are two different wall-distance formulas guarding two
   different codepaths with no shared source of truth; Risk Radar's warnings
   are computed but never consulted by any entry gate.
5. **Weak risk controls** — the 6% heat cap is a hard block for some ideas and
   advisory-only for others, depending on which pipeline the idea passed
   through — an inconsistency, not a deliberate risk-tiering design.
6. **False-signal possibilities** — Supertrend contributes its full 22-point
   weight with zero strength-scaling (binary), while every other weighted
   indicator scales by signal strength; MACD's `max(0.4, ...)` floor means a
   barely-non-zero histogram still contributes 40% of its weight, amplifying
   noise near the zero-line.
7. **Look-ahead bias** — not confirmed either way by this investigation;
   `computeScoreSeries()` is documented as a deliberate "vectorized clone" of
   the live scorer for live/backtest parity, which suggests care was taken,
   but a dedicated audit of candle-boundary handling (does any function ever
   read the still-forming current bar as if it were closed?) was out of scope
   here and should be done explicitly before relying on backtest numbers.
8. **Stale-data risk** — the OI path checks `stale` (>90s) explicitly in
   `commonSkips()`, but technical-indicator computation from cached candles
   has no equivalent independent staleness check of its own.
9. **Overlapping strategies** — GainzAlgo (`highProbAlgo.ts`) and the extension
   pipeline's `tradeScore.ts` are two separate, independently-weighted
   "should this trade fire" scorers for essentially the same question,
   connected only loosely (GainzAlgo's pass/fail becomes a single vote inside
   `correlateOiModels`, not a direct input to `tradeScore`).
10. **Scaling risks** — moot in the sense that no scaling exists, but the
    *absence* itself is a limitation: no partial profit-taking means every
    winning trade is all-or-nothing at a single fixed target.
11. **Race conditions** — a concurrency bug in the paper-trading tick loop
    (overlapping timers/routes double-opening positions against a stale cash
    read) was identified and fixed in a prior session on this codebase (a
    mutex now serializes all entry points). No further race condition was
    identified in this investigation, though `extDedupPeek()`'s read-only
    "does not arm" comment (§2.2) implies a peek/arm gap that was not
    independently verified as race-safe here.
12. **Incorrect OI interpretation risk** — simultaneous heavy CALL and PUT
    writing collapses into the same `"Neutral"`/`"FLAT"` bucket as genuine
    inactivity, discarding a real, distinguishable market condition (a
    two-sided fight, often a precursor to a large move) that the system
    currently cannot represent or reason about.
13. **Missing market-regime protection** — only one of four regime classifiers
    (`deps.getRegime`) actually blocks a trade, and only for non-OI-tagged,
    non-scalp directional ideas — scalp trades and OI-sourced ideas bypass
    regime protection entirely, even in a confirmed Range/choppy market.
14. **Missing trade cooldown** — confirmed absent. Re-entry suppression is
    fingerprint + price-distance based (§8.4), not time-based; nothing
    prevents rapid-fire re-entry at a *different* price/strike immediately
    after a stop-out.
15. **"One trade at a time" is narrower than it sounds** — enforced per
    (symbol, pool), not globally. Up to 6 positions can be concurrently open
    across pools (1 index option + 2 stock options + 2 intraday + 1 scalp) —
    not a single global "only one position ever" rule.
16. **(Not on the original checklist, but the most consequential finding)** —
    **the Master Trade Selector's displayed verdict is disconnected from the
    paper engine's actual entry decision.** `arbitrate()` (GO/WAIT/CONFLICT) is
    computed purely for the `/oi-command` display response and is never
    imported by `paper/engine.ts`. A user can watch the dashboard show
    "CONFLICT ⚠" while a position opens in the background via the entirely
    separate `tryOpenOption()` gate stack — the single most misleading gap in
    the current architecture, and the top candidate for the recommended fix
    in §15.

---

## 15. Recommended Architecture

Principle: **one engine per concern, one source of truth per number, and the
UI's verdict must be the same verdict the trading engine actually acted on.**
No strategy calculation should live in a route handler (`routes/api.ts`
currently hosts orchestration logic — like the REVERSE_RISK downgrade and the
raw `deps.getRegime` classifier — that belongs in a domain module instead).
Note: this codebase is a Node/Express backend with a vanilla-JS frontend, not
React — the "no calculations in UI components" principle is **already
satisfied** on the frontend side; the actual violation is domain logic living
in the HTTP route layer instead of a domain module.

| Engine | Input | Processing | Output | Replaces |
|---|---|---|---|---|
| **MarketRegimeEngine** | candles (multi-timeframe), OI, burst state | ONE fractal+ATR+ADX-informed classifier with one label set | `{regime, confidence, note}` | The 4 classifiers in §3 |
| **OIAnalysisEngine** | option chain, baseline | ONE PCR threshold set, ONE writing/unwinding classifier, ONE walls/max-pain calc, an explicit "two-sided/conflicted" state | `{oiDirection, oiConfidence, walls, pcrState, twoSided: bool}` | `oi/oi.ts`, `oi/oiChange.ts`, `growwProvider.ts`'s duplicate, the 5 PCR pairs |
| **TechnicalAnalysisEngine** | candles | Unchanged in substance — `signals/score.ts` + `direction4L.ts` + `indicators/*` are already reasonably well-factored | `{score, direction4L, votes}` | (mostly keep as-is; fix Supertrend/MACD scaling inconsistency, §14.6) |
| **SetupEngine** | levels, technical direction, OI | `entryRules.ts`'s existing functions, with the scattered floor constants (`CONFIRM_FLOOR`, `OI_*_MIN`, `WIN_PROB_MIN_*`) collected into one config surface | `{setup: bool, levels, room}` | `entryRules.ts` (mostly keep; consolidate config) |
| **DirectionalEngine** | Setup + OI + correlation | `recommendOiTrades` + `buildOiLesson`'s conflict tally, with REVERSE_RISK applied *inside* this engine, not in the route handler | `{direction, take, algoReady, reasons}` | `oi/oiTrade.ts` + the `routes/api.ts:3327` gate |
| **ScalingEngine** | open positions, confirmation strength | **Does not exist today.** If scaling is ever wanted: explicit add-on rules gated on *improved* confirmation (not adverse price alone), a max-entries cap, and a capital-exposure cap distinct from the single-entry heat cap | `{allowAddOn: bool, maxQty}` | nothing — net-new |
| **RiskEngine** | Risk Radar, portfolio heat/drawdown/daily-loss | Unify Risk Radar (currently display-only) and `riskComment` (currently mixed hard/advisory) into one engine with **consistently enforced** thresholds regardless of which upstream pipeline produced the idea | `{heatOk, drawdownOk, dailyCapOk, warnings[]}` | `riskRadar.ts` + `riskComment.ts` + the heat-cap inconsistency in `paper/engine.ts` |
| **TradeStateEngine** | position lifecycle events | A real typed state machine (`NoTrade → Setup → Directional → Ready → Entry → Active → [Exit reasons]`), replacing the current implicit binary open/closed | `{state, history[]}` | the implicit state in `PaperState.open/closed` |
| **MasterTradeSelector** | all engine outputs above | `arbitrate()`'s existing logic, but **its verdict becomes a required input to `tryOpenOption()`** — a CONFLICT verdict must block entry, not just the display | `{verdict: GO\|WAIT\|CONFLICT}`, now load-bearing | `tradeArbiter.ts` (fix the wiring gap, §14.16 — the single highest-value change) |

---

## 16. Exact Decision Tree

```
MARKET DATA (candles, option chain, quote)
        ↓
DATA VALIDATION (candle count, chain availability, staleness)
   → reject: "not enough data" / disk-cache fallback with stale=true
        ↓
MARKET REGIME  ←── 4 independent classifiers (§3), inconsistently consumed
        ↓
OI MARKET STRUCTURE  ←── 3 independent verdicts (§4.4), 5 PCR pairs (§4.3)
        ↓
TECHNICAL CONFIRMATION  (computeSignal 6-factor + 4-Layer Direction)
        ↓
SETUP ENGINE (entryRules.ts: direction, levels, room)
   → reject: Neutral direction / bias mismatch / room fail
        ↓
DIRECTIONAL ENGINE (recommendOiTrades: take, algoReady)
   → reject: commonSkips / confidence < OI_DIR_MIN(60) / room fail
   → downgrade: REVERSE_RISK (correlateOiModels CONFLICT) → confidence-15, algoReady=false
        ↓
[PARALLEL, NOT SEQUENTIAL] MASTER TRADE SELECTOR (arbitrate: GO/WAIT/CONFLICT)
   — computed for display; NOT consulted by the path below (§10, §14.16)
        ↓
oiGridToIdea() — bulletin agreement (1h for directional, 5m+15m for scalp)
   → reject: algoReady false / bulletin disagrees
        ↓
SCALING — n/a (no scaling exists); same-symbol/pool check
   → reject: position already open for this symbol+pool
        ↓
ENTRY TRIGGER — tryOpenOption()
   confidence >= CONFIRM_FLOOR(72, or 55 if OI-tagged)
   regime != "Range" (non-OI, non-scalp only)
   extension pipeline: not vetoed (Decaying premium) / not suppressed (dedup)
   RR >= 1.3 net-of-cost, win-probability >= 52/54
        ↓
RISK MANAGEMENT
   heat cap (hard or advisory depending on path) / cash check / position-count cap
   → reject: any of the above
        ↓
TRADE MANAGEMENT (open position)
   fixed target (+15% or scalp rupee caps) / single trailing-stop tier
   exit: target | stop | trail | stall | decay | reversal | eod | risk | profit
        ↓
CLOSED (dedup fingerprint marked "exited", re-arms on wall/regime change or 1×ATR move-away)
```

---

## Current Logic vs. Recommended Logic — Comparison

| Aspect | Current Logic | Recommended Logic |
|---|---|---|
| Market regime | 4 independent classifiers, different labels/thresholds, only 1 enforces anything | 1 classifier, 1 label set, consistently enforced everywhere it applies |
| OI verdict | 3 parallel computations (±1 score, ±100 score, and a relabel of the latter) | 1 computation, 1 confidence scale |
| PCR thresholds | 5 different bullish/bearish pairs across 5 files | 1 shared threshold pair |
| Two-sided OI (both walls writing) | Collapses into "Neutral"/"FLAT" — indistinguishable from no activity | An explicit "conflicted/two-sided" state, reasoned about separately |
| Master Trade Selector verdict | Computed for display only; never gates the paper engine — can show CONFLICT while a trade opens | Verdict is a required input to entry — CONFLICT blocks entry |
| Heat cap (6%) | Hard for some ideas, advisory for others, depending on which pipeline produced the idea | Enforced consistently regardless of source pipeline |
| Risk Radar | Computed, displayed, never consulted by any gate | Feeds the unified RiskEngine's entry decision, not just the UI |
| Supertrend / MACD weighting | Supertrend binary full-weight; MACD floored at 40% contribution — inconsistent with the other 4 strength-scaled indicators | All six indicators strength-scaled consistently, or the exceptions documented as deliberate |
| Trade cooldown | None — fingerprint+price-distance dedup only, no time-based cooldown | Add an explicit minimum cooldown window per symbol after a stop-out, independent of price movement |
| Scaling | Does not exist; no averaging-in (confirmed, and correctly so) | If added: explicit add-on rules gated on improved confirmation only, never on adverse price, with its own max-entries/max-exposure caps |
| GainzAlgo vs tradeScore | Two independent "should this fire" scorers, loosely coupled via one vote in a 5-model tally | Either merge into one scorer, or make the coupling explicit and documented as intentional |
| Config | Thresholds hardcoded (many now named constants) across a dozen files | One central strategy-config module per engine, as listed in §15 |
| Domain logic location | Some lives in `routes/api.ts` (e.g. REVERSE_RISK gate, `deps.getRegime`) | Moved into the owning domain engine; routes only orchestrate and shape HTTP responses |

---

**End of specification. No code was modified to produce this document — per
your instruction, this is the reverse-engineered baseline only. Awaiting your
review and approval before any implementation work begins.**
