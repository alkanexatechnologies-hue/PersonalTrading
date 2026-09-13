import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommentary, violatesSafeLanguage } from "./commentary";

test("violatesSafeLanguage: catches every banned phrase from Part 25", () => {
  const banned = [
    "This is a guaranteed profit setup", "sure-shot trade today", "the market will definitely go up",
    "system has 95% accuracy", "smart money is definitely buying", "a risk-free entry", "100% win rate",
  ];
  for (const s of banned) assert.notEqual(violatesSafeLanguage(s), null, `expected "${s}" to be flagged`);
});

test("violatesSafeLanguage: approved vocabulary passes clean", () => {
  const ok = "System bias is bullish. Liquidity Directional signal. Confidence score: 72/100.";
  assert.equal(violatesSafeLanguage(ok), null);
});

const base = {
  name: "Reliance Industries", qualityScore: 82,
  vwapStatus: "Above+Rising" as const, emaStructure: "Strong Bullish" as const,
  movementStage: "STRONG MOVE" as const, liquidityLabel: "Liquidity Flow Strong" as const, reasons: [],
};

test("buildCommentary: a Liquidity Directional TOP PICK never trips the safety check and names the track", () => {
  const text = buildCommentary({ ...base, track: "LIQUIDITY_DIRECTIONAL", direction: "Bullish", decision: "TOP PICK" });
  assert.equal(violatesSafeLanguage(text), null);
  assert.ok(text.includes("Reliance"));
});

test("buildCommentary: a Stock Setup TOP PICK explicitly does not claim liquidity confirmation", () => {
  const text = buildCommentary({ ...base, track: "STOCK_SETUP", direction: "Bullish", decision: "TOP PICK" });
  assert.equal(violatesSafeLanguage(text), null);
  assert.ok(text.toLowerCase().includes("not being claimed"));
});

test("buildCommentary: EXTENDED — DO NOT CHASE uses the exact required phrase", () => {
  const text = buildCommentary({ ...base, track: "LIQUIDITY_DIRECTIONAL", direction: "Bullish", decision: "EXTENDED — DO NOT CHASE", movementStage: "EXTENDED" });
  assert.ok(text.includes("Move already extended — avoid chasing."));
});

test("buildCommentary: WAIT FOR PULLBACK uses the exact required phrase", () => {
  const text = buildCommentary({ ...base, track: "LIQUIDITY_DIRECTIONAL", direction: "Bullish", decision: "WAIT FOR PULLBACK" });
  assert.ok(text.includes("Pullback opportunity — waiting for confirmation."));
});

test("buildCommentary: NO EDGE is honest about the tie, not a forced call", () => {
  const text = buildCommentary({ ...base, track: "STOCK_SETUP", direction: null, decision: "NO EDGE", reasons: ["scores too close"] });
  assert.equal(violatesSafeLanguage(text), null);
  assert.ok(text.toLowerCase().includes("no trade"));
});
