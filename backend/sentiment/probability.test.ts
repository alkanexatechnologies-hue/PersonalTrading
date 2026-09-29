import { test } from "node:test";
import assert from "node:assert/strict";
import { computeProbability, overallBiasFromLeans } from "./probability";

const base = { index: "NIFTY 50", changePct: null, vix: null, vixChangePct: null, newsLean: null, globalLean: null, fiiLean: null, bankingLean: null, breadthLean: null, spot: null };

test("DATA INSUFFICIENT with fewer than three inputs", () => {
  const p = computeProbability({ ...base, changePct: -1.0, vix: 16 });
  assert.equal(p.available, false);
  assert.match(p.note, /INSUFFICIENT/);
});

test("bearish inputs → downside > upside, probabilities sum to 100", () => {
  const p = computeProbability({ ...base, changePct: -1.2, globalLean: -0.8, fiiLean: -0.6, bankingLean: -0.5, breadthLean: -0.7, vix: 17, spot: 22780 });
  assert.equal(p.available, true);
  assert.ok((p.downside ?? 0) > (p.upside ?? 0));
  assert.equal((p.upside ?? 0) + (p.range ?? 0) + (p.downside ?? 0), 100);
  assert.equal(p.bias, "BEARISH");
});

test("bullish inputs → upside > downside", () => {
  const p = computeProbability({ ...base, changePct: 1.1, globalLean: 0.7, fiiLean: 0.6, bankingLean: 0.6, breadthLean: 0.6, vix: 12, spot: 22780 });
  assert.ok((p.upside ?? 0) > (p.downside ?? 0));
  assert.equal(p.bias, "BULLISH");
});

test("expected-move band derives from VIX + spot", () => {
  const p = computeProbability({ ...base, changePct: 0.1, globalLean: 0.1, fiiLean: 0, bankingLean: 0.1, vix: 15, spot: 22780 });
  assert.ok(p.expectedLow != null && p.expectedHigh != null);
  assert.ok((p.expectedHigh as number) > (p.expectedLow as number));
});

test("conflicting inputs → MIXED bias", () => {
  const p = computeProbability({ ...base, changePct: 1.5, globalLean: -1, fiiLean: 1, bankingLean: -1, breadthLean: 1, vix: 20, spot: 22780 });
  assert.equal(p.bias, "MIXED");
});

test("overallBiasFromLeans", () => {
  assert.equal(overallBiasFromLeans([-0.6, -0.7, -0.5]), "BEARISH");
  assert.equal(overallBiasFromLeans([0.6, 0.7, 0.5]), "BULLISH");
  assert.equal(overallBiasFromLeans([1, -1, 1, -1]), "MIXED");
  assert.equal(overallBiasFromLeans([0.05]), "NEUTRAL");
});
