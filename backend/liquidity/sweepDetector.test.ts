import test from "node:test";
import assert from "node:assert/strict";
import { geometry, findSweeps, findRealBreaks, detectLiquidity, entryAfterSweepConcept, atr14Of, DetectionInput } from "./sweepDetector";
import { openingRange, previousWeekRange, buildLiquidityLevels, nearestLevel } from "./liquidityLevels";
import { LIQUIDITY_CONFIG, sweepBufferFor, NOT_DEFINED } from "./liquidityConfig";
import { oiStateFrom, vwapStateFrom, buildConfirmations, VIX_UNAVAILABLE } from "./liquidityAudit";
import { Candle } from "../types";

// ============================ Liquidity detection tests ============================
// These pin the SUPPLIED conditions exactly. Each of the three conditions for a
// sweep, and each of the three for a real break, is tested in isolation so a
// relaxed rule cannot pass unnoticed.

// 2026-09-14 is a Monday. 09:15 IST = 03:45 UTC.
const D = (hh: number, mm: number) => Math.floor(Date.UTC(2026, 8, 14, hh - 5, mm - 30, 0) / 1000);
const T0915 = D(9, 15);

const bar = (t: number, o: number, h: number, l: number, c: number, v = 1000): Candle =>
  ({ time: t, open: o, high: h, low: l, close: c, volume: v });
const min = (n: number) => T0915 + n * 60;

const BUF = LIQUIDITY_CONFIG.sweepBufferPts.default; // operator decision: 5 pts

// ---- config is the operator's, not inferred ----

test("operator decisions are the configured values", () => {
  assert.equal(LIQUIDITY_CONFIG.openingRange.startMinIST, 9 * 60 + 15);
  assert.equal(LIQUIDITY_CONFIG.openingRange.endMinIST, 9 * 60 + 20, "09:15-09:20 per operator decision");
  assert.equal(BUF, 5, "5-point buffer per operator decision");
  assert.equal(sweepBufferFor("^NSEI"), 5);
  assert.equal(sweepBufferFor("^NSEBANK"), 5, "same value for BANK NIFTY, read per-symbol");
  assert.equal(LIQUIDITY_CONFIG.trapWindow.endMinIST, 15 * 60 + 30, "full session per operator decision");
  assert.equal(LIQUIDITY_CONFIG.detectionInterval, "1m", "3m is not a supported Interval here");
});

test("undefined items are recorded as NOT_DEFINED, never given a value", () => {
  for (const k of ["equalHighs", "equalLows", "roundNumbers", "trendlineTouchPoints"] as const) {
    assert.match(NOT_DEFINED[k], /NOT_DEFINED/, k);
  }
  assert.match(NOT_DEFINED.indiaVix, /UNAVAILABLE/);
});

// ---- candle geometry ----

test("geometry computes wick and body shares of the total range", () => {
  // open 100, close 102, high 110, low 99 -> range 11, body 2, upper 8, lower 1
  const g = geometry(bar(min(0), 100, 110, 99, 102));
  assert.equal(g.range, 11);
  assert.equal(g.body, 2);
  assert.equal(g.upperWick, 8);
  assert.equal(g.lowerWick, 1);
  assert.ok(Math.abs(g.upperWickPct - 72.7) < 0.1);
  assert.ok(Math.abs(g.bodyPct - 18.2) < 0.1);
});

test("a zero-range candle yields 0% rather than dividing by zero", () => {
  const g = geometry(bar(min(0), 100, 100, 100, 100));
  assert.equal(g.upperWickPct, 0);
  assert.equal(g.bodyPct, 0);
});

// ---- opening range (09:15-09:20) ----

test("opening range uses only the 09:15-09:20 window", () => {
  const candles = [
    bar(min(0), 100, 120, 95, 110),  // 09:15 — inside
    bar(min(1), 110, 130, 108, 125), // 09:16 — inside
    bar(min(4), 125, 128, 120, 122), // 09:19 — inside
    bar(min(5), 122, 200, 50, 150),  // 09:20 — OUTSIDE (end is exclusive)
  ];
  const or = openingRange(candles, min(30));
  assert.equal(or.high, 130, "09:20 bar must not widen the range");
  assert.equal(or.low, 95);
  assert.equal(or.barCount, 3);
  assert.equal(or.established, true);
});

