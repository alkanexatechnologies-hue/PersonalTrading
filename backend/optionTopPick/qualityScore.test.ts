import { test } from "node:test";
import assert from "node:assert/strict";
import { computeQualityScore } from "./qualityScore";

test("computeQualityScore: everything maximally aligned scores near 100", () => {
  const r = computeQualityScore({
    stockDirectionFrac: 1, stockSetupFrac: 1, liquidityFlowFrac: 1, momentumFrac: 1,
    optionLiquidityFrac: 1, volumeFrac: 1, spreadFrac: 1, roomFrac: 1,
  });
  assert.equal(r.score, 100);
});

test("computeQualityScore: a neutral (not applicable) Liquidity/Flow input neither helps nor tanks the score", () => {
  const withNeutral = computeQualityScore({
    stockDirectionFrac: 1, stockSetupFrac: 1, liquidityFlowFrac: 0.5, momentumFrac: 1,
    optionLiquidityFrac: 1, volumeFrac: 1, spreadFrac: 1, roomFrac: 1,
  });
  const withZero = computeQualityScore({
    stockDirectionFrac: 1, stockSetupFrac: 1, liquidityFlowFrac: 0, momentumFrac: 1,
    optionLiquidityFrac: 1, volumeFrac: 1, spreadFrac: 1, roomFrac: 1,
  });
  assert.ok(withNeutral.score > withZero.score);
});

test("computeQualityScore: breakdown weights sum to 100", () => {
  const r = computeQualityScore({
    stockDirectionFrac: 0.5, stockSetupFrac: 0.5, liquidityFlowFrac: 0.5, momentumFrac: 0.5,
    optionLiquidityFrac: 0.5, volumeFrac: 0.5, spreadFrac: 0.5, roomFrac: 0.5,
  });
  assert.equal(r.breakdown.reduce((s, b) => s + b.weightPct, 0), 100);
});

test("computeQualityScore: score is always clamped to 0..100", () => {
  const r = computeQualityScore({
    stockDirectionFrac: 0, stockSetupFrac: 0, liquidityFlowFrac: 0, momentumFrac: 0,
    optionLiquidityFrac: 0, volumeFrac: 0, spreadFrac: 0, roomFrac: 0,
  });
  assert.equal(r.score, 0);
});
