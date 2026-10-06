# Phase A — Audit Report: Universal Signal Engine (15M Direction → 5M Timing)

Scope: TEST ZONE only (research/read-only). **No code was changed for this audit.**
Everything below was read from the current source, not from memory of the spec.

Two engines currently exist in the Test Lab:

- **Base engine** — `backend/testlab/engine.ts` (`runEngine`). Single-timeframe
  (all indicators on the configured timeframe). This is the path that produced
  the 1-Oct 5m run (77 candles, 27 R:R blocks, 7 fake-move blocks,
  `dataQualityIssues = 30` while run-level `dataQuality = PASS`).
- **HTF engine (V1.2)** — `backend/testlab/htfEngine.ts` (`runHtfEngine`), with
  `htfRunner.ts`. 15M direction → 5M timing → risk. Newer; partially matches the
  Phase B target but has defects noted below.

The report evaluates the production decision path against the command's A1–A9.
Status key: IMPLEMENTED / PARTIAL / MISSING / WRONG.

---

## Summary table

| Item | Status | Evidence (file · function) | Defect | Proposed fix (Phase B) |
|---|---|---|---|---|
| A1 separate 15M state | PARTIAL | `htfEngine.direction15Series` computes a real 15M state; base `engine.ts` is single-TF only | Base engine (the one that ran 1-Oct) has NO 15M direction | Make the 15M→5M HTF path the production pipeline; retire single-TF as "Test A" compare only |
| A1 15M native vs aggregated | IMPLEMENTED | `htfRunner.fetchSeries` fetches interval `15` natively; `dhanData.DHAN_NATIVE_INTRADAY` includes 15 | — | Keep native 15M (document boundary = candle START label) |
| A1 which 15M per 5M | IMPLEMENTED | `htfEngine.map5to15`: `while (c15[j].time+900 <= c5[i].time+300) j++; idx=j-1` | — | Keep; add explicit T1 assertion test |
| A1 1M/3M influence | IMPLEMENTED (not used) in HTF; PARTIAL in base | HTF fetches only 5M+15M; base `runner` fetches `cfg.timeframe` which *can* be 1m/3m | Base engine will use 1m/3m if selected | Production path must hard-restrict to 5M+15M |
| A1 timestamp convention | WRONG (undocumented) | Dhan timestamps are candle **start**; code uses `time+interval` as close (`map5to15`, chart `t`) but it is nowhere documented for users | Ambiguity risk in 15M mapping | Document: label = bar START (12:05 ⇒ 12:05–12:10) and record `candleConvention` in the audit row |
| A2 pipeline order | PARTIAL | HTF order: indicators → direction → vwapEvent → scores → entryCandidate → dataQuality → risk gates → signal | DataQuality runs AFTER candidate in HTF (should be first); base has no candidate stage | Reorder to the exact Phase-B sequence (DQ first) |
| A2 R:R before candidate? | WRONG (base) / OK (HTF) | Base `engine.ts`: `leanBuy/leanSell` (score) then gates incl. R:R; no candidate record survives a WAIT. HTF keeps `entryCandidate` on the row | Base: R:R failure leaves no candidate trace | Candidate must be created and locked BEFORE risk; R:R failure ⇒ WAIT + `primaryBlocker=RR_BELOW_MIN`, candidate preserved |
| A2 score before/after gates; can override | PARTIAL | Scores computed before gates; `hardGate` cannot be overridden by score (`block()` sets WAIT). BUT base uses score as the candidate gate (`leanBuy`) | Score is a *mandatory candidate gate* in base (should be post-candidate threshold) | B6: candidate = direction+timing; score threshold applies after ⇒ `SCORE_BELOW_THRESHOLD` |
| A3 mandatory conditions | WRONG (base) / PARTIAL (HTF) | Base: `leanBuy = buyScore>=buyThreshold && buyScore>=sellScore+10` (score mandatory). HTF `timingValid`: requires VWAP trigger + EMA + structure-not-opposite-confirmed + UT-not-opposite | HTF makes UT & structure quasi-mandatory; B5 wants only direction+timing+EMA | Candidate rule = direction permits side AND bearish/bullish timing event AND (close vs EMA9 OR EMA9 slope). BOS/UT/volume → score only |
| A4 VWAP series consistency | IMPLEMENTED (test lab) | FUTURES_INTERNAL: futures close vs futures VWAP; SPOT_DIRECTION: spot vs spot (`htfEngine`/`engine` use one series). `indicators.vwap` session-resets | No raw spot-vs-futures-VWAP in the test-lab engines | Add basis-adjusted option `vwapSpotAdj = futVWAP − basis`; record `priceSeries/vwapSeries/basis` (basis already on row) |
| A4 VWAP event types | PARTIAL | HTF `vwapEventAt`: APPROACHING/TOUCH/BREAK/REJECTION/RETEST/CONFIRMED/FAILED. Base engine: NONE | Base has no VWAP events; HTF events are heuristic & lack a configurable tolerance band | Implement B4 band-based BREAK/REJECTION/RETEST/CONTINUATION with `vwapBandAtr` |
| A5 fake-move inputs causal | IMPLEMENTED | `components.fakeMoveAt(window)` uses current candle + prior 6-bar window only (indices ≤ current) | — (no look-ahead) | Keep; add append-equality unit test (B7/T1) |
| A5 extended measured from | WRONG (vs target) | `engine.ts`/`htfEngine.ts`: `distEmaATR = |close − EMA9| / ATR; extended = distEmaATR > extendedAtrMult(3)` | Measured from **EMA9**, not VWAP; B8 wants `|close − VWAP|/ATR` | Change to `extension = |close − VWAP|/ATR`; also record EMA21 distance for diagnostics |
| A6 entry | PARTIAL | `engine.ts`/`htfEngine.ts`: `entry = next.open` used for BOTH R:R and outcome | B9 wants decision entry = close(t)+slippage; outcome entry = open(t+1) | Split decisionEntry vs outcomeEntry; add `slippageAllowance` |
| A6 SL | PARTIAL | SL = swing (support/resistance from `supportResistance`) ± `slAtrBuffer×ATR`; no clamp | No `[minSlAtr,maxSlAtr]` clamp; swing may be unconfirmed | Add clamp + require confirmed swing |
| A6 target choice | PARTIAL | T1 = opposing swing if beyond entry, else `ATR×targetAtrMult(2.5)`; structure preferred when both exist | No SCALP mode; no "nearer level" cap on ATR target | Add STRUCTURE/SCALP target modes (B9) |
| A6 R:R on T1/T2, costs | PARTIAL | `rr` computed on **Target 1** (`engine.ts`); **no costs** in formula | Costs not included | `rr = (reward − costs)/(risk + costs)` on T1 |
| A7 data quality 30 issues | WRONG (contradiction) | `engine.ts`: first `minHistory=30` bars get `INSUFFICIENT HISTORY` ⇒ `dataQuality=BLOCKED`; `computeDaily` sets `dataQualityIssues = rows.filter(dq!==PASS)`; `runner` run-level `dataQuality` ignores per-row warm-up ⇒ `PASS` | 30 "issues" = 30 warm-up bars mislabeled; run-level PASS contradicts them | Separate `warmupBars` (NOT_READY) from `dataDefects` (BLOCKED); PASS only if dataDefects=0 on eligible bars |
| A8 OI historical-only | IMPLEMENTED | `dhanData.fetchIntraday(oi:true)` → `engine.futuresOI = oi[i]`; no option-chain import anywhere in `backend/testlab/*` | — | Keep; add guard/test that live OI cannot be imported into replay |
| A9 classification | PARTIAL | `engine.classifyTiming`: EARLY/TIMELY/LATE/FALSE from realized outcome; MISSED never computed (heuristic/absent) | MISSED missing; classification lives inside the signal engine | Move to isolated analysis module; implement B11 MISSED with `missedMoveAtr/missedLookaheadBars` |