test("opening range is not established before the window ends", () => {
  const or = openingRange([bar(min(0), 100, 120, 95, 110)], min(2));
  assert.equal(or.established, false, "09:17 is inside the window");
});

test("opening range is null when no bars fall in the window", () => {
  const or = openingRange([bar(min(60), 100, 120, 95, 110)], min(90));
  assert.equal(or.high, null);
  assert.equal(or.low, null);
});

// ---- sweep: all three supplied conditions must hold ----

const withRange = (candles: Candle[], high = 130, low = 95): DetectionInput =>
  ({ symbol: "^NSEI", candles, rangeHigh: high, rangeLow: low, atr14: 20 });

test("upside sweep requires breach beyond buffer AND reclaim AND 60% wick", () => {
  const candles = [
    // breach 130+5=135: high 150, closes 132 (still above) — upper wick dominant
    bar(min(5), 132, 150, 131, 134),
    bar(min(6), 134, 136, 125, 128), // reclaim: closes 128 < 130
  ];
  const hits = findSweeps(withRange(candles));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direction, "UP");
  assert.equal(hits[0].sweepPrice, 150);
  assert.equal(hits[0].reclaimPrice, 128);
  assert.ok(hits[0].wickPct >= LIQUIDITY_CONFIG.sweepWickMinPct);
  assert.equal(hits[0].bufferUsed, BUF);
});

test("no sweep when the breach does not clear the buffer", () => {
  // high 134 < 130 + 5
  const candles = [bar(min(5), 131, 134, 130, 131), bar(min(6), 131, 132, 125, 128)];
  assert.equal(findSweeps(withRange(candles)).length, 0);
});

test("no sweep when the wick is below 60% of the range", () => {
  // high 150 clears the buffer, but the body dominates: open 132 close 148
  const candles = [bar(min(5), 132, 150, 131, 148), bar(min(6), 148, 149, 125, 128)];
  assert.equal(findSweeps(withRange(candles)).length, 0, "wick condition must not be skipped");
});

test("no sweep when the reclaim happens later than 2 candles", () => {
  const candles = [
    bar(min(5), 132, 150, 131, 134), // breach
    bar(min(6), 134, 140, 133, 138), // still above
    bar(min(7), 138, 142, 136, 140), // still above
    bar(min(8), 140, 141, 120, 125), // reclaim — 3 candles later, too late
  ];
  assert.equal(findSweeps(withRange(candles)).length, 0);
});

test("reclaim exactly 2 candles later still counts (1-2 candles)", () => {
  const candles = [
    bar(min(5), 132, 150, 131, 134),
    bar(min(6), 134, 138, 133, 136),
    bar(min(7), 136, 137, 120, 126), // reclaim at +2
  ];
  const hits = findSweeps(withRange(candles));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].reclaimPrice, 126);
});

test("downside sweep is the mirror of the upside rule", () => {
  // low 80 < 95 - 5 = 90, lower wick dominant, then closes back above 95
  const candles = [bar(min(5), 94, 95, 80, 93), bar(min(6), 93, 99, 92, 98)];
  const hits = findSweeps(withRange(candles));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direction, "DOWN");
  assert.equal(hits[0].sweepPrice, 80);
  assert.equal(hits[0].reclaimPrice, 98);
});

// ---- real break: all three supplied conditions must hold ----

test("real upside break requires 0.1xATR distance AND 60% body AND 2 holding candles", () => {
  // ATR 20 -> need > 2 points beyond 130. Close 140, body dominant.
  const candles = [
    bar(min(5), 131, 141, 130.5, 140),
    bar(min(6), 140, 145, 139, 143),
    bar(min(7), 143, 147, 142, 146),
  ];
  const hits = findRealBreaks(withRange(candles));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direction, "UP");
  assert.equal(hits[0].requiredDistance, 2);
  assert.equal(hits[0].atr14, 20);
});

test("no real break when the close is within 0.1xATR of the edge", () => {
  // close 131.5 is only 1.5 beyond 130; needs > 2
  const candles = [
    bar(min(5), 130.2, 132, 130, 131.5),
    bar(min(6), 131.5, 133, 131, 132),
    bar(min(7), 132, 134, 131.5, 133),
  ];
  assert.equal(findRealBreaks(withRange(candles)).length, 0);
});

