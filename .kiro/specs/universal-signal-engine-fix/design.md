# Design — Universal Signal Engine Fix (15M Direction → 5M Timing)

TEST ZONE only, read-only. This design makes `htfEngine` the single decision
engine, enforces the strict pipeline, fixes warm-up/VWAP/extended/risk, and
isolates the outcome/MISSED analysis from the signal path. No parameter tuning.

## 1. Module map (after refactor)

```
backend/testlab/
  components.ts        indicator math (ema/atr/vwap/ut/linreg/S-R/fakeMove)  [reused]
  instrumentConfig.ts  InstrumentConfig (extended with all tunables)          [extended]
  tradeLifecycle.ts    NEW: walkOutcomes + computeMetrics + computeDaily      [moved out of engine.ts]
  htfEngine.ts         THE signal engine (steps 1–10); produces immutable records
  htfRunner.ts         fetch 5M+15M (+prior-session preload) + spot; calls htfEngine
  analysis/
    outcome.ts         NEW: outcome walk wrapper (uses tradeLifecycle)        [analysis layer]
    classify.ts        NEW: EARLY/TIMELY/LATE/FALSE + MISSED (forward-labelling) [engine MUST NOT import]
  engine.ts            LEGACY runEngine — quarantined; imported ONLY by the A/B/C compare harness
  htfAudit.ts          A/B/C compare + diagnostics + package writer
```

Import rule (enforced by review + a lint test): `htfEngine.ts` MUST NOT import
`analysis/classify.ts` or `analysis/outcome.ts`. The analysis layer imports the
engine's output, never the reverse.

## 2. Pipeline (htfEngine, per CLOSED 5M candle `t`)

```
1  DATA QUALITY   dqStatus = READY | NOT_READY(warmup/openingWindow) | BLOCKED(defect)
2  15M MAPPING    tf15 = last 15M bar with close(tf15) <= close(t)         (map5to15)
3  15M DIRECTION  direction15Series(tf15 history)                          (R3)
4  5M TIMING      vwapEvent (band-based)                                   (R6.3)
5  CANDIDATE      direction permits side AND timing event AND EMA relation (R4)
6  SCORES         buyScore/sellScore independent; optional threshold       (R5)
7  PROTECTION     fakeMoveRisk (close-time), extension=|close-VWAP|/ATR     (R7)
8  RISK           decisionEntry, SL(clamped), target(mode), rr=(rew-cost)/(risk+cost) on T1 (R8)
9  FINAL          BUY/SELL/WAIT + primaryBlocker + allBlockers[]
10 LOCK+AUDIT     immutable record (B10 fields, incl. sl/target/rr even on WAIT)
--- analysis layer (separate pass; never read by 1–10) ---
11 OUTCOME        outcome.ts: entryActual=open(t+1), MFE/MAE, outcome; classify.ts: EARLY/.../MISSED
```

`block(reason)` appends to `allBlockers[]`; the FIRST hard block is
`primaryBlocker`. Soft/score blocks are recorded but a candidate always persists.

## 3. Data quality & warm-up (R9)

- `htfRunner` preloads `warmupSessions` (config, default enough for EMA21/ATR/regression,
  ~2 prior sessions) BEFORE the requested window, for **BOTH the 5M and the 15M
  series** (decision 4). Indicators are computed over the full preloaded series;
  **only rows inside the requested window are emitted** as records. VWAP still
  resets per IST session.
- Evidence this matters: `ema()` returns null until the period-th bar, so a
  single-day 15M run has EMA21 null until ~14:15. Without 15M preload the direction
  would be emitted from partially-ready indicators (the defect in item 4).
- Opening window: `openingWindowEndMinIST` (default 09:30). Candles with
  `istMinute < openingWindowEndMinIST` ⇒ `dqStatus=NOT_READY`, reason `OPENING_WINDOW`.
- `minHistory` count-blocking is removed from signal eligibility (kept only as a
  numeric guard that indicators returned a value).
- Per-run tallies: `warmupBars` (NOT_READY) and `dataDefects` (BLOCKED on eligible
  bars). Run-level `dataQuality = dataDefects === 0 ? (warnings ? WARNING : PASS) : BLOCKED`.
  `dataQualityIssues` is replaced by the two explicit counters; daily rows carry both.

## 4. 15M direction (R3)
Reuse `direction15Series` (already native-15M, causal via `map5to15`). Make the
bull/bear evidence weights + classification cutoffs read from
`InstrumentConfig.direction` (currently hard-constants in `classify`). Record
`tf15Inputs{ema9, ema21, slope, vwapRel, regSlope, structure}` and `tf15CandleTime`.

