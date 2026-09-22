import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarketView, validateDirection, MarketViewInput } from "./marketView";

const base: MarketViewInput = {
  direction: "BEARISH", finalAction: "WAIT", masterVerdict: "WAIT",
  structure: "Bearish", preStructure: "Ranging", vwapStatus: "Below",
  oiDirection: "FLAT", oiAvailable: false,
  emaStructure: null, lsVwapStatus: null,
  obSide: "Bearish", obStatus: "Fresh", obStage: "Confirmed",
  confirmations: [
    { label: "OI Direction", passed: false },
    { label: "Order Block", passed: true },
    { label: "Market Structure", passed: true },
    { label: "Master Selector", passed: false },
    { label: "Data Fresh", passed: false },
    { label: "VWAP Aligned", passed: true },
    { label: "EMA Structure", passed: false },
  ],
  invalidationSpot: 23460, optionView: "PE", preferredStrike: "23400 PE", dataStale: true,
};

test("market view explains a bearish read when OI is stale (structure-based, WAIT)", () => {
  const mv = buildMarketView(base);
  assert.equal(mv.direction, "BEARISH");
  assert.equal(mv.state, "WAIT");                       // final action honored, never overridden
  assert.equal(mv.strength, "MODERATE");                // 3/7 passed
  assert.match(mv.strengthEvidence, /3\/7/);
  // Supporting: structure Bearish + price Below VWAP + Bearish OB
  assert.ok(mv.supporting.some((s) => /structure Bearish/i.test(s)));
  assert.ok(mv.supporting.some((s) => /Below VWAP/i.test(s)));
  assert.ok(mv.supporting.some((s) => /Order Block/i.test(s)));
  // Missing includes the failed confirmations
  assert.ok(mv.missing.includes("Data Fresh") && mv.missing.includes("OI Direction"));
  // Invalidation carries the real level
  assert.match(mv.invalidation, /23460/);
  // Provenance says OI is stale / structure-only
  assert.match(mv.basedOn, /stale|structure/i);
  assert.equal(mv.optionView, "PE");
});

test("does not override master: TAKE only when finalAction is TAKE", () => {
  const take = buildMarketView({ ...base, finalAction: "TAKE", masterVerdict: "GO", oiDirection: "DOWN", oiAvailable: true,
    confirmations: base.confirmations.map((c) => ({ ...c, passed: true })), dataStale: false });
  assert.equal(take.state, "TAKE");
  assert.equal(take.strength, "STRONG");                 // 7/7
  assert.ok(take.supporting.some((s) => /OI direction DOWN/i.test(s)));

  const noTrade = buildMarketView({ ...base, finalAction: "NO TRADE" });
  assert.equal(noTrade.state, "AVOID");
});

test("contradiction surfaces when an engine opposes the direction", () => {
  const mv = buildMarketView({ ...base, vwapStatus: "Above" }); // bearish view but price above VWAP
  assert.ok(mv.contradicting.some((s) => /Above VWAP/i.test(s)));
});

test("validateDirection: split evidence → CONFLICT, never a forced guess", () => {
  // structure Bullish + EMA Bullish (2 bull) vs VWAP Below + OB Bearish (2 bear) → CONFLICT
  const v = validateDirection({
    ...base, structure: "Bullish", emaStructure: "Strong Bullish", vwapStatus: "Below",
    obSide: "Bearish", obStatus: "Fresh", preStructure: "Ranging", oiAvailable: false,
  });
  assert.equal(v.dominant, "CONFLICT");
  assert.ok(v.bullVotes >= 2 && v.bearVotes >= 2);
  const mv = buildMarketView({ ...base, structure: "Bullish", emaStructure: "Strong Bullish", vwapStatus: "Below", obSide: "Bearish", obStatus: "Fresh" });
  assert.equal(mv.direction, "CONFLICT");
});

test("validateDirection: no engine reading → NEUTRAL, not bullish/bearish", () => {
  const v = validateDirection({
    ...base, structure: "Ranging", vwapStatus: "At", emaStructure: null,
    preStructure: "Ranging", obSide: null, obStatus: null, oiAvailable: false,
  });
  assert.equal(v.dominant, "NEUTRAL");
  assert.equal(v.bullVotes, 0);
  assert.equal(v.bearVotes, 0);
});

test("validateDirection: OI only votes when the live chain is available", () => {
  const stale = validateDirection({ ...base, structure: "Ranging", vwapStatus: "At", emaStructure: null, preStructure: "Ranging", obSide: null, oiDirection: "DOWN", oiAvailable: false });
  assert.equal(stale.bearVotes, 0, "FLAT/unavailable OI casts no vote");
  const live = validateDirection({ ...base, structure: "Ranging", vwapStatus: "At", emaStructure: null, preStructure: "Ranging", obSide: null, oiDirection: "DOWN", oiAvailable: true });
  assert.equal(live.dominant, "BEARISH");
  assert.ok(live.bearishEvidence.some((s) => /OI direction DOWN/i.test(s)));
});
