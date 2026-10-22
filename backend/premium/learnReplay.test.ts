import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLesson, dayLevels, resample } from "./learnReplay";

const T = Date.parse("2026-10-22T03:45:00Z") / 1000, bar = (i: number, o: number, h: number, l: number, c: number) => ({ time: T + i * 300, open: o, high: h, low: l, close: c });
const prevBars = Array.from({ length: 75 }, (_, i) => ({ time: T - 86400 + i * 300, open: 100, high: 102, low: 98, close: 100 }));
const base = { index: "NIFTY", day: "2026-10-22", interval: 5, prevBars, prev: { high: 110, low: 90, close: 100 }, prevWeek: null, atrDaily: 20, roundStep: 1000 };

test("levels known before the day: previous day H / L / C and pivots", () => {
  const L = dayLevels({ high: 110, low: 90, close: 100 }, { high: 120, low: 80 }, 1000, 20);
  assert.ok(L.some((x) => x.label === "previous day low" && x.price === 90)); assert.ok(L.some((x) => x.label === "R1 pivot" && x.price === 110)); assert.ok(L.some((x) => x.label === "previous week high"));
});
test("a fake break below the previous day low and a close back above within 3 candles is taught as a liquidity sweep", () => {
  const bars = [bar(0, 95, 96, 93, 94), bar(1, 94, 94, 91, 92), bar(2, 92, 92, 86, 87), bar(3, 87, 93, 87, 92.5), bar(4, 92.5, 95, 92, 94), bar(5, 94, 96, 93, 95)];
  const L = buildLesson({ ...base, bars });
  const kinds = L.steps.map((s) => `${s.i}:${s.kind}`);
  assert.ok(kinds.includes("0:open")); assert.ok(kinds.some((k) => /^2:break/.test(k)), kinds.join(" ")); assert.ok(kinds.some((k) => /^3:sweep/.test(k)), kinds.join(" "));
  assert.match(L.steps.find((s) => s.kind === "sweep")!.text, /liquidity sweep/);
  assert.equal(L.steps[L.steps.length - 1].kind, "end");
});
test("no look-ahead: the lesson for the first candles is identical whether or not later candles exist", () => {
  const bars = [bar(0, 95, 96, 93, 94), bar(1, 94, 94, 91, 92), bar(2, 92, 92, 86, 87), bar(3, 87, 93, 87, 92.5), bar(4, 92.5, 95, 92, 94), bar(5, 94, 96, 93, 95)];
  const full = buildLesson({ ...base, bars }).steps.filter((s) => s.i <= 3 && s.kind !== "end").map((s) => s.text);
  const part = buildLesson({ ...base, bars: bars.slice(0, 4) }).steps.filter((s) => s.i <= 3 && s.kind !== "end").map((s) => s.text);
  assert.deepEqual(part, full);
});
test("15-min candles are built from 5-min ones; never more than two lessons on one candle (open / 09:30 / end always kept)", () => {
  assert.deepEqual(resample([bar(0, 1, 3, 0, 2), bar(1, 2, 5, 1, 4), bar(2, 4, 4, 2, 3)], 15), [{ time: T, open: 1, high: 5, low: 0, close: 3 }]);
  const bars = Array.from({ length: 30 }, (_, i) => bar(i, 100 + (i % 7) * 4, 104 + (i % 7) * 4, 96 + (i % 7) * 4, 101 + (i % 7) * 4));
  const L = buildLesson({ ...base, bars }); const per = new Map<number, number>(); for (const s of L.steps) if (!["open", "0930", "end"].includes(s.kind)) per.set(s.i, (per.get(s.i) || 0) + 1);
  assert.ok([...per.values()].every((v) => v <= 2));
});
