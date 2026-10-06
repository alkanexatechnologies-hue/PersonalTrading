# Requirements — Universal Signal Engine Fix (15M Direction → 5M Timing)

Status: Phase B spec (awaiting approval). TEST ZONE only, read-only, no auto-execution.
Phase A approved with 9 decisions; those decisions are binding and encoded below.

## Glossary
- **Candidate** — a recorded intent to trade a side (BUY/SELL) produced by direction+timing, created BEFORE any risk evaluation and never deleted.
- **Final** — BUY / SELL / WAIT after all gates.
- **Record** — the immutable per-5M-candle audit object (steps 1–10). Analysis-layer fields (step 11) are stored separately and are never read by the signal engine.
- **NOT_READY** — an indicator/candle not yet usable (warm-up / opening window). Distinct from a data **defect**.

## R1 — Single signal engine
- 1.1 `htfEngine.ts` SHALL be the only decision engine. The Test Lab runner (`runner.ts` / production path) SHALL call `htfEngine`, not `runEngine`.
- 1.2 The single-timeframe decision logic in `engine.ts` (`leanBuy/leanSell` → signal) SHALL be retired from the production path. Its indicator calls already live in `components.ts`; those are reused.
- 1.3 `engine.ts`'s `runEngine` MAY be retained ONLY inside the A/B/C comparison harness as the legacy "Test A", clearly quarantined and not importable by the production path. No other duplicate decision engine SHALL exist.
- 1.4 Shared trade-lifecycle math (outcome walk, metrics, daily) SHALL move to a neutral module reused by the analysis layer (not owned by the retired engine).

## R2 — Decision pipeline order (every CLOSED 5M candle)
- 2.1 The engine SHALL execute, in this exact order: (1) Data Quality, (2) 15M mapping, (3) 15M direction, (4) 5M timing event, (5) candidate, (6) scores, (7) protection (fake/extended), (8) risk (entry/SL/target/R:R), (9) final + blockers, (10) lock+audit.
- 2.2 Steps 1–10 SHALL NOT read any outcome/forward data. Outcome + classification (step 11) SHALL be a separate module the engine cannot import.
- 2.3 Data Quality SHALL be step 1 (currently runs after candidate). 
- 2.4 R:R SHALL be evaluated only after a candidate exists. An R:R failure SHALL set final=WAIT with `primaryBlocker=RR_BELOW_MIN` and SHALL preserve the candidate record.
- 2.5 No score SHALL override a hard gate (data, direction, R:R, expiry, liquidity).

## R3 — 15M master direction
- 3.1 Direction SHALL be computed from completed 15M candles only.
- 3.2 For each 5M candle, the mapped 15M candle SHALL be the last 15M candle whose close time ≤ the 5M candle's close time (proven by test).
- 3.3 15M candles SHALL be native from the provider (no 5M→15M aggregation).
- 3.4 Classification STRONG_BULLISH/BULLISH/NEUTRAL/BEARISH/STRONG_BEARISH/CONFLICT SHALL be configurable via `InstrumentConfig`.
- 3.5 BULLISH/STRONG_BULLISH ⇒ only BUY evaluated; BEARISH/STRONG_BEARISH ⇒ only SELL; NEUTRAL ⇒ `DIRECTION_NEUTRAL`; CONFLICT ⇒ `DIRECTION_CONFLICT`; both ⇒ WAIT.
- 3.6 **(decision 4)** If ANY required 15M indicator is not yet warm (EMA9/EMA21/ATR/regression returns null during warm-up), direction SHALL be `NOT_READY` ⇒ final WAIT, `primaryBlocker=HTF_NOT_READY`. The engine SHALL NOT emit a BULLISH/BEARISH direction from partially-ready 15M indicators. (`ema()` returns null until the period-th bar — see design §4.)

