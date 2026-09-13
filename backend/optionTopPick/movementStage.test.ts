import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMovementStage, isNoChaseStage } from "./movementStage";

const base = { movePct: 0, atrPct: 2, justCrossedResistance: false, justCrossedSupport: false, retracedFromExtremePct: 0, momentumDiverging: false };

test("classifyMovementStage: a tiny move relative to ATR is EARLY MOVE", () => {
  const r = classifyMovementStage({ ...base, movePct: 0.2 });
  assert.equal(r.stage, "EARLY MOVE");
});

test("classifyMovementStage: a move well past ATR is EXTENDED, and EXTENDED is a no-chase stage", () => {
  const r = classifyMovementStage({ ...base, movePct: 4.5 });
  assert.equal(r.stage, "EXTENDED");
  assert.equal(isNoChaseStage(r.stage), true);
});

test("classifyMovementStage: a moderate move is MOVING, not yet STRONG MOVE", () => {
  const r = classifyMovementStage({ ...base, movePct: 1.0 });
  assert.equal(r.stage, "MOVING");
});

test("classifyMovementStage: a significant, still-reasonable move is STRONG MOVE (continuation possible)", () => {
  const r = classifyMovementStage({ ...base, movePct: 2.5 });
  assert.equal(r.stage, "STRONG MOVE");
});

test("classifyMovementStage: a real pullback (retraced from the extreme) is flagged even mid-move", () => {
  const r = classifyMovementStage({ ...base, movePct: 1.2, retracedFromExtremePct: 0.4 });
  assert.equal(r.stage, "PULLBACK");
});

test("classifyMovementStage: a fresh resistance break with no retracement is BREAKOUT", () => {
  const r = classifyMovementStage({ ...base, movePct: 1.2, justCrossedResistance: true });
  assert.equal(r.stage, "BREAKOUT");
});

test("classifyMovementStage: momentum divergence on a significant move is REVERSAL WATCH, and is also no-chase", () => {
  const r = classifyMovementStage({ ...base, movePct: 2.5, momentumDiverging: true });
  assert.equal(r.stage, "REVERSAL WATCH");
  assert.equal(isNoChaseStage(r.stage), true);
});

test("classifyMovementStage: EXTENDED always wins over a breakout label — no-chase is never overridden by a fresher-looking signal", () => {
  const r = classifyMovementStage({ ...base, movePct: 5, justCrossedResistance: true });
  assert.equal(r.stage, "EXTENDED");
});