---

## Detail & evidence

### A1 Timeframe architecture
- **Separate 15M state:** `htfEngine.direction15Series()` computes EMA9/21, VWAP side, structure and regression on the 15M array and classifies STRONG_BULLISH…CONFLICT. The base `engine.ts` computes everything on the single configured timeframe — it has no 15M concept. The 1-Oct 5m run used the base engine, so that run had **no 15M direction at all**.
- **Native vs aggregated:** 15M is fetched **native** from Dhan (`htfRunner.fetchSeries` passes `nativeMin = 15`; `dhanData.DHAN_NATIVE_INTRADAY = {1,5,15,25,60}`). No 5M→15M aggregation, so no boundary logic to audit (and no aggregation bug).
- **Which 15M per 5M (last completed):** `htfEngine.map5to15()` advances `j` while `c15[j].time + 900 <= c5[i].time + 300` and uses `j-1`. Since Dhan `time` is the candle **start**, `time+900`/`time+300` are the **close** instants; the mapped 15M is the last one whose close ≤ the 5M close. This is causal (no look-ahead), but relies on the start-label convention which is **not documented**.
- **1M/3M:** The HTF path fetches only 5M and 15M. The base engine fetches `cfg.timeframe`, which may be `1m`/`3m` if selected — so 1M/3M *can* drive the base engine. Production must forbid this.
- **Timestamp convention:** **candle START.** `12:05` = bar covering 12:05–12:10, closing 12:10. This is implicit in `time+interval` arithmetic but written nowhere user-facing. **Defect:** must be documented and stamped on each record (`candleConvention`).