## R4 — Candidate rule (decision 5, corrected per approval item 3)
- 4.1 `SELL_CANDIDATE` = 15M permits SELL AND a 5M bearish timing event AND (close < EMA9 OR EMA9 slope < 0). BUY mirrored.
- 4.2 Decision #5 removed ONLY the `buyScore >= sellScore + 10` margin and the composite-score threshold from candidate creation. BOS and volume are not mandatory for candidate creation (score/confidence only). The structure and UT conditions are NOT silently removed — see 4.5/4.6.
- 4.3 The score threshold MAY exist as optional post-candidate config, default OFF; failing it ⇒ `primaryBlocker=SCORE_BELOW_THRESHOLD` with the candidate preserved.
- 4.4 A candidate SHALL always be recorded even when final=WAIT.
- 4.5 **Structure opposite-confirmed** (e.g. a confirmed BULLISH structure on a SELL candidate) ⇒ the candidate IS still recorded, final=WAIT, `primaryBlocker=STRUCTURE_OPPOSITE`. This is a FINAL hard gate, not a candidate-creation veto.
- 4.6 **UT opposite** ⇒ a SCORE PENALTY only, recorded in `scoreComponents`. It is neither a candidate veto nor a hard gate.

## R5 — Scores (decision; B6)
- 5.1 `buyScore` and `sellScore` SHALL be independent (never `sell = 100 − buy`).
- 5.2 A score threshold, if enabled, SHALL apply AFTER candidate creation; failing it SHALL set `primaryBlocker=SCORE_BELOW_THRESHOLD` while preserving the candidate.

## R6 — VWAP (decision 9; B3/B4)
- 6.1 Price and VWAP SHALL be the same series: futures-close vs futures-VWAP, or spot-close vs basis-adjusted VWAP (`vwapSpotAdj = futuresVWAP − basis`). Raw spot vs raw futures VWAP SHALL NOT be used.
- 6.2 The record SHALL store `priceSeries`, `vwapSeries`, `basis`.
- 6.3 Timing events SHALL use a configurable tolerance band `band = vwapBandAtr × ATR` (default ~0.05) and SHALL detect: VWAP_BREAK, VWAP_REJECTION, VWAP_RETEST, CONTINUATION (bearish defined; bullish mirrored, break=RECLAIM) per the command's exact conditions.
- 6.4 Verified (Phase B input): the 1-Oct figures (close ≈ 22643 / VWAP ≈ 22653) correspond to the **FUTURES_INTERNAL** series (futures close vs futures VWAP; basis small), not raw spot. This SHALL be recorded in the design.

## R7 — Protection (close-time data only)
- 7.1 `fakeMoveRisk` SHALL use only candle `t` and prior candles (wick ratio of `t`, close distance beyond level in ATR, range vs ATR, volume vs average, prior failed breaks). A unit test SHALL fail if appending future candles changes the output.
- 7.2 Extended SHALL be `extension = |close − VWAP| / ATR` (replacing the current EMA9-based metric); EMA21 distance SHALL also be recorded for diagnostics. Extended SHALL block only NEW entries (`primaryBlocker=MOVE_EXTENDED`) and never alter an earlier locked record.

## R8 — Risk (B9)
- 8.1 Decision entry = close(t) + `slippageAllowance`. Outcome entry = open(t+1), used ONLY in the analysis layer.
- 8.2 **(decision 2 — no SL manipulation)** SL = the **most recent CONFIRMED 5M swing** — a *lower-high* for SELL / *higher-low* for BUY (NOT the absolute opposing swing) — ± `slAtrBuffer × ATR`. `minSlAtr` may ONLY WIDEN a too-tight SL. If the SL distance > `maxSlAtr × ATR` ⇒ final WAIT, `primaryBlocker=SL_TOO_WIDE`. The SL SHALL NEVER be pulled closer to pass R:R.
- 8.3 Target modes (configurable): `STRUCTURE` (nearest confirmed opposing S/R within `maxTargetAtr`, else ATR target; always the nearer) and `SCALP` (`scalpTargetAtr × ATR`, capped at nearest opposing level).
- 8.4 `rr = (reward − costs) / (risk + costs)` on **Target 1**. Gate `rr >= rrMinimum` (TEST ZONE default 1.0). Target/SL SHALL NEVER be adjusted to pass the gate.
- 8.5 The record SHALL store `sl`, `slSource`, `target1`, `target1Source`, `target2`, `rr`, `costsUsed`, `entryDecision` **even when final=WAIT** (current gap: these are null on WAIT rows).

