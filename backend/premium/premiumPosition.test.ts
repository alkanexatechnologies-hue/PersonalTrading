import { test } from "node:test";
import assert from "node:assert/strict";
import { premiumPosition } from "./premiumPosition";

const sw = (kind: "HIGH" | "LOW", price: number) => ({ kind, price, time: null });

test("premium position: below support, near resistance, near support, mid-range", () => {
  const swings = [sw("LOW", 40), sw("HIGH", 80), sw("LOW", 50), sw("HIGH", 70)];
  const b = premiumPosition({ current: 45, swings })!;
  assert.equal(b.state, "BELOW SUPPORT"); assert.equal(b.brokenSupport, 50); assert.ok(b.danger); assert.match(b.text, /under its swing low ₹50/);
  const r = premiumPosition({ current: 67.5, swings })!;
  assert.equal(r.state, "NEAR RESISTANCE"); assert.equal(r.resistance, 70); assert.match(r.text, /NEAR RESISTANCE — premium ₹67.5, resistance ₹70 \(\+4% away\)/);
  const s = premiumPosition({ current: 52, swings })!;
  assert.equal(s.state, "NEAR SUPPORT"); assert.ok(!s.danger);
  const m = premiumPosition({ current: 60, swings })!;
  assert.equal(m.state, "MID-RANGE"); assert.equal(m.support, 50); assert.equal(m.resistance, 70);
  assert.equal(premiumPosition({ current: 60, swings: [] })!.state, "NO LEVELS");
  assert.equal(premiumPosition({ current: 0, swings }), null);
});
