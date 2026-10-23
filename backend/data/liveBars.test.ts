import { test } from "node:test";
import assert from "node:assert/strict";
import { resampleSession } from "./liveBars";

// 2026-10-23 09:15 IST = 03:45 UTC
const T0 = Date.UTC(2026, 9, 23, 3, 45) / 1000;
const bar = (min: number, o: number, h: number, l: number, c: number, v = 1) => ({ time: T0 + min * 60, open: o, high: h, low: l, close: c, volume: v });

test("resampleSession builds 5-min bars aligned to 09:15 IST from 1-min bars", () => {
  const out = resampleSession([bar(0, 10, 12, 9, 11), bar(1, 11, 15, 11, 14), bar(4, 14, 14, 8, 9), bar(5, 9, 10, 9, 10)], 5);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { time: T0, open: 10, high: 15, low: 8, close: 9, volume: 3 });
  assert.equal(out[1].time, T0 + 300);
});

test("resampleSession aligns hourly bars to 09:15, not to the clock hour", () => {
  const out = resampleSession([bar(0, 1, 1, 1, 1), bar(59, 2, 2, 2, 2), bar(60, 3, 3, 3, 3)], 60);
  assert.deepEqual(out.map((c) => c.time), [T0, T0 + 3600]);
});