## R9 — Data quality & warm-up (decision 4; B1)
- 9.1 Warm-up (EMA21/ATR/regression not yet available, or inside the opening window) SHALL be `NOT_READY`, not a defect.
- 9.2 **(decision 4)** Prior sessions' candles SHALL be preloaded for **BOTH the 5M AND the 15M series** so EMA/ATR/regression are warm at 09:15 on both timeframes; only session VWAP resets. Until an indicator on either series is warm, its bar is NOT_READY (5M) / HTF_NOT_READY (15M direction).
- 9.3 A configurable opening-window block (default 09:15–09:30, no signals) SHALL replace history-count blocking (`minHistory`).
- 9.4 The report SHALL count `warmupBars` and `dataDefects` separately. Run-level `dataQuality` SHALL be PASS only if `dataDefects = 0` on signal-eligible bars, and SHALL be consistent with per-row status (no PASS-with-30-issues contradiction).
- 9.5 Real defects (missing candle, stale feed, invalid OHLC, binding failure) SHALL be `BLOCKED`.

## R10 — Open interest
- 10.1 Historical OI SHALL be used only from historical derivative candles. Live option-chain OI SHALL NEVER be substituted into replay (guard/test enforced).

## R11 — Classification & MISSED (B11)
- 11.1 EARLY/TIMELY/LATE/FALSE and MISSED SHALL live in an isolated analysis module the signal engine cannot import.
- 11.2 MISSED = 15M permitted a side AND price then moved ≥ `missedMoveAtr × ATR` in that direction within `missedLookaheadBars` AND no candidate was produced before the move began. Forward data used for labelling only.

## R12 — No look-ahead / immutability (B/T1)
- 12.1 A finalized candle record SHALL be immutable. Replaying N vs N+20 candles SHALL yield byte-identical records for candles 1…N (excluding analysis-layer fields).

## R13 — Generalization & safety
- 13.1 All thresholds/periods/windows SHALL come from `InstrumentConfig`. No `if symbol === "..."` strategy logic. No hard-coded price/time/date (incl. the 1-Oct values).
- 13.2 TEST ZONE SHALL remain read-only; no automatic order execution.
- 13.3 No parameter SHALL be tuned to force one specific candle to trade.
- 13.4 **(decision 6)** The 1-Oct baseline (Test B: 4 trades, 100% win) is a tiny, statistically meaningless sample and SHALL NOT be used to select, justify, or validate any parameter value. All parameters stay at documented baseline defaults until a proper multi-session evaluation.

## R14 — UI & audit (B10/B12)
- 14.1 Every candle with a candidate or timing event SHALL be visible in the audit and the step-by-step UI with `primaryBlocker` + `allBlockers[]` and the full B10 record.

## Acceptance (maps to command §5)
Separate 15M direction from last completed 15M (tested) · candidate before R:R, never deleted · BOS/UT/volume not mandatory · consistent VWAP series · fake/extended close-time only (append test) · outcome entry = next 5M open · target never moved, R:R on T1 with costs · warm-up vs defects split, no contradictory PASS · candidate+timing visible with blockers · MISSED isolated · no symbol-specific code · read-only · no auto-exec.

## Phase B inputs captured (approval items 1, 2, 3, 4, 9)

