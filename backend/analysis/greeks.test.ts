import { test } from "node:test";
import assert from "node:assert/strict";
import { premiumAtLevel, bsPrice } from "./greeks";

const base = { strike: 22800, spot: 22721.95, ltp: 163.7, delta: 0.42, gamma: 0.0011, iv: 14, tYears: 5 / 365 };
const levels = [22093, 22228, 22304, 22575, 22721.95, 22786, 22921, 23100];

test("anchored to the live premium at the current spot", () => {
  assert.equal(premiumAtLevel({ ...base, type: "CE", level: base.spot }), 163.7);
});
test("CALL premium never rises when the index falls further (13 Oct bug: S2 40.37 > S1 37.84)", () => {
  const v = levels.map((l) => premiumAtLevel({ ...base, type: "CE", level: l })!);
  for (let i = 1; i < v.length; i++) assert.ok(v[i] >= v[i - 1], `${levels[i - 1]}→${levels[i]}: ${v[i - 1]} → ${v[i]}`);
  assert.ok(v[0] < v[1]);   // S2 (22,093) below S1 (22,228)
});
test("PUT premium never rises when the index rises; never below intrinsic", () => {
  const v = levels.map((l) => premiumAtLevel({ ...base, delta: -0.58, ltp: 135, type: "PE", level: l })!);
  for (let i = 1; i < v.length; i++) assert.ok(v[i] <= v[i - 1]);
  assert.ok(premiumAtLevel({ ...base, delta: -0.58, ltp: 135, type: "PE", level: 22093 })! >= 22800 - 22093);
});
test("fallback without IV is capped at the delta-gamma turning point (no bend-back)", () => {
  const f = (l: number) => premiumAtLevel({ ...base, iv: null, tYears: null, type: "CE", level: l })!;
  assert.ok(f(22093) <= f(22228)); assert.ok(f(22093) >= 0);
});
test("Black-Scholes sanity: call-put parity holds", () => {
  const i = { spot: 22700, strike: 22700, tYears: 7 / 365, iv: 0.14 };
  const c = bsPrice(i, "CE")!, p = bsPrice(i, "PE")!;
  assert.ok(Math.abs(c - p - (22700 - 22700 * Math.exp(-0.065 * 7 / 365))) < 0.5);
});
