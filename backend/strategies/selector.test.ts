import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDaily, getOrLockDaily, _resetLocks, GATE_THRESHOLD } from "./selector";
import { neutralEvidence } from "./evidence";
import { ConditionSnapshot } from "./types";

function snap(over: Partial<ConditionSnapshot> = {}): ConditionSnapshot {
  return {
    symbol: "^NSEI", istDate: "2026-09-15",
    regime: "Trending", regimeDir: "up", burstState: "Normal", moveStage: "DEVELOPING",
    directionBias: "Bullish", openingBias: null, withinFirst30: false,
    sentimentState: "Bullish", wallReactionState: "UNCLEAR", atWall: false, liquidityState: "Normal",
    spot: 25000, expectedMovePts: 120, wallSupport: 24900, wallResistance: 25100,
    masterVerdict: "WAIT", dataStale: false, ...over,
  };
}

test("a strong uptrend selects Trend Continuation as PREFERRED", () => {
  const sel = selectDaily(snap({ regime: "Trending", regimeDir: "up", moveStage: "STRONG_MOVE", directionBias: "Bullish" }), neutralEvidence);
  assert.equal(sel.preferred?.id, "trend_continuation");
  assert.ok(sel.preferred!.score >= GATE_THRESHOLD);
  assert.equal(sel.preferred!.tier, "PREFERRED");
  assert.ok(sel.gate.passed);
});

test("a released squeeze selects Squeeze Breakout", () => {
  const sel = selectDaily(snap({ regime: "Compressed", regimeDir: "flat", burstState: "Fired Up", moveStage: "EARLY_MOVE", directionBias: "Neutral" }), neutralEvidence);
  assert.equal(sel.preferred?.id, "squeeze_breakout");
});

test("a trend pullback selects Pullback Continuation over plain Trend Continuation", () => {
  const sel = selectDaily(snap({ regime: "Trending", regimeDir: "up", moveStage: "PULLBACK", directionBias: "Bullish" }), neutralEvidence);
  assert.equal(sel.preferred?.id, "pullback_continuation");
});

test("no clear condition => NO SUITABLE STRATEGY (WAIT), preferred is null", () => {
  const sel = selectDaily(snap({ regime: "Transitioning", regimeDir: "flat", burstState: "Quiet", moveStage: null, directionBias: "Neutral", atWall: false, withinFirst30: false }), neutralEvidence);
  assert.equal(sel.preferred, null);
  assert.equal(sel.gate.passed, false);
  assert.match(sel.note, /WAIT|no trade/i);
});

test("stale data never produces a pick", () => {
  const sel = selectDaily(snap({ dataStale: true }), neutralEvidence);
  assert.equal(sel.preferred, null);
});

test("cold start: history insufficient, ranking is condition-match only (edgeWeight 1.0)", () => {
  const sel = selectDaily(snap({ regime: "Trending", regimeDir: "up", moveStage: "STRONG_MOVE" }), neutralEvidence);
  assert.equal(sel.historySufficient, false);
  // score == match when edgeWeight is 1.0
  assert.equal(sel.preferred!.score, sel.preferred!.match);
});

test("exactly one ALTERNATIVE tier is assigned when a second strategy is eligible", () => {
  // At an OI wall in a trend: wall_breakout + trend_continuation both eligible.
  const sel = selectDaily(snap({ regime: "Trending", regimeDir: "up", moveStage: "DEVELOPING", atWall: true, wallReactionState: "BREAK", directionBias: "Bullish" }), neutralEvidence);
  assert.ok(sel.preferred);
  const alts = sel.ranking.filter((r) => r.tier === "ALTERNATIVE");
  assert.equal(alts.length, 1);
  const notSuitable = sel.ranking.filter((r) => r.tier === "NOT_SUITABLE");
  assert.ok(notSuitable.length >= 3);
});

test("ineligible strategies can never be preferred and score 0", () => {
  const sel = selectDaily(snap({ regime: "Compressed", regimeDir: "flat", burstState: "Squeeze", moveStage: null, atWall: false, withinFirst30: false }), neutralEvidence);
  const orb = sel.ranking.find((r) => r.id === "opening_range_breakout")!;
  assert.equal(orb.eligible, false);
  assert.equal(orb.score, 0);
  assert.notEqual(sel.preferred?.id, "opening_range_breakout");
});

test("daily lock: the preferred strategy stays stable across intraday re-evaluation", () => {
  _resetLocks();
  const morning = getOrLockDaily(snap({ regime: "Trending", regimeDir: "up", moveStage: "STRONG_MOVE" }), neutralEvidence);
  assert.equal(morning.preferred?.id, "trend_continuation");
  assert.equal(morning.locked, true);
  // Later the condition drifts toward a wall break, but the day's pick is locked.
  const midday = getOrLockDaily(snap({ regime: "Trending", regimeDir: "up", moveStage: "DEVELOPING", atWall: true, wallReactionState: "BREAK" }), neutralEvidence);
  assert.equal(midday.preferred?.id, "trend_continuation");
  assert.equal(midday.locked, true);
  _resetLocks();
});

test("daily lock: a stale first read does not lock; a later valid read does", () => {
  _resetLocks();
  const dead = getOrLockDaily(snap({ dataStale: true }), neutralEvidence);
  assert.equal(dead.locked, false);
  const live = getOrLockDaily(snap({ regime: "Trending", regimeDir: "up", moveStage: "STRONG_MOVE" }), neutralEvidence);
  assert.equal(live.locked, true);
  assert.equal(live.preferred?.id, "trend_continuation");
  _resetLocks();
});
