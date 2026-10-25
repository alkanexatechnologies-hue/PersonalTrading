import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerLevelsFor, priceActionLevels } from "./ownerLevels";

// 15-min bars for one IST session, closes following `path` (one value per bar, 25 bars 09:15–15:15)
const DAY0 = Date.parse("2026-10-19T09:15:00+05:30") / 1000;
function session(dayIdx: number, path: number[]) {
  return path.map((c, i) => { const t = DAY0 + dayIdx * 86400 + i * 900, o = i ? path[i - 1] : c; return { time: t, open: o, high: Math.max(o, c) + 2, low: Math.min(o, c) - 2, close: c }; });
}
// a zig-zag that turns at 100 and 140 several times a day
const zig = Array.from({ length: 25 }, (_, i) => 120 + 20 * Math.sin((i * Math.PI) / 4));

test("ownerLevelsFor uses only the sessions before today (no look-ahead)", () => {
  const c15 = [0, 1, 2, 3, 4].flatMap((d) => session(d, zig));
  const today = session(5, zig.map((x) => x + 500));                         // today's bars are far away
  const a = ownerLevelsFor([...c15, ...today], "2026-10-24"), b = ownerLevelsFor(c15, "2026-10-24");
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
  assert.ok(a.every((l) => l.price < 300), "no level from today's bars");
});

test("ownerLevelsFor finds the repeated turn levels", () => {
  const lv = ownerLevelsFor([0, 1, 2, 3, 4].flatMap((d) => session(d, zig)), "2026-10-24");
  assert.ok(lv.some((l) => Math.abs(l.price - 142) < 4), JSON.stringify(lv));
  assert.ok(lv.some((l) => Math.abs(l.price - 98) < 4), JSON.stringify(lv));
});

test("ownerLevelsFor returns nothing without enough history", () => {
  assert.deepEqual(ownerLevelsFor(session(0, zig), "2026-10-24"), []);
  assert.deepEqual(ownerLevelsFor([], "2026-10-24"), []);
});

test("priceActionLevels keeps only clusters of 2+ swings", () => {
  assert.ok(priceActionLevels([0, 1, 2, 3, 4].flatMap((d) => session(d, zig)), 10).every((l) => /PA (FLIP|3\+ touches|2 touches)/.test(l.kind)));
});
