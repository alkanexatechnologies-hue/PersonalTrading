// Phase 0.1 safety-fix coverage: the Master Trade Selector's CONFLICT verdict must
// be able to block an entry. This test exercises arbitrate() itself — the exact
// function paper/engine.ts's tryOpenOption() now calls before opening a position
// (see engine.ts "MASTER TRADE SELECTOR — now load-bearing, not display-only").
import { test } from "node:test";
import assert from "node:assert/strict";
import { arbitrate, ArbiterCandidate } from "./tradeArbiter";

function candidate(overrides: Partial<ArbiterCandidate>): ArbiterCandidate {
  return {
    mode: "Directional",
    direction: "Bullish",
    finalScore: 56,
    setupQuality: 60,
    eligible: true,
    vetoed: false,
    suppressed: false,
    ...overrides,
  };
}

test("arbitrate: two close, opposing candidates produce CONFLICT", () => {
  const directional = candidate({ mode: "Directional", direction: "Bullish", finalScore: 56, setupQuality: 45 });
  const scalp = candidate({ mode: "Scalp", direction: "Bearish", finalScore: 54, setupQuality: 45 });
  const result = arbitrate([directional, scalp]);
  assert.equal(result.verdict, "CONFLICT");
  assert.equal(result.primary, null);
});

test("arbitrate: single eligible candidate is GO", () => {
  const directional = candidate({ mode: "Directional", direction: "Bullish" });
  const result = arbitrate([directional]);
  assert.equal(result.verdict, "GO");
  assert.equal(result.primary?.mode, "Directional");
});

test("arbitrate: same-direction candidates GO with the higher scorer as primary", () => {
  const directional = candidate({ mode: "Directional", direction: "Bullish", finalScore: 58 });
  const scalp = candidate({ mode: "Scalp", direction: "Bullish", finalScore: 53 });
  const result = arbitrate([directional, scalp]);
  assert.equal(result.verdict, "GO");
  assert.equal(result.primary?.mode, "Directional");
});

test("arbitrate: opposing candidates with a clear score gap GO the leader (no conflict)", () => {
  const directional = candidate({ mode: "Directional", direction: "Bullish", finalScore: 60 });
  const scalp = candidate({ mode: "Scalp", direction: "Bearish", finalScore: 50 });
  const result = arbitrate([directional, scalp]);
  assert.equal(result.verdict, "GO");
  assert.equal(result.primary?.mode, "Directional");
});

test("arbitrate: no eligible candidates is WAIT", () => {
  const ineligible = candidate({ eligible: false });
  const result = arbitrate([ineligible]);
  assert.equal(result.verdict, "WAIT");
  assert.equal(result.primary, null);
});
