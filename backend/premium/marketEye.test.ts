import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRows, lookup, eyeText } from "./marketEye";
const T0 = Math.floor(Date.parse("2026-01-05T09:15:00Z") / 1000) - 19800;
function day(i: number, drift: number) { const base = T0 + i * 86400, m: [number, number][] = []; for (let k = 0; k < 375; k++) m.push([base + k * 60, 100 + drift * k]); return { day: `D${i}`, minutes: m, prevClose: 100 }; }
test("rows carry the NEXT 30 minutes only; lookup counts one row per day and excludes today", () => {
  const rows = buildRows([day(0, 0.01), day(1, -0.01), day(2, 0.01), day(3, 0)]);
  assert.ok(rows.length > 0);
  const r = rows.find((x) => x.day === "D0" && x.min === 600)!; assert.ok(Math.abs(r.next30 - ((100 + 0.01 * 75) / (100 + 0.01 * 45) - 1) * 100) < 1e-9);
  const res = lookup(rows, { min: 600, dayChg: 0.45, fromHigh: 0, fromLow: 0.4, ret30: 0.3, ret5: 0.05 }, 10, "D0")!;
  assert.equal(res.n, 3); assert.ok(!res.examples.some((e) => e.startsWith("D0")));
  assert.match(eyeText("NIFTY", res, 23000), /History, not a forecast/);
});
