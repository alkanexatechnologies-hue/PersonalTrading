# Tasks — Universal Signal Engine Fix (15M Direction → 5M Timing)

TEST ZONE only, read-only, no auto-execution, no parameter tuning to force a
specific candle. Each task lists the requirements it satisfies. Tasks are ordered;
do them top-to-bottom. STOP points are noted.

## Group 0 — Prep (no behaviour change)
- [ ] 0.1 Create `tradeLifecycle.ts`; move `walkOutcomes`, `computeMetrics`,
      `computeDaily` out of `engine.ts`; update `engine.ts` + `htfEngine.ts` imports.
      (R1.4) — pure move, typecheck green.
- [ ] 0.2 Add a lint/unit guard test asserting `htfEngine.ts` does NOT import
      `analysis/classify.ts` or `analysis/outcome.ts`. (R2.2, R11.1)

## Group 1 — InstrumentConfig (R13, R3.4, R8, R6.3, R9)
- [ ] 1.1 Extend `InstrumentConfig` with all fields in design §13; wire defaults
      from the fixed baseline. No symbol-specific values. (R13.1)
- [ ] 1.2 Route every threshold/period/window the engine uses through
      `InstrumentConfig` (remove inline constants in `htfEngine`/`classify`).

## Group 2 — Data quality & warm-up (R9) — HIGH PRIORITY (root cause)
- [ ] 2.1 `htfRunner`: preload `warmupSessions` of candles before the window for
      **BOTH the 5M AND the 15M series**; compute indicators over the full series;
      emit records only inside the window. Keep per-session VWAP reset. (R9.2, decision 4)
- [ ] 2.2 Replace `minHistory` count-blocking with `dqStatus=NOT_READY` for the
      opening window (`openingWindowEndMinIST`, default 09:30) and for any indicator
      that returned null. (R9.1, R9.3)
- [ ] 2.3 Emit `warmupBars` and `dataDefects` separately; run-level `dataQuality`
      consistent with per-row (PASS only if dataDefects=0 on eligible bars). Replace
      `dataQualityIssues` in daily rows with the two counters. (R9.4, R9.5)
- [ ] 2.4 Test: warm-up/opening bars are NOT_READY, not defects; no PASS-with-issues
      contradiction. (T3)

## Group 3 — Pipeline reorder + candidate (R2, R4, R5)
- [ ] 3.1 Reorder `htfEngine` to: DQ → 15M map → 15M direction → timing → candidate
      → scores → protection → risk → final → lock. (R2.1, R2.3)
- [ ] 3.2 Candidate = direction + timing + (close<EMA9 OR ema9Slope<0). Remove ONLY
      the `sellScore+10` margin and composite-score threshold from candidate creation.
      Do NOT remove structure/UT (see 3.6b/3.6c). Always record `entryCandidate`. (R4.1–4.4, decision 3)
- [ ] 3.3 Independent scores + optional post-candidate threshold (default OFF) →
      `SCORE_BELOW_THRESHOLD`. Record `scoreComponents{}`. (R5)
- [ ] 3.4 `allBlockers[]` accumulation + `primaryBlocker` (first hard block);
      candidate never deleted by any gate. (R2.4)
- [ ] 3.5 Tests: candidate+R:R-fail ⇒ WAIT & preserved; NEUTRAL ⇒ DIRECTION_NEUTRAL;
      CONFLICT ⇒ DIRECTION_CONFLICT. (T3)
- [ ] 3.6 **(decision 4)** 15M readiness gate: if any required 15M indicator at the
      mapped bar is null/not-warm ⇒ direction NOT_READY ⇒ final WAIT,
      `primaryBlocker=HTF_NOT_READY`. Stop coercing null EMA to FLAT. (R3.6)
- [ ] 3.6b **(decision 3)** Structure opposite-confirmed ⇒ final WAIT,
      `primaryBlocker=STRUCTURE_OPPOSITE`, candidate preserved (final gate in step 9). (R4.5)
- [ ] 3.6c **(decision 3)** UT opposite ⇒ score penalty in `scoreComponents.utPenalty`
      only; never a gate. (R4.6)

## Group 4 — VWAP band events + consistency (R6)
- [ ] 4.1 Implement band-based BREAK/REJECTION/RETEST/CONTINUATION (bullish mirrored,
      break=RECLAIM) with `vwapBandAtr`, `retestBars`, `continuationBars`. (R6.3)
- [ ] 4.2 Record `priceSeries`, `vwapSeries`, `basis`; implement `vwapSpotAdj` for
      SPOT_DIRECTION. (R6.1, R6.2)
- [ ] 4.3 Synthetic unit tests for each event type × side. (T2)

## Group 5 — Protection (R7)
- [ ] 5.1 Refactor fake-move to a `fakeMoveRisk(t, prior)` returning score +
      `fakeMoveInputs{}` from close-time features only. (R7.1)