test("no real break when the body is below 60% of the range", () => {
  // close 140 clears the distance, but a huge wick keeps body% low
  const candles = [
    bar(min(5), 137, 170, 130, 140),
    bar(min(6), 140, 145, 139, 143),
    bar(min(7), 143, 147, 142, 146),
  ];
  assert.equal(findRealBreaks(withRange(candles)).length, 0, "body condition must not be skipped");
});

test("no real break when a following candle closes back inside the range", () => {
  const candles = [
    bar(min(5), 131, 141, 130.5, 140),
    bar(min(6), 140, 142, 125, 128), // closes back inside
    bar(min(7), 128, 133, 127, 132),
  ];
  assert.equal(findRealBreaks(withRange(candles)).length, 0);
});

test("no real break when there are not yet 2 following candles", () => {
  const candles = [bar(min(5), 131, 141, 130.5, 140), bar(min(6), 140, 145, 139, 143)];
  assert.equal(findRealBreaks(withRange(candles)).length, 0, "must wait for confirmation rather than assume");
});

test("real downside break mirrors the upside rule", () => {
  const candles = [
    bar(min(5), 94, 94.5, 85, 86),
    bar(min(6), 86, 90, 84, 88),
    bar(min(7), 88, 92, 86, 90),
  ];
  const hits = findRealBreaks(withRange(candles));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direction, "DOWN");
});

// ---- trap ----

test("TRAP is flagged only when BOTH sides are swept in the window", () => {
  const candles = [
    bar(min(5), 132, 150, 131, 134), bar(min(6), 134, 136, 125, 128), // up sweep
    bar(min(20), 94, 95, 80, 93), bar(min(21), 93, 99, 92, 98),       // down sweep
  ];
  const r = detectLiquidity(withRange(candles));
  assert.equal(r.trapFlag, true);
  assert.equal(r.eventType, "TRAP");
  assert.equal(r.direction, "BOTH");
});

test("a single-sided sweep is not a TRAP", () => {
  const candles = [bar(min(5), 132, 150, 131, 134), bar(min(6), 134, 136, 125, 128)];
  const r = detectLiquidity(withRange(candles));
  assert.equal(r.trapFlag, false);
  assert.equal(r.eventType, "SWEEP");
  assert.equal(r.direction, "UP");
});

// ---- detection wrapper ----

test("detection reports a skip reason instead of guessing when the range is unset", () => {
  const r = detectLiquidity({ symbol: "^NSEI", candles: [bar(min(5), 1, 2, 0.5, 1.5)], rangeHigh: null, rangeLow: null, atr14: 20 });
  assert.equal(r.eventType, "NONE");
  assert.match(r.skipReason!, /opening range .* not established/);
});

test("detection reports a skip reason when there are no candles", () => {
  const r = detectLiquidity({ symbol: "^NSEI", candles: [], rangeHigh: 130, rangeLow: 95, atr14: 20 });
  assert.match(r.skipReason!, /no candles/);
});

test("real break with no ATR yields no real break rather than an assumed one", () => {
  const candles = [
    bar(min(5), 131, 141, 130.5, 140), bar(min(6), 140, 145, 139, 143), bar(min(7), 143, 147, 142, 146),
  ];
  const r = detectLiquidity({ ...withRange(candles), atr14: null });
  assert.equal(r.realBreak, null, "ATR(14) is required; it is never defaulted");
});

test("atr14Of returns null below 15 candles rather than a partial value", () => {
  assert.equal(atr14Of([bar(min(0), 1, 2, 0.5, 1.5)]), null);
});

// ---- §7 entry concept: reported, never connected ----

test("entry concept is the opposite of the sweep direction and is marked not connected", () => {
  const up = findSweeps(withRange([bar(min(5), 132, 150, 131, 134), bar(min(6), 134, 136, 125, 128)]))[0];
  const ce = entryAfterSweepConcept(up);
  assert.equal(ce.direction, "BEARISH", "upside sweep -> bearish, per the supplied concept");
  assert.match(ce.slConcept, /CONCEPT ONLY, not connected/);

  const down = findSweeps(withRange([bar(min(5), 94, 95, 80, 93), bar(min(6), 93, 99, 92, 98)]))[0];
  assert.equal(entryAfterSweepConcept(down).direction, "BULLISH");
  assert.equal(entryAfterSweepConcept(null).direction, "NONE");
});

