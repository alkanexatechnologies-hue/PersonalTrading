import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMoveStage, isNoChaseStage } from "./moveStage";

const base = { movePct: 0, atrPct: 2, rvol: null, oiConfirming: false, premiumConfirming: false, retracedFromExtremePct: 0, momentumDiverging: false };

// H. Early move
test("classifyMoveStage: a tiny move relative to ATR is PRE_MOVE", () => {
  assert.equal(classifyMoveStage({ ...base, movePct: 0.1 }).stage, "PRE_MOVE");
});
test("classifyMoveStage: a small but real move is EARLY_MOVE", () => {
  assert.equal(classifyMoveStage({ ...base, movePct: 0.5 }).stage, "EARLY_MOVE");
});

// I. Strong continuation
test("classifyMoveStage: a strong move with 2+ independent confirmations is flagged continuationLikely", () => {
  const r = classifyMoveStage({ ...base, movePct: 2.0, rvol: 1.8, oiConfirming: true, premiumConfirming: true });
  assert.equal(r.stage, "STRONG_MOVE");
  assert.equal(r.continuationLikely, true);
});
test("classifyMoveStage: the SAME strong move with no confirmation is NOT flagged continuationLikely", () => {
  const r = classifyMoveStage({ ...base, movePct: 2.0, rvol: null, oiConfirming: false, premiumConfirming: false });
  assert.equal(r.stage, "STRONG_MOVE");
  assert.equal(r.continuationLikely, false);
});

// J. Extended move
test("classifyMoveStage: a move well past ATR is EXTENDED and is a no-chase stage", () => {
  const r = classifyMoveStage({ ...base, movePct: 4.5 });
  assert.equal(r.stage, "EXTENDED");
  assert.equal(isNoChaseStage(r.stage), true);
});
test("classifyMoveStage: +4.2% alone (spec's own example) is NOT automatically Strong/continuation — a low-ATR stock puts it at EXTENDED", () => {
  const r = classifyMoveStage({ ...base, movePct: 4.2, atrPct: 1.5, rvol: 3, oiConfirming: true, premiumConfirming: true });
  assert.equal(r.stage, "EXTENDED");
  assert.equal(isNoChaseStage(r.stage), true);
});

// K. Reversal
test("classifyMoveStage: momentum divergence at an already-extreme move is EXHAUSTION, also no-chase", () => {
  const r = classifyMoveStage({ ...base, movePct: 4.0, momentumDiverging: true });
  assert.equal(r.stage, "EXHAUSTION");
  assert.equal(isNoChaseStage(r.stage), true);
});
test("classifyMoveStage: momentum divergence at a moderate move is REVERSAL_WATCH (earlier warning than EXHAUSTION)", () => {
  const r = classifyMoveStage({ ...base, movePct: 1.5, momentumDiverging: true });
  assert.equal(r.stage, "REVERSAL_WATCH");
});

// O. Support breakdown / pullback distinction
test("classifyMoveStage: a real retracement from today's extreme is PULLBACK", () => {
  const r = classifyMoveStage({ ...base, movePct: 1.2, retracedFromExtremePct: 0.4 });
  assert.equal(r.stage, "PULLBACK");
});