- [ ] 5.2 Change extended to `|close−VWAP|/ATR` (+ record EMA21 distance); NORMAL/
      EXTENDED/SEVERELY_EXTENDED; blocks NEW entries only. (R7.2)
- [ ] 5.3 Append-equality tests: fake & extended unchanged when future candles added. (T1)

## Group 6 — Risk (R8)
- [ ] 6.1 `decisionEntry = close(t)+slippageAllowance`; move `open(t+1)` to the
      analysis layer only. (R8.1)
- [ ] 6.2 **(decision 2 — no SL manipulation)** Add a confirmed-swing helper
      (latest lower-high for SELL / higher-low for BUY). SL = that swing ± `slAtrBuffer`.
      `minSlAtr` may ONLY WIDEN a too-tight SL. If SL distance > `maxSlAtr` ⇒ final
      WAIT, `primaryBlocker=SL_TOO_WIDE` (never pull SL closer). Record `slSource`
      (CONFIRMED_SWING | MIN_WIDENED). (R8.2)
- [ ] 6.3 Target modes STRUCTURE / SCALP; record `target1Source`. (R8.3)
- [ ] 6.4 `rr=(reward−costs)/(risk+costs)` on T1; gate `rrMinimum` (1.0). Never move
      SL/target to pass. Record sl/target/rr/costs **even on WAIT**. (R8.4, R8.5)

## Group 7 — Single-engine wiring (R1)
- [ ] 7.1 `runner.runTest` delegates to `htfEngine` via adapter (dashboard + Market
      Signal use the one engine). (R1.1)
- [ ] 7.2 Quarantine `engine.runEngine` to the A/B/C compare harness only; retire its
      production decision use. (R1.2, R1.3)
- [ ] 7.3 **(decision 5)** After the Phase B before/after comparison is signed off,
      DELETE `engine.ts`'s decision logic (`runEngine` + `leanBuy/leanSell` path).
      Keep only shared indicator/lifecycle code already moved to `components.ts` /
      `tradeLifecycle.ts`. (R1.3)

## Group 8 — Analysis layer (R11) — isolated
- [ ] 8.1 `analysis/outcome.ts`: outcome walk (uses `tradeLifecycle`), `entryActual=
      open(t+1)`, MFE/MAE. Engine cannot import it. (R2.2, R8.1)
- [ ] 8.2 `analysis/classify.ts`: EARLY/TIMELY/LATE/FALSE + MISSED (`missedMoveAtr`,
      `missedLookaheadBars`), forward-labelling only. (R11)

## Group 9 — Audit record + UI (R14/B10/B12)
- [ ] 9.1 Expand the per-candle record to the full B10 field set incl.
      `candleConvention`, warm-up flags, series/basis, blockers, risk-on-WAIT.
- [ ] 9.2 Market Signal step-by-step UI shows every candidate/timing candle with
      `primaryBlocker` + `allBlockers`. (B12)

## Group 10 — No-look-ahead & immutability (R12)
- [ ] 10.1 Replay N vs N+20 byte-identical for 1…N (ex analysis fields); 15M-map
      assertion `tf15.closeTime <= fiveMin.closeTime`. (T1)

## Group 11 — Regression (T4/T5)
- [ ] 11.1 1-Oct diagnostic (no hard-code): confirm SELL_CANDIDATE recorded at the
      bearish turn; final SELL or WAIT with explicit `primaryBlocker`; verify series.
- [ ] 11.2 Run 1-Oct + ≥10 sessions (NIFTY + SENSEX); `regression-report.md`
      before/after: candidates, finals by type, blockers by type, MISSED, warm-up vs
      defects.
- [ ] 11.3 Confirm acceptance criteria (requirements §Acceptance) all pass.

## STOP points
1. (done) `audit-report.md` → approved.
2. **This spec (`requirements.md`/`design.md`/`tasks.md`) → STOP for approval.**
3. After approval: implement Groups 0–10 with tests T1–T3 passing → report.
4. Produce `regression-report.md` (T4+T5) → review before any Phase-2 tuning.

## Explicit non-goals (guardrails)
- No tuning to make the 1-Oct candle trade.
- **(decision 6)** The 1-Oct Test-B result (4 trades / 100% win) is a meaningless
  sample and MUST NOT be used to select or justify any parameter value.
- No SL manipulation: SL is never pulled closer to pass R:R; too-wide ⇒ SL_TOO_WIDE WAIT.
- Structure/UT vetoes are reworked (STRUCTURE_OPPOSITE gate / UT score penalty), not deleted.
- No new indicators (MACD/RSI/BB/ADX/CCI/Stochastic); no period/weight optimization.
- No symbol-specific branches. No auto-execution. TEST ZONE stays read-only.