**Readiness (decision 4 — defect fix).** `ema(values, period)` in
`backend/indicators/index.ts` returns `null` for indices `< period-1` (seeded by
the first SMA). `direction15Series` currently coerces a null EMA to `FLAT` and
still emits a direction. New rule: if any required 15M indicator at the mapped bar
is null/not-warm (EMA9, EMA21, ATR, regression per config), the mapped direction is
`NOT_READY`; the 5M record's final = WAIT with `primaryBlocker=HTF_NOT_READY`. With
the both-series preload (§3) this only occurs if there genuinely isn't enough
history even after preload.

## 5. VWAP consistency + band events (R6)
- `priceSeries`/`vwapSeries`: FUTURES_INTERNAL ⇒ both futures. SPOT_DIRECTION ⇒
  spot close vs `vwapSpotAdj = futuresVWAP − basis` when a futures contract overlaps,
  else spot-vs-spot (recorded). `basis` already computed per row.
- Replace heuristic `vwapEventAt` with band logic (`band = vwapBandAtr × ATR`,
  default 0.05), bearish shown (bullish mirrored, break = RECLAIM):
  - BREAK: prevClose ≥ VWAP−band AND close < VWAP−band
  - REJECTION: prevClose < VWAP AND high ≥ VWAP−band AND close < VWAP−band
  - RETEST: a BREAK within `retestBars` AND high within band of VWAP AND close < VWAP−band
  - CONTINUATION: close < VWAP AND close < prevLow AND within `continuationBars` of BREAK/RETEST AND not EXTENDED
- Note (verified): on 1-Oct the relevant candles are the futures series; basis is
  small, so the quoted 22643/22653 need no cross-series correction.