### A2 Pipeline order
- HTF actual order (`runHtfEngine` loop): compute 5M indicators → map 15M → `master` direction → `vwapEventAt` → component scores → `entryCandidate` (direction+timing) → data-quality block → risk gates (fake → extended → expiry → late → structure → R:R) → `signal`. **Data quality is computed after the candidate** (should be step 1).
- **R:R before candidate?** In the **base** engine there is no candidate object: `leanBuy/leanSell` (a score test) decides intent, then gates run; a WAIT leaves no "candidate" marker in the row — so a failed R:R effectively erases the fact that a setup existed. In **HTF**, `entryCandidate` is written to the row regardless of the final signal, so R:R failure does **not** delete it. Target: candidate must always be locked before risk.
- **Score override:** A score cannot override a `hardGate` (gates call `block()` → WAIT). But the base engine uses the score itself as the candidate gate (defect).

### A3 Mandatory conditions on the candidate path
- **Base engine (`engine.ts`):** `const leanBuy = buyScore >= cfg.buyThreshold && buyScore >= sellScore + 10;` (and mirror for sell). The composite score (trend/structure/participation/momentum/volatility) is therefore a **mandatory** condition for any candidate — exactly what B5/B6 forbid.
- **HTF engine (`htfEngine.timingValid`):** requires a VWAP trigger event **and** EMA pressure **and** `!structure.startsWith("Bearish/conf")`/`Bullish/conf` **and** `utState !== opposite`. So structure and UT act as quasi-mandatory vetoes. B5 wants only: direction permits side + timing event + (close vs EMA9 or EMA9 slope). BOS/UT/volume should be score inputs only.

### A4 VWAP
- Test-lab engines compare a **consistent** series: FUTURES_INTERNAL = futures close vs futures VWAP; SPOT_DIRECTION = spot close vs spot VWAP (`vwapSeries` on the same candle array; `indicators.vwap` resets each session). So the "spot close vs futures VWAP" basis-bias defect is **not present in the test-lab engines**. `basis` is already recorded per row.
- **Verify the 1-Oct numbers:** the quoted close 22643 / VWAP 22653 must be checked against `vwapInstrument`/`vwapSource` on the row to confirm whether they came from the futures series (FUTURES_INTERNAL) or spot (SPOT_DIRECTION) — this determines whether basis adjustment is even relevant for that case.
- VWAP events: only the HTF engine has them (`vwapEventAt`), and they lack a configurable tolerance band; the base engine has none.

### A5 Fake move & extended move
- `components.fakeMoveAt(window)` inputs: the current candle `t` and the prior 6-candle slice (`window.slice(j-6, j)`); it compares `t`'s high/low/close to prior swing high/low. **All inputs are at indices ≤ t — no future candles.** Needs an explicit append-equality test to lock this guarantee.
- Extended: `distEmaATR = |price − EMA9| / ATR; extended = distEmaATR > extendedAtrMult` with `extendedAtrMult = 3` (`config.ts`). **Measured from EMA9**, not VWAP or entry structure. B8 specifies `|close − VWAP|/ATR`.

