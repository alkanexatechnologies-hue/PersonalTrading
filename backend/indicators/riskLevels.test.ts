import test from "node:test";
import assert from "node:assert/strict";
import { atrStopTarget } from "./riskLevels";

test("atrStopTarget: long direction places stop below and target above price", () => {
  const { stop, target } = atrStopTarget(100, 10, 1);
  assert.equal(stop, 100 - 1.5 * 10);
  assert.equal(target, 100 + 2.5 * 10);
});

test("atrStopTarget: short direction mirrors it (stop above, target below)", () => {
  const { stop, target } = atrStopTarget(100, 10, -1);
  assert.equal(stop, 100 + 1.5 * 10);
  assert.equal(target, 100 - 2.5 * 10);
});

test("atrStopTarget: custom multipliers override the 1.5x/2.5x defaults", () => {
  const { stop, target } = atrStopTarget(100, 10, 1, { stopMult: 1, targetMult: 2 });
  assert.equal(stop, 90);
  assert.equal(target, 120);
});
