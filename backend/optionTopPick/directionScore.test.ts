import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDirectionScore, pickWinningSide } from "./directionScore";
import { IndicatorVote } from "../types";

function vote(name: string, bias: "bullish" | "bearish" | "neutral"): IndicatorVote {
  return { name, value: "-", bias, weight: 1, reason: "-" };
}

test("computeDirectionScore: fully bullish inputs give CE the max score and PE zero", () => {
  const r = computeDirectionScore({
    signalVotes: [vote("EMA 9/21", "bullish"), vote("VWAP", "bullish"), vote("Supertrend", "bullish"), vote("MACD", "bullish"), vote("Bollinger", "bullish")],
    oiVerdict: "Bullish",
    pcrState: "bullish",
  });
  assert.equal(r.ceScore, r.maxScore);
  assert.equal(r.peScore, 0);
});

test("computeDirectionScore: OI structure is worth 2 points, every other vote 1", () => {
  const r = computeDirectionScore({ signalVotes: [], oiVerdict: "Bullish", pcrState: "neutral" });
  assert.equal(r.ceScore, 2);
});

test("computeDirectionScore: TWO_SIDED OI gives neither side the OI points", () => {
  const r = computeDirectionScore({ signalVotes: [], oiVerdict: "TWO_SIDED", pcrState: "neutral" });
  assert.equal(r.ceScore, 0);
  assert.equal(r.peScore, 0);
});

test("computeDirectionScore: missing signal votes fall back to neutral, not a crash", () => {
  const r = computeDirectionScore({ signalVotes: [], oiVerdict: "Neutral", pcrState: "neutral" });
  assert.equal(r.ceScore, 0);
  assert.equal(r.peScore, 0);
  assert.equal(r.ceVotes.length, 7);
});

test("pickWinningSide: a tied score returns null (Section 22 — no forced signal)", () => {
  assert.equal(pickWinningSide(6, 6), null);
});

test("pickWinningSide: a lead below minScoreEdge returns null even if nonzero", () => {
  assert.equal(pickWinningSide(6, 5), null); // edge=1, below the 2-point minimum
});

test("pickWinningSide: a real, sufficiently large lead returns the winning side", () => {
  assert.equal(pickWinningSide(7, 3), "CE");
  assert.equal(pickWinningSide(2, 6), "PE");
});

test("pickWinningSide: a large edge that's still numerically weak overall returns null", () => {
  // edge=3 (>=2) but winning score itself (3) is below minWinningScore (4).
  assert.equal(pickWinningSide(3, 0), null);
});