test("the SL concept is not connected to execution", () => {
  assert.equal(LIQUIDITY_CONFIG.slBeyondWickPtsConcept.connected, false);
});

// ---- levels ----

test("previous week range uses the prior Monday-anchored week", () => {
  const day = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d, 4, 0, 0) / 1000);
  const daily = [
    bar(day(2026, 9, 7), 100, 120, 90, 110),  // Mon, prev week
    bar(day(2026, 9, 11), 110, 135, 95, 130), // Fri, prev week
    bar(day(2026, 9, 14), 130, 200, 50, 180), // Mon, current week
  ];
  const pw = previousWeekRange(daily);
  assert.equal(pw.high, 135, "current week must be excluded");
  assert.equal(pw.low, 90);
});

test("previous week range is null with only one week of data", () => {
  const pw = previousWeekRange([bar(Math.floor(Date.UTC(2026, 8, 14, 4, 0, 0) / 1000), 1, 2, 0.5, 1.5)]);
  assert.equal(pw.high, null);
});

test("the level set contains exactly the specified levels, with undefined ones marked", () => {
  const set = buildLiquidityLevels({
    intraday: [bar(min(0), 100, 130, 95, 120)],
    daily: [], pdh: 125, pdl: 92, swingHigh5m: 128, swingLow5m: 94,
    oi: { resistance: 24400, support: 24100 } as any,
    nowEpoch: min(30),
  });
  const byType = Object.fromEntries(set.levels.map((l) => [l.type, l]));
  assert.equal(byType.PDH.price, 125);
  assert.equal(byType.PDL.price, 92);
  assert.equal(byType.OR_HIGH.price, 130);
  assert.equal(byType.MAX_OI_CALL_STRIKE.price, 24400);
  assert.equal(byType.MAX_OI_PUT_STRIKE.price, 24100);
  assert.equal(byType.SWING_HIGH_5M.price, 128);
  // The four that were never defined must be null WITH a reason.
  for (const t of ["EQUAL_HIGH", "EQUAL_LOW", "ROUND_NUMBER", "TRENDLINE_TOUCH"]) {
    assert.equal(byType[t].price, null, t);
    assert.match(byType[t].note!, /NOT_DEFINED/, t);
  }
  // No level beyond the specified list.
  assert.equal(set.levels.length, 14);
});

test("nearestLevel ignores unavailable levels", () => {
  const n = nearestLevel([
    { type: "PDH", price: null, source: "-" },
    { type: "PDL", price: 100, source: "-" },
    { type: "OR_HIGH", price: 130, source: "-" },
  ] as any, 128);
  assert.equal(n!.price, 130);
});

// ---- audit field derivation ----

test("OI and VWAP states come from existing data and report UNAVAILABLE honestly", () => {
  assert.equal(oiStateFrom("long unwinding", null), "CALL_OI_UNWINDING");
  assert.equal(oiStateFrom("short buildup", null), "CALL_OI_ADDING");
  assert.equal(oiStateFrom(null, null), "UNAVAILABLE");
  assert.equal(vwapStateFrom(110, 100), "ABOVE_VWAP");
  assert.equal(vwapStateFrom(90, 100), "BELOW_VWAP");
  assert.equal(vwapStateFrom(null, 100), "UNAVAILABLE");
});

test("confirmations use the supplied wording and apply no score", () => {
  const c = buildConfirmations({
    direction: "UP", ceBuildup: "long unwinding", peBuildup: null,
    spot: 95, vwap: 100, ema21: 90, ema50: 95,
  });
  assert.match(c.oiNote, /supports genuine upside break/);
  assert.match(c.vwapNote, /wrong side of VWAP/);
  assert.match(c.emaNote, /sweep-biased/);
  assert.match(c.vixNote, /UNAVAILABLE/);
  // No numeric score anywhere in the confirmations.
  assert.ok(!("score" in (c as any)));
});

test("VIX is always the explicit UNAVAILABLE marker", () => {
  assert.equal(VIX_UNAVAILABLE, "UNAVAILABLE");
});
