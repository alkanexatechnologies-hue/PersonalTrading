# Current Trading Logic Audit

**Purpose:** a complete, code-verified map of the Strategy & Market Decision Engine as it actually exists on disk today — not as intended, not as originally specified, as implemented. Every claim below traces to a specific file and line. No new strategy logic, indicator, threshold, or assumption was introduced while producing this document, and no code was changed while producing it.

**Scope note on "today":** earlier in this engagement, Phases 0–3.3 of a separate refactor plan were implemented and tested (Master Trade Selector wiring, a unified MarketRegimeEngine, OI score repointing, centralized PCR thresholds, RiskEngine wiring, a global one-trade-at-a-time lock, a new ScalingEngine, and a stale-data veto). Those changes are now part of "the existing implementation" and are described below exactly as they behave, with a note on which parts are brand new this session vs. pre-existing.

**Symbols in scope:** NIFTY (`^NSEI`) and BANK NIFTY (`^NSEBANK`), both defined with `type:"index", fno:true` in `backend/config/index.ts`. Every section below that discusses "index options" covers both identically unless a specific asymmetry is called out (see §13–14).

**Update (post-audit, with explicit sign-off on each):** of the 6 gaps this audit originally flagged as "documented, not resolved," 4 have since been resolved on your explicit decision, 1 remains open pending your input, and 1 (EMA 21/50) is intentionally deferred pending your exact rule:

| Gap | Decision | Status |
|---|---|---|
| OI two-sided/conflicted state | Add an explicit `TWO_SIDED` state | **RESOLVED** — see updated §6, §16, §18 |
| RSI conflict (`engine.ts`/`score.ts` vs `direction4L.ts`) | Make `engine.ts`/`score.ts` match `direction4L.ts`'s simpler threshold | **RESOLVED** — see updated §16 |
| Bollinger conflict | Same decision, same two files | **RESOLVED** — see updated §16 |
| `±12` vs `15` directional cutoff | Centralize to `DIRECTION_THRESHOLD=15` | **RESOLVED** — see updated §10, §18 |
| Look-ahead bias audit | Not requested yet | **Still open**, no work done |
| EMA 21/50 display-only | "Let's discuss the exact rule first" | **RESOLVED, your decision**: EMA9/21 AND EMA21/50 must now agree before EMA counts as aligned; wired into a new universal Master Trade Selector veto — see §6a below |

**Second update — Master Trade Selector EMA + Momentum-Burst confluence (new architecture, this session):** on your explicit decision, a new veto was added to `tryOpenOption` (`paper/engine.ts`), applied to **every** option idea type — index, stock, and scalp alike. This is the first time index-option entries are affected by any technical indicator; previously (§1, §10 below) they were purely OI-Command-driven. The veto only fires on an **active opposing** read; Neutral/flat never blocks (your explicit "flat = neutral" decision). See the new §6a for full detail.

---

## 6a. Master Trade Selector — EMA + Momentum-Burst Confluence Veto (new this session)

**What it is:** a new universal veto step in `tryOpenOption` (`paper/engine.ts`, right after the Risk Radar veto), backed by a new `TickDeps.getConfluenceVeto` and a new pure module `signals/emaConfluence.ts`.

**EMA confluence** (`emaConfluenceDirection`, `signals/emaConfluence.ts`):
- **EMA9/21** (`emaShortDirection`) — the exact same crossover already live elsewhere (`ema9>ema21` Bullish, `ema9<ema21` Bearish, else Neutral).
- **EMA21/50** (`emaLongDirection`) — reuses BOTH pre-existing `marketCommentary.ts` factors verbatim (`commentary/marketCommentary.ts:156-163`): "21/50 EMA" (price vs both EMAs) AND "EMA Cross" (EMA21 vs EMA50), and requires them to **agree with each other** before calling a direction. This was a deliberate choice to combine two already-existing display-only conditions rather than invent a new formula or pick one over the other — flagged here in case you intended only one of the two.
- **Confluence** = EMA9/21 direction AND EMA21/50 direction must agree with **each other**; any disagreement, or either being Neutral/insufficient-history (<50 bars), reads as Neutral overall.

