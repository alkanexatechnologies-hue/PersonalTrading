import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBuildup, detectSurge } from "./classify";

test("call OI up + premium up = long buildup, bullish", () => {
  const r = classifyBuildup("CALL", 100000, 20000, 5);
  assert.equal(r.buildup, "Long Buildup");
  assert.equal(r.bias, "bullish");
});

test("call OI up + premium down = short buildup (resistance), bearish", () => {
  const r = classifyBuildup("CALL", 100000, 20000, -5);
  assert.equal(r.buildup, "Short Buildup");
  assert.equal(r.bias, "bearish");
});

test("put OI up + premium down = short buildup (support), bullish", () => {
  const r = classifyBuildup("PUT", 100000, 20000, -5);
  assert.equal(r.buildup, "Short Buildup");
  assert.equal(r.bias, "bullish");
});

test("put OI down + premium down = long unwinding, bullish for underlying", () => {
  const r = classifyBuildup("PUT", 80000, -20000, -5);
  assert.equal(r.buildup, "Long Unwinding");
  assert.equal(r.bias, "bullish");
});

test("call short covering (OI down, premium up) is bullish", () => {
  const r = classifyBuildup("CALL", 80000, -20000, 5);
  assert.equal(r.buildup, "Short Covering");
  assert.equal(r.bias, "bullish");
});

test("tiny OI change classified as Flat/neutral", () => {
  const r = classifyBuildup("CALL", 100000, 500, 5); // 0.5% < 2%
  assert.equal(r.buildup, "Flat");
  assert.equal(r.bias, "neutral");
});

test("surge detects fast intraday OI add", () => {
  const r = detectSurge({ side: "PUT", strike: 22000, oiNow: 130000, oiChg: 30000, windowMin: 1, ltpChg: -3 });
  assert.equal(r.surge, true);
  assert.ok(r.severity === "strong" || r.severity === "extreme");
  assert.equal(r.buildup, "Short Buildup");
});

test("surge stays quiet on a slow drift", () => {
  const r = detectSurge({ side: "CALL", strike: 22000, oiNow: 101000, oiChg: 1000, windowMin: 5, ltpChg: 1 });
  assert.equal(r.surge, false);
  assert.equal(r.severity, "none");
});
