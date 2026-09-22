import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVixEnvironment } from "./vixEnvironment";

test("insufficient history → INSUFFICIENT DATA, never a manufactured threshold", () => {
  const r = classifyVixEnvironment(12, [10, 11, 12, 13, 14]); // < MIN_SAMPLES
  assert.equal(r.environment, "INSUFFICIENT DATA");
  assert.equal(r.optionBuying, "INSUFFICIENT DATA");
  assert.match(r.why, /INSUFFICIENT HISTORICAL EVIDENCE/);
});

test("classifies by the app's own percentile once enough history exists", () => {
  // 50 readings from 10..20; current 10.2 sits near the bottom → LOW.
  const hist = Array.from({ length: 50 }, (_, i) => 10 + i * (10 / 49));
  const low = classifyVixEnvironment(10.2, hist);
  assert.equal(low.environment, "LOW");
  assert.ok(low.percentile != null && low.percentile < 25);

  const high = classifyVixEnvironment(19.9, hist);
  assert.equal(high.environment, "EXTREME");
  assert.ok(high.percentile != null && high.percentile >= 85);

  const mid = classifyVixEnvironment(14.5, hist);
  assert.ok(["NORMAL", "ELEVATED"].includes(mid.environment));
  // Option-buying suitability stays honest until VIX-tagged outcomes exist.
  assert.equal(mid.optionBuying, "INSUFFICIENT DATA");
});

test("no VIX value → INSUFFICIENT DATA", () => {
  assert.equal(classifyVixEnvironment(null, []).environment, "INSUFFICIENT DATA");
});