### (1) R:R evidence — 1-Oct 12:10–12:40 (FUTURES_INTERNAL, from the read-only `rrEvidence.ts`)
| time | entry | SL source | SL | risk | T1 source | T1 | reward | rr |
|---|---|---|---|---|---|---|---|---|
| 12:10 | 22601.0 | swingHigh 22662 | 22676.4 | 75.4 | swingLow 22574 | 22574.0 | 27.0 | 0.36 |
| 12:15 | 22590.0 | swingHigh 22662 | 22676.8 | 86.8 | swingLow 22574 | 22574.0 | 16.0 | 0.18 |
| 12:20 | 22570.0 | swingHigh 22662 | 22677.4 | 107.4 | swingLow 22555 | 22555.0 | 15.0 | 0.14 |
| 12:25 | 22555.0 | swingHigh 22662 | 22677.2 | 122.2 | swingLow 22550 | 22550.0 | 5.0 | 0.04 |
| 12:30 | 22560.0 | swingHigh 22662 | 22677.3 | 117.3 | swingLow 22540 | 22540.3 | 19.7 | 0.17 |
| 12:35 | 22560.5 | swingHigh 22662 | 22676.7 | 116.2 | swingLow 22540 | 22540.3 | 20.2 | 0.17 |
| 12:40 | 22511.0 | swingHigh 22662 | 22677.8 | 166.8 | swingLow 22511 | 22510.8 | 0.2 | 0.00 |

**Root cause (not "wide SL + far target"):** SL is anchored to a single **stale swing high (22662)** that never updates as price falls, so **risk inflates** (75→167 pts) as the trade works. Target 1 is the **nearest swing low just under price**, which the falling price keeps catching, so **reward collapses** (27→0.2 pts). The asymmetry — risk far *above*, reward right *below* — drives rr→0 in a trend. This is exactly why decision #2 switches SL to the most recent **confirmed lower-high** (far below 22662 in a downtrend ⇒ small risk) and rejects (not pulls closer) when too wide.

### (2) Current htfEngine candidate gating (code-read)
Candidate = VWAP trigger event + EMA pressure + `structure not opposite-confirmed` + `UT not opposite`. It does NOT gate on score, BOS-confirmed, or volume. Per approval item 3, structure-opposite becomes a FINAL gate (STRUCTURE_OPPOSITE) and UT-opposite becomes a score penalty (see R4.5/4.6) — neither is silently removed.

### (3) Baseline — 1-Oct NIFTY 5m (current, unchanged) — before-comparison
77×5M / 26×15M, OI AVAILABLE, binding RESOLVED Oct. 15M dist NEUTRAL 35 / BULLISH 9 / BEARISH 33 (note: single-day run shows no STRONG_* because 15M EMA21 is not warm — see item 4). Test A (legacy single-TF) 0 signals; Test B (15M+5M, no risk) 15 SELL → 4 trades, 100% win; Test C (+risk) 0 trades (dominant blocker R:R). **Per decision 6 this is NOT evidence of an edge and must not drive any parameter choice.**

### (4) 15M warm-up (defect confirmed)
`ema(values, period)` (`backend/indicators/index.ts`) returns **null until the period-th bar** (then seeds with the first SMA). So on a SINGLE-day 1-Oct run the 15M EMA21 is null until ~14:15 (bar 21), EMA9 until ~11:15 (bar 9). In the TWO-day validation run (30-Sep preloaded), 15M was warm by 01-Oct 12:00, which is why STRONG_BEARISH appeared legitimately there. The DEFECT: `direction15Series` currently treats a null EMA as FLAT and still emits a BEARISH direction from the other signals instead of declaring NOT_READY. Fix (R3.6 + R9.2): preload BOTH 5M and 15M; if any required 15M indicator is unready ⇒ `HTF_NOT_READY` ⇒ WAIT.

### (9) Series
1-Oct ~12:00 price ≈ 22640 / VWAP ≈ 22652 (matching the quoted 22643/22653) = the **FUTURES_INTERNAL** series (futures close vs futures VWAP), basis small — no spot-vs-futures mismatch.
