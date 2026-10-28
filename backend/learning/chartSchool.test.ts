import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, buildChartLesson, ema, Bar } from "./chartSchool";

const t0 = Date.parse("2026-10-28T09:15:00+05:30") / 1000;
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({ time: t0 + i * 300, open: o, high: h, low: l, close: c });

test("candle names: hammer, shooting star, doji, engulfing, marubozu", () => {
  assert.equal(classify(bar(0, 98, 101, 90, 100.5), null, 10).name, "Hammer");
  assert.equal(classify(bar(0, 101.5, 110, 98.5, 99), null, 10).name, "Shooting star");
  assert.equal(classify(bar(0, 100, 105, 95, 100.2), null, 10).name, "Doji");
  assert.equal(classify(bar(1, 96, 106, 95, 105), bar(0, 104, 105, 97, 97), 6).name, "Bullish engulfing");
  assert.equal(classify(bar(0, 100, 120.5, 99.5, 120), null, 10).name, "Marubozu");
  assert.deepEqual(ema([1, 2, 3], 2).map((x) => x != null), [false, true, true]);
});

test("V day: falls through yesterday's low, low at a round number, breaks back above and retests it as support", () => {
  // prev low 1000; day: 1020 → falls to 950 (bar 20) → rises above 1000 (bar 34), dips back to ~1001 (bar 37) → runs to 1060
  const path: number[] = [];
  for (let i = 0; i <= 20; i++) path.push(1020 - 3.5 * i);
  for (let i = 1; i <= 14; i++) path.push(950 + 4 * i);           // bar 34 ≈ 1006
  path.push(1008, 1004, 1001.5);                                   // pullback to the level (bars 35–37)
  for (let i = 1; i <= 25; i++) path.push(1002 + 2.4 * i);
  const bars = path.map((c, i) => { const o = i ? path[i - 1] : 1022; return bar(i, o, Math.max(o, c) + 1.5, Math.min(o, c) - 1.5, c); });
  const L = buildChartLesson({ index: "NIFTY", day: "2026-10-28", bars, prev: { high: 1040, low: 1000, close: 1025 } });
  const kinds = L.events.map((e) => e.kind);
  assert.ok(L.events.length <= 12 && L.events.every((e, k) => e.n === k + 1));
  assert.ok(kinds.includes("DAY_LOW")); assert.ok(kinds.includes("OPEN"));
  const rt = L.events.find((e) => e.kind === "RETEST" && /support/.test(e.title));
  assert.ok(rt, "a broken resistance retested as support");
  assert.ok(L.levels.some((l) => l.key === "PDL") && L.levels.some((l) => l.kind === "ROUND" && l.price === 1000) === false);   // merged with PDL (same price)
  assert.ok(L.summary[1].includes("पहले गिरावट")); assert.equal(L.rules.length, 6);
  // swing flip levels are only used after they formed (no look-ahead)
  for (const e of L.events) { const lv = L.levels.find((l) => l.label === e.level?.label); if (lv?.from != null) assert.ok(e.idx >= lv.from); }
});

test("a break that reverses is taught as a trap", () => {
  const path = [1010, 1006, 1003, 1001, 999, 1004, 1008, 1006, 1003, 1003.5];   // prev low 1000 broken down at bar 4 → back up
  for (let i = 0; i < 12; i++) path.push(1010 + 2 * i);
  const bars = path.map((c, i) => { const o = i ? path[i - 1] : 1011; return bar(i, o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c); });
  const L = buildChartLesson({ index: "NIFTY", day: "2026-10-28", bars, prev: { high: 1030, low: 1000, close: 1012 } });
  assert.ok(L.events.some((e) => /झूठा break/.test(e.title + e.what)), "the trap is taught (on its own or with the day's low)");
});