**Momentum Burst** (`scalp/momentum.ts`'s existing `computeMomentumBurst`, unchanged) — its `direction: "up"|"down"|"flat"` is read directly; `"flat"` maps to Neutral.

**The veto rule:** for an idea with `direction: "Bullish"|"Bearish"`, entry is blocked only if EMA confluence **or** Momentum Burst direction is the **opposite** of the idea's direction. Neutral/flat on either signal, or agreement, never blocks. This is a softer rule than a literal "both must actively confirm" dual-confluence gate — it's a veto-on-opposition, not a requirement-to-confirm, per your explicit "flat = neutral, does not block" decision.

**Scope:** applied unconditionally to every call into `tryOpenOption` — index options, stock options, and scalps — per your "all paths, including index options" decision. Both `emaConfluenceDirection` and `computeMomentumBurst` are computed fresh off 15m candles for whatever symbol the idea concerns (via `getCandlesCached`), matching the interval convention used by the Market Regime and Risk Radar checks.

**Architecture note:** this is implemented as a standalone early-veto step in `tryOpenOption`, structurally identical to the existing Market Regime and Risk Radar vetoes — **not** inside `paper/ext/tradeArbiter.ts`'s `arbitrate()` function. `arbitrate()` only ever runs for directional (non-scalp) ideas that reach the Sentiment/Liquidity/Risk extension pipeline (and only compares against a rival Scalp candidate when one exists), so it cannot provide universal coverage across index/stock/scalp ideas the way a `tryOpenOption`-level veto can. If you specifically want this fused into `arbitrate()`'s own candidate-eligibility logic instead (which would require restructuring how index-option and standalone-scalp ideas reach arbitration), say so and I'll redesign it.

**Tests:** `signals/emaConfluence.test.ts` (10 tests covering `emaShortDirection`/`emaLongDirection`/`emaConfluenceDirection` on synthetic up/down/flat/insufficient-history series). The live veto orchestration (`getConfluenceVeto` in `routes/api.ts`) is not unit-tested — it's a thin I/O wrapper (candle fetch → pure function calls), consistent with how `getRegime`/`getRiskRadar` are also untested at that layer for the same reason.

**Unrelated fix made in passing:** `backend/orb/OpeningRangeBreakoutEngine.ts` (a pre-existing file, not part of this task) had a one-byte encoding corruption (`nv�mber` instead of `number` in the `OrbRange.barsSeen` field type) that broke the whole project's typecheck. Fixed as a typo — no design change.

---

## 1. Current Architecture

The app has **three independent idea-generation paths** feeding **one shared entry gate**:

```
Index-option ideas  ──┐
Stock-option ideas  ──┼──►  tryOpenOption()  ──► OPENED / Hindi skip-reason
Scalp ideas         ──┘      (paper/engine.ts)
Stock-intraday (equity) ideas ──► inline opener (no tryOpenOption) ──► OPENED / skipped
```

The three option-idea paths are **not** symmetric in which indicators/models feed them:

| Idea path | Primary direction source | Core 6 indicators (EMA/VWAP/MACD/RSI/Bollinger/Supertrend) involved? |
|---|---|---|
| Index options (`getIndexOptionIdeas`) | OI Command (`recommendOiTrades`, OI-only) | **No** — `oi/oiTrade.ts` imports no indicator functions at all |
| Stock options (`getStockOptionIdeas`) | `computeSignal` (HourlyPick gate) → `directionNoMomentum` (confirm gate) | Yes, in two stages (see §17) |
| Scalp ideas (`getScalpIdeas`) | `computeSignal` + `computeMomentumBurst` (must agree) | Yes |
| Stock intraday (`getStockIntradayIdeas`) | external to this audit's read set (not traced) | not traced |

Everything that survives idea generation converges on **`tryOpenOption`** (`backend/paper/engine.ts:947-1170`), which re-gates on an entirely different set of checks (risk, regime, cooldown, arbitration, capital) that never re-read the six core indicators. See §17 for the exact order.

---

## 2. Complete Decision Flow (as implemented, not as specified)

```
Market Data (candles, OI chain)
        │
        ├─► Index path: buildOiCommand(def) → recommendOiTrades() → oiGridToIdea()
        │        (OI Analysis + PCR only; Market Regime/Technical NOT consulted here)
        │
        └─► Stock path: runHourlyScan() → computeSignal() [EMA/VWAP/MACD/RSI/Bollinger/Supertrend]
                 → buildDayOpportunity()/directionFrom() [+ OI bias + futures]
                 → (if survives) computeDirection4L() → directionNoMomentum()
                 → (if direction matches) idea built, entryRules.srRoomOk + capTargetAndStop applied

                           ▼
                 idea: OptionIdea  (direction, strike, premium, target, stop, confidence)

                           ▼
              ════════════ tryOpenOption() ════════════
  1. global one-trade-at-a-time lock (symbol-scoped) / scale-in routing
  2. per-symbol stop-out cooldown
  3. DTE + confidence floor, clean-underlying floor
  4. MARKET REGIME veto (Compressed → hard block, ALL idea types)
  5. RISK RADAR veto (ATR spike / premium-swing danger → hard block, ALL idea types)
  6. Sentiment/Liquidity/Risk extension pipeline (directional, non-scalp only):
       scoreExtension() → regime/liquidity/sentiment/premium/wall/tradeScore
       → premium-decay veto / dedup suppress
       → MASTER TRADE SELECTOR: arbitrate() → GO / WAIT / CONFLICT
            CONFLICT or rival-wins-GO → entry blocked
  7. RR floor, net-of-cost RR, scalp cost gate, win-probability floor
  8. Heat cap (hard outside extension / advisory inside — documented policy)
  9. Cash check → OPENED (fresh entry, or routed to ScalingEngine if same symbol already open)
```

**Key finding:** OI Analysis and PCR decide index-option direction *exclusively*; the six core technical indicators decide stock-option/scalp direction (in two stages, with RSI/MACD/Bollinger explicitly stripped at the second stage); Market Regime and Risk Radar apply uniformly to *all* option ideas at the `tryOpenOption` stage regardless of which path produced them; Master Trade Selector arbitration applies only to directional (non-scalp) ideas that go through the extension pipeline.

---

## 3. EMA Logic — **IMPLEMENTED (9/21 only); EMA 21/50 is DISPLAY ONLY**

### EMA 9/21 (the only EMA pair that scores or gates anything in the trading path)

| Field | `signals/engine.ts` / `signals/score.ts` | `signals/direction4L.ts` |
|---|---|---|
| Calculation | `ema(closes,9)`, `ema(closes,21)` — standard EMA, SMA-seeded (`indicators/index.ts:18-31`) | same |
| Input | `closes` from whatever candles the caller passes (15m for HourlyPick, 5m for scalps) | `c15` (15m) |
| Bullish | `ema9 > ema21` | same |
| Bearish | `ema9 < ema21` | same |
| Neutral | `ema9 === ema21` | folded into 0-vote |
| Score/weight | `WEIGHTS.emaCross = 22`; strength = `min(1, |spreadPct|/0.5)`; `contrib = ±22 * strength` | flat `-1/0/+1`, averaged with Supertrend+VWAP into the Trend layer, weight 25 |
| Calculated at | `engine.ts:36-57`, `score.ts:50,66-73` — **DUPLICATED, verified byte-identical** | `direction4L.ts:109-111` — separate binary model, same threshold |
| Consumed by | `runHourlyScan`→HourlyPick gate; `getScalpIdeas` | `getStockOptionIdeas`'s confirm gate (`directionNoMomentum`) |
| Affects entry? | **Index options: NO. Stock options & scalps: YES** (see §17) | same |

### EMA 21/50

Exists **only** in `backend/commentary/marketCommentary.ts:156-162` (price-vs-both + EMA21-vs-EMA50 cross, feeds a `conclusion` field on the commentary object) and `backend/routes/api.ts:2600-2605` (`computeHourOutlook`, feeds an hour-ahead score/direction). Both outputs are attached to the OI-Command JSON response (`payload.commentary`, `payload.bulletin`) for **display only** — neither is read by `recommendOiTrades`, `oiGridToIdea`, `buildDayOpportunity`, or `tryOpenOption`.

**`EMA 21/50 crossover logic is not currently part of the trade-entry/scoring pipeline.`** Tag: **DISPLAY ONLY**.

(Unrelated EMA50 sightings in `swing/monthly.ts`, `longterm/scan.ts`, `bigmove/radar.ts` are separate, non-intraday scan features behind their own display routes, not wired into any idea generator. **NOT APPLICABLE** to this trading engine.)

---

## 4. VWAP Logic — **IMPLEMENTED (stock options & scalps only)**

| Field | `engine.ts` / `score.ts` | `direction4L.ts` |
|---|---|---|
| Calculation | `vwap(candles)` — session-resetting at each new IST day (`indicators/index.ts:98-117`) | same |
| Bullish / Bearish | `price > vwap` / `price < vwap` | same |
| Score/weight | `WEIGHTS.vwap = 18`; strength = `min(1, |diffPct|/0.4)` | flat vote in Trend layer (weight 25) |
| Calculated at | `engine.ts:80-97`, `score.ts:53,82-87` — **DUPLICATED, verified identical** | `direction4L.ts:115-117` |
| Also appears at | `entryRules.ts:106,114` (`levelContext`'s bias nudge, 1 of 3 votes) and `highProbAlgo.ts:176-177` (`vwapBias`, pass/fail gate on `o.highProb`) — two more independent VWAP reads | |
| Affects entry? | **Index options: NO. Stock options: YES (four separate VWAP reads gate it). Scalps: YES.** | |

---

## 5. MACD Logic — **PARTIALLY IMPLEMENTED**

| Field | `engine.ts` / `score.ts` | `direction4L.ts` |
|---|---|---|
| Calculation | `macd(closes)` = 12/26/9 defaults (`indicators/index.ts:71-95`) | same |
| Bullish / Bearish | `histogram > 0` / `< 0` | same threshold |
| Score/weight | `WEIGHTS.macd = 18`; strength = `min(1, |hist|/(|macdLine|+1e-9))`; **floor `max(0.4, strength)`** (documented intentional — see §16) | flat vote in Momentum layer (weight 15), **no strength/floor** |
| Calculated at | `engine.ts:99-120`, `score.ts:54,89-96` — **DUPLICATED, identical** | `direction4L.ts:162-163` |
| Also independently computed at | `scalp/momentum.ts:74,77-79` — a *third* MACD read feeding `computeMomentumBurst`'s direction | |
| Affects entry? | Counts at the HourlyPick gate (`computeSignal`); **explicitly zeroed** at the final stock-option confirm gate (`directionNoMomentum` strips Momentum — "no RSI/MACD/BB/vol", `entryRules.ts:37-51`); counts twice for scalps (independently in `computeSignal` and `computeMomentumBurst`, both must agree). **Index options: NO effect.** | |

---

## 6. OI Analysis Logic — **IMPLEMENTED** (repointed this session; two-sided gap now RESOLVED)

Three layers exist, serving different purposes:

**(a) Raw ±1-ish score** — `oi/oi.ts:133-145`, `data/growwProvider.ts:557-567` (a near-duplicate of the same formula). `score += 1` if `pcr >= CONFIG.pcr.bullish`, `-1` if `<= CONFIG.pcr.bearish`; `+1`/`-1` per `ceBuildup`/`peBuildup` sign. `bias = score>=1?Bullish:score<=-1?Bearish:Neutral`. **No longer read by `direction4L.ts`** (verified — it imports only `oiChange.ts`). Still computed and exposed on `OiAnalysis.verdict.bias`/`.pcrState` for display surfaces. This layer still collapses simultaneous heavy CE+PE writing to the same `Neutral` as inactivity — the two-sided fix below was applied only to the canonical layer (b), per your decision; (a) is display-only and was not touched.

**(b) Canonical ±100 five-factor score** — `oi/oiChange.ts:74-266`, `computeOiChange()`. Factors: net CE/PE OI-change near ATM bias (±25), PCR (±15), futures buildup (±20), wall proximity (±10), heavy-buildup concentration (±10); clamped to ±100. **This is the canonical OI signal** (Decision 5) — `direction4L.ts`'s Derivatives layer and `dayOutlook.ts`'s `directionFrom` both read `oiVerdict`/`oiDirScore` from here, confirmed by direct read (no `oi.ts` import in either file).

**Two-sided/conflicted state — RESOLVED.** `classifyOiVerdict(oiDirScore, bothHeavyWriting)` (`oiChange.ts:77-82`) now returns `"TWO_SIDED"` instead of `"Neutral"` when the score is inside the ±20 neutral band **and** both `maxCeBuildup.veryHigh` and `maxPeBuildup.veryHigh` are true (simultaneous heavy CE+PE writing). The Bullish/Bearish bands are unaffected — `TWO_SIDED` only ever replaces what would have been `Neutral`. `OiChangeResult.oiVerdict`'s type is now `"Bullish" | "Bearish" | "Neutral" | "TWO_SIDED"`. Every consumer handles the widened type correctly: `direction4L.ts:130` and `dayOutlook.ts:52` both do `oiVerdict==="Bullish"?1:oiVerdict==="Bearish"?-1:0`, so `TWO_SIDED` correctly casts a neutral (0) directional vote while still being visible in the `note`/`reasons` text (`oiChange.ts:204-206`); `routes/api.ts:3048-3049,3125-3135` derives `oiDirection:"UP"|"DOWN"|"FLAT"` the same way (`TWO_SIDED`→`"FLAT"`, correctly no-trade) while still passing the raw `oiVerdict` through on the response payload so the distinction from genuine inactivity is visible to anyone reading it. Tested: `oi/oiChange.test.ts` (`classifyOiVerdict` unit tests + an end-to-end `computeOiChange` test with seeded baselines forcing both sides `veryHigh`).

**(c) `recommendOiTrades`** — `oi/oiTrade.ts:105+`. A higher-level *recommendation*, not a raw score: consumes `oiDirection`/`oiConfidence` (sourced from layer (b)), applies staleness (`>90s`), room-to-wall (`roomOk`), and confidence floors (`OI_DIR_MIN=60`, `OI_SCALP_MIN=50`, `OI_ALGO_FLOOR=68`) to produce `take`/`algoReady` flags. **This is the only OI output that index-option entries actually use** (via `oiGridToIdea`). `oiDirection` has no `TWO_SIDED` equivalent — a two-sided read reaches this layer as `"FLAT"`, same as genuine inactivity, which is the correct trading behavior (no clear direction to trade either way) even though the *reason* differs.

| | Input | Thresholds | Where calculated | Consumed | Affects entry? |
|---|---|---|---|---|---|
| (a) ±1 score | PCR, CE/PE buildup sign | `CONFIG.pcr` (1.2/0.8) | `oi.ts`, `growwProvider.ts` | display surfaces only | **NO** (retired from direction4L/dayOutlook) |
| (b) ±100 score | net OI Δ, PCR, futures, walls, heavy-buildup | `oiDirScore` ±20 verdict band; `TWO_SIDED` replaces Neutral when both sides `veryHigh` | `oiChange.ts` | `direction4L.ts` L3, `dayOutlook.ts`, `oiTrade.ts` | **YES** (feeds both idea paths) |
| (c) `recommendOiTrades` | (b)'s verdict + staleness + room | `OI_DIR_MIN=60`, `OI_SCALP_MIN=50`, `OI_ALGO_FLOOR=68` | `oiTrade.ts` | `oiGridToIdea` → index-option ideas | **YES — the sole direction source for index options** |

---

## 7. PCR Logic — **IMPLEMENTED** (centralized this session, Phase 1.3)

One canonical threshold pair, `CONFIG.pcr = { bullish: 1.2, bearish: 0.8 }` (`config/arbitration.ts`), now read by `oi.ts`, `growwProvider.ts`, `oiChange.ts`, `oi/bulletin.ts`, `commentary/marketCommentary.ts`, and `options/highProbAlgo.ts`'s score-bonus check. Previously 5 different pairs existed (1.2/0.7, 1.2/0.8, 1.05/0.85, 1.1/0.85, 1.1/0.7) — all collapsed to one except one **documented intentional exception**: `highProbAlgo.ts`'s trap-fail *veto* uses `CONFIG.pcrTrapFail = { bullishFailBelow: 0.7, bearishFailAbove: 1.2 }`, deliberately more extreme than the supportive threshold (a trade should only be vetoed when PCR strongly contradicts its direction, not merely when it's unsupportive).

Affects entry: yes, via OI score factor (b) above and via `highProbAlgo.ts`'s `evaluateBuyAlgo` score/veto (stock-option path).

---

## 8. Market Regime Logic — **IMPLEMENTED** (unified this session, Phase 1.1)

**One classifier**, `computeMarketRegime()` (`paper/ext/marketRegime.ts:60-103`), fractal + ATR based:
1. Fractal swing-slope (reuses `entryRules.levelContext`, sampled at 3 windows 8 bars apart): 3+ consecutive higher-high+higher-low → `Trending` (up); 3+ lower-high+lower-low → `Trending` (down).
2. ATR contraction: current ATR(14) < 85% of its 20-bar rolling average → `Compressed`.
3. Squeeze→fire transition (Bollinger-inside-Keltner burst state) → `Transitioning`.

Output: `MarketRegime = "Trending" | "Compressed" | "Transitioning"`.

**Orchestration** (new this session): `getMarketRegimeForSymbol(symbol)` (`routes/api.ts`, ~line 3471) fetches candles15m/daily/OI/burst-state for *any* symbol and calls the pure function above.

**Consumed by:**
- `TickDeps.getRegime` — **the live entry gate**: `tryOpenOption` hard-blocks on `regime === "Compressed"`, now applied to *every* option idea (scalp and OI-tagged included — this session closed a prior loophole where those bypassed the check).
- The same function's exit-check use of `rg.dir` for reversal detection.
- `/data-status` (TRADE-ZONE panel), `/paper/gate`, `/paper/why` — all now read the *same* engine, translated to legacy label text for the frontend.

**Intentionally NOT unified:** `classifyRegime()` (`routes/api.ts:2645-2671`) — a per-*timeframe* (5m/15m/1h) chop/whipsaw/lottery classifier for a different product surface (option-buyer caution), documented as a deliberate exception since it answers a different question than "what is the current regime."

Prior state (now resolved): 4 independent classifiers existed; 3 are now unified into this one engine, 1 is a documented exception.

Affects entry: **YES**, hard veto, applies to all option idea types.

---

## 9. Market Structure / Setup Logic (`entryRules.ts`) — **PARTIALLY IMPLEMENTED / scope-limited**

`levelContext()`: PDH/PDL/PDC (prior day), opening range 09:15–09:45 IST, VWAP, OI-derived major support/resistance (max PE-OI strike / max CE-OI strike, falling back to PDL/PDH), a 2-bar swing fractal over the last 40 bars, and a 3-vote bias nudge (price vs dayOpen/PDC/VWAP).

`srRoomOk()`: `minRoom = max(spot*0.003, 0.35*atrDaily)`; fails if the wall in the trade's direction is closer than that.

`capTargetAndStop()`: caps target at the major wall, scales profit-cap/floor-stop by ATR-derived volatility multiplier (clamped 0.7–1.6×), enforces ≥1.3 reward:risk by tightening the stop.

**Scope finding:** these Setup gates are a **hard block** only for the **stock-option** path (`getStockOptionIdeas`: `if (lv.bias !== expectedSign) return null; if (!room.ok) return null;`). The **index-option** path never calls them as a hard gate — Setup's levels reach index ideas only indirectly, via the extension pipeline's wall-reaction/dedup logic (which can suppress, not reject-at-source).

Affects entry: **YES for stock options (hard gate + target/stop rewrite); indirect/partial for index options (via dedup suppression only).**

---

## 10. Directional Logic — **DUPLICATED / PARALLEL across three independent scorers**

Three separate directional decision-makers exist, feeding two non-overlapping entry paths — they are **not** the same decision consumed the same way:

1. **`computeDirection4L`** (`signals/direction4L.ts`) — 4-layer weighted model: Market Structure 40% (PDH/PDL, opening range, HH/HL fractal, day-range position), Trend 25% (EMA9/21, Supertrend, VWAP), Derivatives 20% (OI via `oiChange.ts`, futures buildup, IV skew), Momentum 15% (RSI, MACD, Bollinger, Volume). `DIRECTION_THRESHOLD=15` (centralized in `score.ts:42`). **For index options, this is display/consensus-only** (feeds `correlateOiModels`, never `tryOpenOption`). **For stock options**, it runs a second time *without* the Momentum layer (`directionNoMomentum`) as a confirming veto on the direction already chosen by source #3 below.
2. **`recommendOiTrades`** (`oi/oiTrade.ts`) — the OI-only recommendation described in §6(c). **The sole direction source for index options.**
3. **`computeSignal`/`buildDayOpportunity`/`directionFrom`** (`signals/engine.ts`, `predict/dayOutlook.ts`) — the flat 6-indicator composite score blended 2:1.5:1.5 with OI-bias:futures-buildup. **RESOLVED this session**: `directionFrom`'s cutoff (`dayOutlook.ts:42`) now reads `sigDir = signal.score >= DIRECTION_THRESHOLD ? 1 : signal.score <= -DIRECTION_THRESHOLD ? -1 : 0`, importing the same `DIRECTION_THRESHOLD=15` from `signals/score.ts` used everywhere else — the previously-separate `±12` magic number is gone. This tightens stock-option/scalp idea generation slightly (a technical score of exactly 12–14 now votes Neutral instead of directional). **The primary direction source for stock options**, with #1 (minus Momentum) as a confirming filter.

Affects entry: **YES for all three**, but on disjoint paths — see the table in §1.

---

## 11. Risk Logic — **IMPLEMENTED** (RiskEngine wired this session, Phase 2.2)

**`computeRiskRadar`** (`options/riskRadar.ts:24-164`): 6 warning types over candles15m — ATR spike (`atrRatio>=1.4` caution, `>=1.8` danger, `ATR_SPIKE_DANGER`), no-trend chop (`ADX<20` caution), time-of-day (opening 15 min / post-2:45pm caution), unusual volume (`rvol>=2` caution, `>=3` danger), sharp candle (`>=2× ATR` caution), one-bad-bar premium swing (`>=25%` caution, `>=40%` danger, `PREMIUM_SWING_DANGER`), plus an always-on theta-reminder info note. Composite `spikeRisk` (0-100) and `level` (Low/Elevated/High).

**This session:** the two named danger-level reads (ATR spike ≥1.8×, premium swing ≥40%) are now a **hard veto inside `tryOpenOption`** via new `TickDeps.getRiskRadar`, applied to *every* option idea. Previously Risk Radar was attached only to already-open positions for display (`withRiskRadar`), never touching entry. All other warnings (chop, time-of-day, volume, sharp-candle, theta) remain advisory-only — no additional thresholds were invented, per the governing instruction.

**`riskComment.ts`'s `buildRiskComment`** — a *different* concern: the 4 capital guards (6% heat / −3% daily-loss / −10% drawdown / +15% profit-book). Enforcement policy (pre-existing, now also centrally documented in `config/arbitration.ts`): heat cap is **hard** outside the extension pipeline, **advisory** inside it (sizing already keys off `finalScore` there); daily-loss and drawdown are **always hard circuit breakers**, never advisory.

Affects entry: **YES** — Risk Radar danger veto (new, unconditional, checked before scoring); heat cap (hard/advisory split, documented); daily-loss/drawdown (always hard, enforced elsewhere in the tick loop).

---

## 12. Master Trade Selector Logic — **IMPLEMENTED** (verified + tested this session)

**`arbitrate()`** (`paper/ext/tradeArbiter.ts:47-94`): pure GO/WAIT/CONFLICT verdict over up to 2 candidates (Directional vs. rival Scalp on the same symbol).
- No eligible candidate → `WAIT`.
- Same direction, or a >6-point (`conflictScoreMargin`) score gap → `GO` the leader.
- Opposing direction AND within 6 points → `CONFLICT`, **unless** exactly one candidate clears `setupQuality>=50` (`setupQualityMinForOverride`), which promotes it to `GO` via a clarity override.

**Verified wiring** (`paper/engine.ts:1018-1049`): this call was *already* present before this session (with an in-code comment citing the exact prior gap — "the dashboard could show CONFLICT while a position opened anyway"). On `CONFLICT`, or on `GO` where the rival Scalp (not the Directional idea being evaluated) wins, `tryOpenOption` returns immediately with **no position opened**. This session added the first automated tests for this behavior (none existed before) — 5 tests in `paper/ext/tradeArbiter.test.ts`.

The same `arbitrate()` function, with the same thresholds, is also used by the `/oi-command` display (`extForOiPayload`) — so the dashboard's GO/WAIT/CONFLICT badge and the engine's entry decision share identical logic, though they execute at different times (15s HTTP cache vs. tick cadence) — a structural timing gap inherent to any separately-polled display, not a logic divergence.

Affects entry: **YES, confirmed — CONFLICT is load-bearing, not cosmetic.**

---

## 13–14. NIFTY and BANK NIFTY Support — **IMPLEMENTED, symmetric**

Both are defined identically in shape in `config/index.ts` (`type:"index", fno:true`; only the legitimately-different numeric F&O params — lot size 65 vs 30, strike step 50 vs 100 — differ). A full-repo grep found:
- **No function** that is supposed to be generic but accidentally hardcodes NIFTY only.
- A small number of **deliberate, documented** index-specific behaviors: the `/data-status` TRADE-ZONE panel intentionally reads both indices together as a market-wide conviction gauge (and uses NIFTY's regime as a display proxy on that one panel only); `scalpRupeeCaps` deliberately gives NIFTY tighter rupee caps (±700/-350) than other indices (±1000/-350) per an explicit user rule; `getIndexBiasFor` picks whichever of the two indices is the correct "parent" for a given stock.
- Every idea-generation function (`computeDirection4L`, `buildDayOpportunity`, `recommendOiTrades`) and the entry gate (`tryOpenOption`, `getRegime`, `getRiskRadar`) is symbol-parameterized with no symbol-specific branching beyond the above.

**Verdict: NIFTY and BANK NIFTY use the same decision-engine architecture.**

---

## 15. Duplicate Logic

| Logic | Locations | Status |
|---|---|---|
| EMA9/21, VWAP, MACD, RSI, Bollinger, Supertrend core formulas | `signals/engine.ts` vs `signals/score.ts` | **DUPLICATED — verified byte-identical**, intentionally (documented as the backtest/live parity clone) |
| OI PCR/buildup ±1 score | `oi/oi.ts` vs `data/growwProvider.ts` | **DUPLICATED** (near-identical formula in two files; retired as a directional input this session, still computed for display) |
| Directional decision | `computeDirection4L` vs `recommendOiTrades` vs `computeSignal`/`directionFrom` | **DUPLICATED / PARALLEL** — three independent scorers, no single path consumes all three (see §10) |
| PCR threshold pairs | formerly 5 pairs across `oi.ts`, `growwProvider.ts`, `oiChange.ts`, `bulletin.ts`, `highProbAlgo.ts`, `marketCommentary.ts` | **RESOLVED this session** — centralized to `CONFIG.pcr`, one documented exception (`CONFIG.pcrTrapFail`) |
| Market regime classifiers | formerly 4 (fractal+ATR, NIFTY-only ADX, per-symbol ADX, ADX+squeeze+whipsaw) | **RESOLVED this session** — 3 unified, 1 documented exception (`classifyRegime`, a different question) |
| MACD (third read) | `scalp/momentum.ts` independently recomputes MACD histogram for burst direction | **DUPLICATED** (a third, independent read, not reconciled with the other two) |

---

## 16. Conflicting Logic

| Logic | Conflict | Resolution status |
|---|---|---|
| RSI thresholds | ~~`engine.ts`/`score.ts` had overbought/oversold reversal zones (`<30`→bullish, `>70`→bearish); `direction4L.ts` had none~~ | **RESOLVED, your decision**: `engine.ts`/`score.ts` (`score.ts:99-103`, `engine.ts:122-145`) now use the same simple `>=55 bullish / <=45 bearish` momentum threshold as `direction4L.ts` — the 30/70 reversal-zone (mean-reversion) reading is gone. All three files agree. |
| Bollinger Bands | ~~`engine.ts`/`score.ts` scored price vs. the upper/lower bands (contrarian); `direction4L.ts` scored price vs. the middle band (trend-following)~~ | **RESOLVED, your decision**: `engine.ts`/`score.ts` (`score.ts:106-110`, `engine.ts:148-171`) now score price vs. the **middle band only**, matching `direction4L.ts`. The band-touch/contrarian reading is gone from all three files. |
| Supertrend weighting | Full weight on flip, no strength scaling, in *all three* files — this one is **NOT actually conflicting**, just non-scaled everywhere. Documented this session as an intentional design choice (binary trend-flip indicator, no validated strength proxy exists) | **Documented as intentional (Phase 3.1), no change made** |
| MACD's 0.4 strength floor | A barely-nonzero histogram still contributes 40% of weight in `engine.ts`/`score.ts`; `direction4L.ts` has no floor at all | **Documented as intentional (Phase 3.1)** — the floor keeps MACD's vote alive through the noisy MACD-line-near-zero crossover zone; not changed |
| OI two-sided writing | ~~Simultaneous heavy CE+PE writing collapsed to `oiVerdict:"Neutral"` in `oiChange.ts`, indistinguishable from inactivity~~ | **RESOLVED, your decision** — see updated §6. `oiChange.ts`'s canonical layer now returns `"TWO_SIDED"` in this case. `oi.ts`'s display-only ±1 score (no longer a directional input anywhere) was intentionally left untouched. |
| `directionFrom`'s `±12` sigDir cutoff vs. `DIRECTION_THRESHOLD=15` | Two different magic numbers doing the same conceptual job (score→direction cutoff) in different files | **RESOLVED, your decision** — see updated §10. `dayOutlook.ts` now imports and uses `DIRECTION_THRESHOLD=15`. |
| GainzAlgo vs. tradeScore | Two independently-weighted "should this fire" scorers — **verified NOT a true conflict**: `correlateOiModels`' consensus (which includes GainzAlgo as one vote) never gates `tryOpenOption`; only `tradeScore.ts` does | **Documented as intentional (Phase 3.2)**, kept separate by design |

**Cross-indicator disagreement scenarios (traced, not assumed):**

| Scenario | Explicit rule? | Actual behavior |
|---|---|---|
| OI bullish + EMA bearish (and all other cross-layer pairs: OI/EMA, EMA/VWAP, MACD/EMA) | No | Absorbed into the weighted layer-average / flat composite sum; no special-case logic exists anywhere for any indicator pair |
| CE writing + PE writing both heavy | **Now yes, for the canonical OI score** (see §6) | `oiChange.ts` surfaces `"TWO_SIDED"` distinctly from `"Neutral"`; the directional VOTE it casts is still 0 either way (correct — no lean either direction), but the reason is now visible in `oiReasons`/the OI-Command payload. `oi.ts`'s legacy ±1 score still collapses this to plain Neutral (display-only, not fixed). |
| Strong technical score + bad risk/regime read | **Yes** | Regime `Compressed` / Risk Radar danger are unconditional early `return`s in `tryOpenOption`, checked *before* any scoring runs — technical strength cannot override or even reach the check |
| Directional vs. rival Scalp, close score, opposing direction | **Yes** | Master Trade Selector's `CONFLICT` verdict — load-bearing, blocks entry (see §12) |

---

## 17. Actual Entry Gate (`tryOpenOption`, `paper/engine.ts:947-1170`) — exact order

1. Global one-trade-at-a-time lock (symbol-scoped) → same-symbol idea routes to **ScalingEngine** (`tryScaleIn`) instead of being blocked; different-symbol idea blocked outright (scalps use the strict, non-scaled lock).
2. Per-symbol stop-out cooldown (`CONFIG.cooldown.afterStopOutMinutes = 15`).
3. DTE + confidence floor, clean-underlying floor (`CLEAN_MIN=40`), OI-tagged confidence floor (55) vs. general floor (`CONFIRM_FLOOR=72`).
4. **Market Regime veto** — `Compressed` → hard block, all idea types.
5. **Risk Radar veto** — ATR spike ≥1.8× or premium-swing ≥40% → hard block, all idea types.
6. Sentiment/Liquidity/Risk extension pipeline (directional, non-scalp only): stale-data veto (this session, >90s parity with OI) → `scoreExtension` → premium-decay veto → dedup suppress → **Master Trade Selector** `arbitrate()` → CONFLICT/rival-GO blocks.
7. RR floor (`OPT_RR_MIN=1.3`), net-of-cost RR, scalp cost-multiple gate, win-probability floor (`WIN_PROB_MIN_DIR`/`WIN_PROB_MIN_SCALP`).
8. Heat cap (hard outside extension / advisory inside, documented policy).
9. Cash check → position opened.

**None of the six core technical indicators (EMA/VWAP/MACD/RSI/Bollinger/Supertrend) are read again inside this function** — they already did their work (if any) upstream, in idea generation.

---

## 18. Missing Logic (remaining gaps, after your follow-up decisions)

- ~~OI two-sided/conflicted state~~ — **RESOLVED**: `oiChange.ts` (the canonical layer) now distinguishes `TWO_SIDED` from `Neutral`. `oi.ts`'s legacy ±1 score (display-only) still collapses both to `Neutral`, left as-is since it's no longer a directional input.
- ~~RSI conflict~~ / ~~Bollinger conflict~~ — **RESOLVED**: `engine.ts`/`score.ts` now use the same thresholds as `direction4L.ts` for both (simple `>=55/<=45` for RSI, middle-band for Bollinger).
- ~~`directionFrom`'s ±12 cutoff~~ — **RESOLVED**: now imports `DIRECTION_THRESHOLD=15` from `signals/score.ts`.
- **EMA 21/50** is fully built (`marketCommentary.ts`, `computeHourOutlook`) but entirely display-only. Deferred at your request — pending the exact bullish/bearish/neutral rule, target entry path(s) (index/stock/scalp), and weight before any code is written.
- **Look-ahead bias audit** (Phase 3.4 of the prior plan) has not been performed — not requested since the audit was superseded, still available as a follow-up if wanted.

---

## 19. Logic That Is Display Only

- `classifyRegime()` (per-timeframe chop/whipsaw/lottery classifier, `/signal/:symbol`, multi-timeframe route)
- EMA21/50 crossover (`marketCommentary.ts`, `computeHourOutlook`)
- `correlateOiModels` consensus (incl. GainzAlgo vote) — feeds WhatsApp alerting and hourly-readiness scoring, never `tryOpenOption`
- The ±1-ish OI score (`oi.ts`/`growwProvider.ts`'s `verdict.bias`/`pcrState`) — still computed, no longer a directional input anywhere
- Most of `computeSignal`'s ~20 call sites (top-picks, movement scanners, next-day outlook, backtests) — only `runHourlyScan` and `getScalpIdeas` are load-bearing
- `scalpRupeeCaps`, chart overlays, and every route that only ever calls `res.json(...)` with no downstream consumption by an idea generator

---

## 20. Logic That Actually Affects Trading

- OI Analysis (canonical ±100 score) + PCR — the sole direction source for index options, and a contributing factor for stock options
- `recommendOiTrades`'s staleness/room/confidence floors — gates index-option ideas
- `computeSignal` (all 6 core indicators) + `directionFrom`'s blended vote — gates stock-option/scalp idea generation
- `computeDirection4L` minus Momentum (`directionNoMomentum`) — confirms/vetoes stock-option direction
- `entryRules.ts`'s Setup gates — hard-block stock-option ideas, rewrite target/stop
- Market Regime (`Compressed` veto) — blocks all option entries uniformly
- Risk Radar (2 named danger reads) — blocks all option entries uniformly
- Master Trade Selector (`arbitrate` CONFLICT) — blocks directional entries against a conflicting rival scalp
- RR/cost/win-probability floors, heat cap, cash — final sizing/capital gates
- ScalingEngine (`tryScaleIn`) — gates add-on entries to already-open positions
- Global one-trade-at-a-time lock — gates whether *any* new symbol can be considered at all while one is open

---

## Appendix — Status tag reference

`IMPLEMENTED` = built and actually wired into a live decision. `PARTIALLY IMPLEMENTED` = built, but only affects a subset of paths/stages. `DISPLAY ONLY` = computed and shown, never consumed by the entry gate. `NOT IMPLEMENTED` = does not exist in the code. `DUPLICATED` = the same logic exists in more than one place (intentionally or not). `CONFLICTING` = two implementations disagree on the same question.

This document was produced entirely via read-only investigation (direct reads plus three read-only research agents, each instructed not to modify any file). No code was changed.