## 6. Candidate (R4 — corrected per approval item 3)
```
sellTiming = vwapEvent ∈ {BREAK, REJECTION, RETEST, CONTINUATION(SELL)}
SELL_CANDIDATE = direction∈{BEARISH,STRONG_BEARISH} AND sellTiming AND (close < EMA9 OR ema9Slope < 0)
```
BUY mirrored. From the candidate TEST we remove ONLY the `sellScore+10` margin and
the composite-score threshold (decision #5). `entryCandidate` is written to the
record unconditionally. The structure and UT conditions are NOT removed — they move
to well-defined places:
- **Structure opposite-confirmed** (confirmed bullish structure on a SELL candidate,
  i.e. `structure.startsWith("Bullish/conf")`) ⇒ candidate recorded, final=WAIT,
  `primaryBlocker=STRUCTURE_OPPOSITE`. Implemented as a FINAL hard gate in step 9,
  NOT inside the candidate test. (Provisional/ranging structure does NOT block.)
- **UT opposite** ⇒ score penalty only, recorded in `scoreComponents.utPenalty`;
  never a candidate veto and never a hard gate.

## 7. Scores (R5)
Keep independent buy/sell scoring (direction + timing + confirmations as additive
components, each recorded in `scoreComponents{}`). Config `scoreThresholdEnabled`
(default OFF) and `scoreThreshold`; when ON and candidate below ⇒ append
`SCORE_BELOW_THRESHOLD`.

## 8. Protection (R7)
- `fakeMoveRisk(t, prior)` returns a 0–100 risk + `fakeMoveInputs{}` from close-time
  features only. Append-equality test guarantees no future dependence.
- `extension = |close − VWAP| / ATR`; `extendedState = NORMAL | EXTENDED |
  SEVERELY_EXTENDED` by `extendedAtrMult` / `severeAtrMult`. Record `distFromEma21Atr`
  for diagnostics. Extended blocks NEW entries only.

## 9. Risk (R8)
- `decisionEntry = close(t) + slippageAllowance` (SELL subtracts). Outcome entry is
  `open(t+1)` and lives only in `analysis/outcome.ts`.
- `sl` (decision 2 — no manipulation): the **most recent CONFIRMED 5M swing** —
  a *lower-high* for SELL / *higher-low* for BUY — ± `slAtrBuffer×ATR`. This requires
  a confirmed-swing helper that returns the latest lower-high / higher-low (not the
  window's absolute extreme). `minSlAtr` may ONLY WIDEN a too-tight SL. If the SL
  distance > `maxSlAtr×ATR` ⇒ final WAIT, `primaryBlocker=SL_TOO_WIDE`; the SL is
  NEVER pulled closer to pass R:R. `slSource` recorded (CONFIRMED_SWING | MIN_WIDENED).
- `target1` by `targetMode`:
  - STRUCTURE: nearest confirmed opposing level within `maxTargetAtr×ATR`, else
    `targetAtrMult×ATR`; take the nearer; `target1Source` recorded.
  - SCALP: `scalpTargetAtr×ATR` capped at nearest opposing level.
- `rr = (reward − costs)/(risk + costs)` on T1; `costs = costAtr×ATR` or config
  points. Gate `rr >= rrMinimum` (TEST ZONE 1.0). On fail: WAIT, `RR_BELOW_MIN`,
  record stays. **sl/target/rr are recorded even on WAIT** (fixes current null gap).

**Root-cause evidence (1-Oct 12:10–12:40, from `rrEvidence.ts`).** The current code
takes SL from the window's absolute **swing high (22662)** which does not update as
price falls, so risk grows 75→167 pts; and T1 from the **nearest swing low just
under price**, so reward collapses 27→0.2 pts. rr falls to ~0 in the trend. The fix
is the confirmed-lower-high SL (far below 22662 in a downtrend ⇒ far smaller risk)
plus the SL_TOO_WIDE reject and the SCALP/structure target modes. **This is a
structural correctness change, not a tune to force 1-Oct**; all thresholds remain at
documented baseline defaults, and the 1-Oct Test-B result (decision 6) is not used
to choose any value.

## 10. Audit record (R14/B10)
Extend the per-candle record to the full B10 field set, including
`candleConvention="START (label=bar open; close=label+interval)"`, `warmupFlags`,
`dataDefects`, `priceSeries/vwapSeries/basis`, `timingEvent/timingSide`,
`fakeMoveInputs`, `extension/extendedState`, `entryDecision/sl/slSource/target1/
target1Source/target2/rr/costsUsed`, `primaryBlocker/allBlockers[]`, and the
separate analysis block `entryActual/outcome/mfe/mae/classification`.

## 11. Single-engine wiring (R1)
- `runner.runTest` (dashboard `/testlab/run`) delegates to `htfEngine` via a thin
  adapter (5M signal series + 15M direction series). The legacy single-TF path is
  no longer a production decision engine.
- `engine.runEngine` is **quarantined to the A/B/C comparison harness only** (imported
  solely by `htfAudit`), is NOT reachable from any production route, and SHALL be
  **deleted once the Phase B before/after comparison is signed off** (tasks 7.3).
  `walkOutcomes/computeMetrics/computeDaily` move to `tradeLifecycle.ts`; both
  `engine.ts` (while it survives) and `htfEngine.ts` import from there.

## 12. Testing (maps to T1–T5)
- T1 no-look-ahead: replay N vs N+20 byte-identical (ex analysis fields); 15M map
  assertion; fake/extended append-equality.
- T2 synthetic VWAP-event unit tests (BREAK/REJECTION/RETEST/CONTINUATION × side).
- T3 pipeline: candidate+R:R-fail ⇒ WAIT+candidate preserved; NEUTRAL ⇒ DIRECTION_NEUTRAL;
  warm-up ⇒ NOT_READY (not defect).
- T4 1-Oct diagnostic (no hard-code): BEARISH ⇒ SELL_CANDIDATE recorded; final may be
  SELL or WAIT but `primaryBlocker` explicit; verify series first.
- T5 regression: 1-Oct + ≥10 sessions (NIFTY+SENSEX); before/after candidates, finals,
  blockers, MISSED, warm-up vs defects.

## 13. InstrumentConfig additions
`direction{weights,cutoffs}`, `vwapBandAtr`, `retestBars`, `continuationBars`,
`openingWindowEndMinIST`, `warmupSessions`, `slAtrBuffer`, `minSlAtr`, `maxSlAtr`,
`targetMode`, `targetAtrMult`, `maxTargetAtr`, `scalpTargetAtr`, `rrMinimum`,
`costAtr`, `slippageAllowance`, `extendedAtrMult`, `severeAtrMult`,
`scoreThresholdEnabled`, `scoreThreshold`, `missedMoveAtr`, `missedLookaheadBars`.
Defaults are the documented baseline; nothing symbol-specific.

## 14. Risks / tradeoffs
- Prior-session preload increases fetch volume (more Dhan calls); mitigated by the
  existing chunked/rate-limited client and caching.
- SCALP mode changes trade character; it is OFF-by-default-equivalent via `targetMode`
  config and reported in A/B/C, not silently enabled.
- Moving outcomes to the analysis layer changes where metrics are computed; covered by T3.
