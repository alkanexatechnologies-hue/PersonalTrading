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

// ---- premium support / resistance zones
import { premiumZones } from "./premiumPosition";
// two sessions of 15-min premium candles: turns at ~100 (three times) and ~140 (twice)
const D1 = Date.parse("2026-10-16T03:45:00Z") / 1000, D2 = Date.parse("2026-10-19T03:45:00Z") / 1000;
const path = [120, 110, 101, 112, 125, 139, 128, 115, 100, 113, 126, 140, 130, 118, 102, 114, 122, 118, 116, 117];
const mk = (t0: number, xs: number[]) => xs.map((c, i) => ({ time: t0 + i * 900, open: c, high: c + 1, low: c - 1, close: c }));
const zc = [...mk(D1, path), ...mk(D2, path.map((x) => x + 1))];
test("premium zones: repeated turns become STRONG support / resistance with touch counts; position read", () => {
  const z = premiumZones({ candles: zc, current: 118 })!;
  const strong = z.support.find((q) => q.price > 95 && q.price < 106)!;   // S1 = the nearer minor swing low, S2 = the strong zone
  assert.ok(strong, JSON.stringify(z.support)); assert.equal(strong.strength, "STRONG"); assert.ok(strong.touches >= 3); assert.ok(z.support[0].price > strong.price);
  assert.ok(z.resistance.some((r) => r.price > 135 && r.price < 145 && r.touches >= 2), JSON.stringify(z.resistance));
  assert.equal(z.state, "NEAR RESISTANCE");   // the minor swing high ~123 is under 5 % above 118
  const near = premiumZones({ candles: zc, current: 103 })!; assert.equal(near.state, "NEAR SUPPORT"); assert.match(near.read, /sits on support/);
  const below = premiumZones({ candles: zc, current: 80 })!; assert.equal(below.state, "BELOW SUPPORT");
  assert.equal(premiumZones({ candles: zc.slice(0, 5), current: 100 }), null, "too few candles");
});
