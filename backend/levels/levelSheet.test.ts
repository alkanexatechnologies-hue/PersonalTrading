import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLevelSheet, matchLevel, prevWeekHL, levelSheetMsg, zoneTol, SheetInputs } from "./levelSheet";

const base: SheetInputs = {
  index: "NIFTY", day: "2026-10-28", builtAt: 0, spot: 22750, step: 50,
  prevDay: { day: "2026-10-27", high: 22812, low: 22620, close: 22750 },
  prevWeek: { from: "2026-10-19", to: "2026-10-23", high: 23180, low: 22430 },
  ownerLevels: [{ price: 22805, kind: "PA 3+ touches", label: "" }, { price: 22510, kind: "PA 2 touches", label: "" }],
  callWalls: [{ strike: 22800, oi: 21_000_000 }, { strike: 22900, oi: 9_000_000 }, { strike: 22700, oi: 30_000_000 }],
  putWalls: [{ strike: 22700, oi: 18_000_000 }, { strike: 22500, oi: 12_000_000 }, { strike: 22900, oi: 50_000_000 }],
};

test("confluence → stars: PDH + S/R 3+ + call wall = ★★★; two plain sources = ★★", () => {
  const s = buildLevelSheet(base), at = (p: number) => s.levels.find((l) => l.lo <= p && p <= l.hi)!;
  const r = at(22800);
  assert.deepEqual(r.reasons.map((x) => x.src).sort(), ["CALL WALL", "PDH", "SR"]);
  assert.equal(r.score, 4); assert.equal(r.stars, 3); assert.equal(r.role, "R"); assert.equal(r.price, 22800);   // 3 sources + 3+ turns; the OI strike leads
  const lo = at(22510);
  assert.deepEqual(lo.reasons.map((x) => x.src).sort(), ["PUT WALL", "SR"]); assert.equal(lo.score, 2); assert.equal(lo.stars, 2); assert.equal(lo.role, "S");
  const pdc = at(22750); assert.equal(pdc.stars, 1); assert.deepEqual(pdc.reasons.map((x) => x.src), ["PDC"]);
});

test("walls on the wrong side of spot are ignored; the biggest wall per side gets the extra point", () => {
  const s = buildLevelSheet(base), all = s.levels.flatMap((l) => l.reasons);
  assert.deepEqual(all.filter((x) => x.src === "PUT WALL").map((x) => x.price).sort(), [22500, 22700]);   // 22900 PE (above spot) is not a floor
  assert.deepEqual(all.filter((x) => x.src === "CALL WALL").map((x) => x.price).sort(), [22700, 22800]);  // 22700 CE is within a step of spot; 22900 is 3rd
  const z = s.levels.find((l) => l.price === 22700)!;
  assert.equal(z.score, 4); assert.equal(z.stars, 3);   // biggest call wall + biggest put wall at one strike
});

test("week high / low count double; levels beyond 3 % are dropped; sorted high → low", () => {
  const s = buildLevelSheet({ ...base, prevWeek: { from: "a", to: "b", high: 22990, low: 21000 } });
  const wk = s.levels.find((l) => l.reasons.some((x) => x.src === "PWH"))!;
  assert.equal(wk.stars, 2); assert.equal(wk.reasons.length, 1);
  assert.ok(!s.levels.some((l) => l.reasons.some((x) => x.src === "PWL")));   // 21000 is 7.7 % away
  assert.deepEqual(s.levels.map((l) => l.price), [...s.levels.map((l) => l.price)].sort((a, b) => b - a));
});

test("matchLevel finds the zone of a price shown elsewhere (within the zone ± tol)", () => {
  const s = buildLevelSheet(base);
  assert.equal(matchLevel(s, 22812)!.price, 22800);
  assert.equal(matchLevel(s, 22825)!.price, 22800);   // tol ≈ 30 for NIFTY
  assert.equal(matchLevel(s, 23050), null);
  assert.equal(zoneTol(74000, 100), 74);
});

test("prevWeekHL uses Mon–Fri of the previous calendar week", () => {
  const t = (d: string) => Date.parse(d + "T03:45:00Z") / 1000;
  const daily = [["2026-10-16", 1, 0], ["2026-10-19", 10, 5], ["2026-10-23", 12, 4], ["2026-10-26", 99, 1]].map(([d, h, l]) => ({ time: t(d as string), high: h as number, low: l as number }));
  assert.deepEqual(prevWeekHL(daily, "2026-10-28"), { from: "2026-10-19", to: "2026-10-23", high: 12, low: 4 });
  assert.deepEqual(prevWeekHL(daily, "2026-10-26")!.high, 12);   // Monday → the week before
});

test("Telegram message lists ★★ and ★★★ only, nearest first, with reasons", () => {
  const m = levelSheetMsg([buildLevelSheet(base)]);
  assert.match(m, /09:12 KEY LEVELS/); assert.match(m, /★★★ <b>22,800<\/b> \(\+50\)/); assert.match(m, /not a forecast/);
  assert.ok(!/★ <b>/.test(m.replace(/★★★ <b>|★★ <b>/g, "")));
});