### A6 Risk
- Entry `= next.open` (`engine.ts`/`htfEngine.ts`) and is used for both the R:R calculation and the outcome walk. B9 wants decision entry = close(t)+slippage and outcome entry = open(t+1).
- SL = `support/resistance` swing from `supportResistance(window)` ± `slAtrBuffer×ATR`; **no min/max clamp**; swing may be provisional.
- Target T1 = opposing swing if on the correct side of entry, else ATR target `ATR×targetAtrMult(2.5)`; structure preferred when both exist. No SCALP mode.
- `rr` is computed on **Target 1**; **costs are not subtracted**.

### A7 Data quality — the contradiction explained
- Per candle, `engine.ts` sets `dataQuality = BLOCKED` with reason `INSUFFICIENT HISTORY` while `i < cfg.minHistory` (`minHistory = 30` in `config.ts`). For a ~77-candle 5m day, that is the **first 30 candles**.
- `computeDaily` reports `dataQualityIssues = drows.filter(r => r.dataQuality !== "PASS").length` → counts those 30 warm-up bars as "issues."
- The **run-level** `dataQuality` in `runner.ts` is `rows.length===0 ? BLOCKED : (FUTURES_INTERNAL && OI UNAVAILABLE ? BLOCKED : (OI UNAVAILABLE ? WARNING : PASS))` — it never looks at per-row warm-up, so with OI available it returns **PASS**.
- **Result:** `dataQualityIssues = 30` (all warm-up) alongside overall `PASS`. The 30 are **warm-up bars, not defects.** This is the root of the "PASS vs 30 issues" contradiction and must be split into `warmupBars` vs `dataDefects`.

### A8 Open interest
- OI is read only from Dhan historical derivative candles (`dhanData.fetchIntraday` with `oi:true`) and stored as `futuresOI`. No module under `backend/testlab/*` imports the live option-chain. Live OI is **not** substituted into replay. (Recommend a guard/test to keep it that way.)

### A9 Classification
- `engine.classifyTiming(row)` derives EARLY/TIMELY/LATE/FALSE from the realized outcome (SL ⇒ FALSE; win+confirmed-BOS ⇒ TIMELY; win+PRE/EARLY ⇒ EARLY; extended ⇒ LATE). **MISSED is not computed.** Classification currently lives inside the signal engine's outcome walk, not an isolated module.

---

## Root-cause conclusion (why 1-Oct produced almost no trades)
1. **No 15M master direction in the run that was tested** (base engine is single-TF) — so there was no "look only for SELL" gating; the engine waited for same-timeframe alignment.
2. **Candidate gated by composite score** (`leanBuy/leanSell`) — a weak-but-valid directional setup never becomes a candidate, so it is invisible.
3. **R:R computed with no preserved candidate** — the 27 R:R blocks erased any trace of the setups; the record cannot show "candidate existed but R:R failed."
4. **Extended measured from EMA9** (not VWAP) can mis-flag trend continuation as extended.
5. **Warm-up bars mislabeled as data issues** (30) create a misleading quality picture.

R:R minimum (currently `rrMin = 2.0` in `config.ts`; the command states TEST ZONE should be `1.0`) is a contributing factor but **not** the root cause — the pipeline ordering and the score-gated candidate are.

---

## Proposed fix outline (for the Phase B Kiro spec — not yet implemented)
- Make the HTF 15M→5M path the production pipeline; keep the single-TF engine only as "Test A".
- Reorder to: DataQuality → 15M mapping → 15M direction → 5M timing event → candidate → scores → protection → risk → final → lock+audit; analysis/outcome strictly separate.
- Candidate = direction + timing event + EMA relation (BOS/UT/volume are score-only).
- Preserve the candidate record through any WAIT; expose `primaryBlocker` + `allBlockers`.
- Band-based VWAP events; extended from `|close−VWAP|/ATR`; SL clamp; STRUCTURE/SCALP targets; R:R on T1 with costs; split decision vs outcome entry.
- Split `warmupBars` vs `dataDefects`; isolated MISSED module; document candle-START convention.

---

**STOP — awaiting approval of Phase A before producing `requirements.md` / `design.md` / `tasks.md` (Phase B spec). No code has been changed.**
