import { test } from "node:test";
import assert from "node:assert/strict";
import { rankOiWalls } from "./marketAnalysis";

// BANKNIFTY 13 Oct close (real values from the chain): spot 55721.75
const S = (strike: number, peOi: number, ceOi: number) => ({ strike, peOi, ceOi, ceChg: 0, peChg: 0 }) as any;
const win = [S(55200, 233520, 30000), S(55300, 251910, 40000), S(55400, 120000, 60000), S(55500, 808290, 90000), S(55600, 93690, 80000), S(55700, 81480, 70000),
  S(55800, 20000, 161730), S(55900, 15000, 94590), S(56000, 30000, 1109100), S(56200, 5000, 105270)];

test("put support = largest PUT OI at/below spot, not the nearest strike", () => {
  const { peBelow, ceAbove } = rankOiWalls(win, 55721.75);
  assert.deepEqual(peBelow.map((s) => s.strike), [55500]);   // was 55700 (nearest strike, 81k OI); 55300 is < half the largest
  assert.deepEqual(ceAbove.map((s) => s.strike), [56000]);   // was 55800
});
test("a strike exactly at spot can be both; zero-OI strikes are ignored", () => {
  const { peBelow, ceAbove } = rankOiWalls([S(22700, 100, 50), S(22750, 0, 0), S(22650, 0, 10)], 22700);
  assert.deepEqual(peBelow.map((s) => s.strike), [22700]); assert.deepEqual(ceAbove.map((s) => s.strike), [22700]);
});

test("nearest significant wall first; the largest wall reported as major even when far", () => {
  const w = [S(55000, 1379820, 0), S(55500, 808290, 0), S(55600, 93690, 0), S(56000, 0, 1109100), S(56500, 0, 760050), S(55800, 0, 161730)];
  const r = rankOiWalls(w, 55721.75);
  assert.deepEqual(r.peBelow.map((s) => s.strike), [55500, 55000]);     // 55500 ≥ half of 13.8 lakh → nearest wall
  assert.equal(r.putMajor!.strike, 55000);
  assert.deepEqual(r.ceAbove.map((s) => s.strike), [56000, 56500]); assert.equal(r.callMajor!.strike, 56000);
});
