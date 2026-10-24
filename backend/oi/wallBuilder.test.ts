import { test } from "node:test";
import assert from "node:assert/strict";
import { buildType, bsGamma, parseStrikeCsv, buildWalls, readStrike } from "./wallBuilder";

const H = "date,timeIST,index,spot,strike,distFromSpot,ceOi,ceChg,ceVol,ceLtp,ceIv,ceDelta,peOi,peChg,peVol,peLtp,peIv,peDelta";
const line = (t: string, spot: number, k: number, ceOi: number, ceLtp: number, peOi: number, peLtp: number) => `2026-10-23,${t},NIFTY,${spot},${k},${k - spot},${ceOi},0,0,${ceLtp},17,0.5,${peOi},0,0,${peLtp},15,-0.5`;

test("buildType: write / buy / cover / unwind / flat", () => {
  assert.equal(buildType(100, -2), "W"); assert.equal(buildType(100, 2), "B");
  assert.equal(buildType(-100, 2), "SC"); assert.equal(buildType(-100, -2), "U");
  assert.equal(buildType(0, 5), "-"); assert.equal(buildType(null, 5), "-");
});

test("bsGamma: ATM NIFTY, 17% IV, ~4 days ≈ 0.00097", () => {
  const g = bsGamma(22510, 22500, 17, 0.0115)!;
  assert.ok(g > 0.0009 && g < 0.00105, String(g));
  assert.equal(bsGamma(22510, 22500, 0, 0.01), null);
});

test("buildWalls: windows, call writing at the ceiling, put buying, totals and day change", () => {
  const rows: string[] = [H];
  // 09:15 first minute, 10:07 (15 min back), 10:17 (5 back), 10:21 (1 back), 10:22 now
  for (const [t, spot, cOi, cL, pOi, pL] of [["09:15", 22560, 1000, 200, 5000, 100], ["10:07", 22567, 2000, 200, 6000, 120], ["10:17", 22477, 2500, 180, 6500, 140], ["10:21", 22491, 2600, 185, 6400, 135], ["10:22", 22510, 3000, 150, 7000, 130]] as const) {
    rows.push(line(t, spot, 22500, cOi, cL, pOi, pL));
    rows.push(line(t, spot, 22600, cOi * 2, cL / 2, pOi / 2, pL * 2));
  }
  const wb = buildWalls(parseStrikeCsv(rows.join("\n")), { index: "NIFTY", day: "2026-10-23", expiry: "2026-10-27" })!;
  assert.equal(wb.minute, "10:22"); assert.equal(wb.windows["15"].from, "10:07"); assert.equal(wb.windows["5"].from, "10:17"); assert.equal(wb.windows["1"].from, "10:21");
  const k = wb.rows.find((r) => r.strike === 22500)!;
  assert.deepEqual(k.w["15"], { c: 1000, ct: "W", p: 1000, pt: "B" });   // calls +1000 with premium 200 → 150 = writing
  assert.equal(k.dayC, 2000); assert.equal(k.dayP, 2000);
  assert.equal(wb.totals["15"].callAdded, 1000 + 2000);
  assert.equal(wb.positioning.callWall, 22600, "strongest call writing at/above the spot");
  assert.match(wb.positioning.note, /not a forecast/);
  assert.ok(wb.maxGamma != null);
});

test("readStrike: calls written = push down, puts written = push up, 5-min counts half", () => {
  const z = { c: null, ct: "-" as const, p: null, pt: "-" as const };
  assert.equal(readStrike({ c: 100, ct: "W", p: null, pt: "-" }, z).side, "DN");
  assert.equal(readStrike({ c: null, ct: "-", p: 100, pt: "W" }, z).side, "UP");
  assert.equal(readStrike({ c: 100, ct: "W", p: null, pt: "-" }, { c: null, ct: "-", p: 300, pt: "W" }).side, "UP");   // 100 vs 150
});
