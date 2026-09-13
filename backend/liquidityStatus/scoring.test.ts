import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDirectionalConfidence, computeLiquidityFlowScore } from "./scoring";

test("computeDirectionalConfidence: a single dimension bullish never produces a strong reading (Section 24)", () => {
  const r = computeDirectionalConfidence([
    { bullish: true, bearish: false },
    { bullish: false, bearish: false },
    { bullish: false, bearish: false },
    { bullish: false, bearish: false },
    { bullish: false, bearish: false },
  ]);
  assert.equal(r.direction, "Bullish");
  assert.notEqual(r.quality, "VERY STRONG");
  assert.notEqual(r.quality, "STRONG");
});

test("computeDirectionalConfidence: agreement across all dimensions is VERY STRONG", () => {
  const dims = Array.from({ length: 5 }, () => ({ bullish: true, bearish: false }));
  const r = computeDirectionalConfidence(dims);
  assert.equal(r.direction, "Bullish");
  assert.equal(r.quality, "VERY STRONG");
});

// G / conflict precedent for scoring
test("computeDirectionalConfidence: 2+ dimensions on each side is CONFLICT, not an averaged direction", () => {
  const r = computeDirectionalConfidence([
    { bullish: true, bearish: false }, { bullish: true, bearish: false },
    { bullish: false, bearish: true }, { bullish: false, bearish: true },
    { bullish: false, bearish: false },
  ]);
  assert.equal(r.direction, "Conflict");
  assert.equal(r.quality, "CONFLICT");
});

// E. Strong price but weak liquidity: price/momentum dimensions bullish, OI/VWAP/EMA not -> should not reach a strong score
test("computeDirectionalConfidence: price moving but OI/structure not confirming stays weak, not strong", () => {
  const r = computeDirectionalConfidence([
    { bullish: false, bearish: false }, // OI unconfirmed
    { bullish: true, bearish: false },  // price up
    { bullish: false, bearish: false }, // VWAP unconfirmed
    { bullish: false, bearish: false }, // EMA unconfirmed
    { bullish: true, bearish: false },  // momentum up
  ]);
  assert.equal(r.direction, "Bullish");
  assert.ok(r.score < 60, `expected a weak/moderate score, got ${r.score}`);
});

// M. Volume spike without confirmation: RVOL alone should not push the flow score high
test("computeLiquidityFlowScore: a volume spike alone (everything else weak) does not produce a high score", () => {
  const r = computeLiquidityFlowScore({
    oiConfidence: 0, oiChangeMagnitudeFrac: 0, priceOiAgreeFrac: 0.5, rvol: 5,
    premiumConfirmFrac: 0.3, vwapAlignmentFrac: 0.3, emaAlignmentFrac: 0.3, momentumFrac: 0.3,
  });
  assert.ok(r.score < 50, `expected volume-only spike to stay well below a strong score, got ${r.score}`);
});

// F. Strong liquidity but weak price confirmation
test("computeLiquidityFlowScore: strong OI/premium confirmation but weak price/VWAP/EMA agreement caps the score below max", () => {
  const r = computeLiquidityFlowScore({
    oiConfidence: 90, oiChangeMagnitudeFrac: 1, priceOiAgreeFrac: 0, rvol: 1, premiumConfirmFrac: 1,
    vwapAlignmentFrac: 0, emaAlignmentFrac: 0, momentumFrac: 0.3,
  });
  assert.ok(r.score < 80, `expected a capped score with weak price confirmation, got ${r.score}`);
});

test("computeLiquidityFlowScore: breakdown weights always sum to 100", () => {
  const r = computeLiquidityFlowScore({
    oiConfidence: 50, oiChangeMagnitudeFrac: 0.5, priceOiAgreeFrac: 0.5, rvol: 1.5,
    premiumConfirmFrac: 0.5, vwapAlignmentFrac: 0.5, emaAlignmentFrac: 0.5, momentumFrac: 0.5,
  });
  assert.equal(r.breakdown.reduce((s, b) => s + b.weightPct, 0), 100);
});
