import { test } from "node:test";
import assert from "node:assert/strict";
import { levelTests, zones, kindStats, roundLevels } from "./levelMemory";

const T0 = 1_792_036_800, b = (i: number, o: number, h: number, l: number, c: number) => ({ time: T0 + i * 300, open: o, high: h, low: l, close: c });
const L = [{ price: 100, label: "Round 100", kind: "ROUND" }];

test("support RESPECTED: dips to the level, turns away 1 ATR without a close below", () => {
  const e = levelTests([b(0, 106, 107, 104, 105), b(1, 105, 105, 100.5, 102), b(2, 102, 108, 101, 107), b(3, 107, 112, 106, 111)], L, 10);
  assert.equal(e.length, 1); assert.equal(e[0].role, "SUPPORT"); assert.equal(e[0].outcome, "RESPECTED");
});
test("FAKE BREAK: closes below the support, back above within 3 candles (it held)", () => {
  const e = levelTests([b(0, 106, 107, 104, 105), b(1, 105, 105, 97, 98), b(2, 98, 103, 97, 102), b(3, 102, 104, 101, 103)], L, 10);
  assert.equal(e[0].outcome, "FAKE BREAK");
});
test("BROKEN: resistance gives way — closes above and runs 1 ATR", () => {
  const e = levelTests([b(0, 94, 96, 93, 95), b(1, 95, 102, 95, 101.5), b(2, 101.5, 111, 101, 110)], L, 10);
  assert.equal(e[0].role, "RESISTANCE"); assert.equal(e[0].outcome, "BROKEN");
});
test("zones group tests; kind stats count held vs broken; round levels around a price", () => {
  const ev: any[] = [{ day: "d1", time: 1, price: 23000, label: "Round 23,000", kind: "ROUND", role: "SUPPORT", outcome: "RESPECTED", moveAtr: 1 },
    { day: "d2", time: 2, price: 23010, label: "OI put wall", kind: "OI", role: "SUPPORT", outcome: "FAKE BREAK", moveAtr: 1 },
    { day: "d3", time: 3, price: 23005, label: "Round 23,000", kind: "ROUND", role: "RESISTANCE", outcome: "BROKEN", moveAtr: 1 },
    { day: "d3", time: 4, price: 23300, label: "R1", kind: "PIVOT", role: "RESISTANCE", outcome: "RESPECTED", moveAtr: 1 }];
  const z = zones(ev, 35);
  assert.equal(z[0].tests, 3); assert.deepEqual(z[0].support, { n: 2, held: 2 }); assert.equal(z[0].broken, 1); assert.equal(z[0].holdPct, 67); assert.equal(z[0].lastDay, "d3");
  const k = kindStats(ev); assert.ok(k.find((x) => x.kind === "ROUND" && x.role === "SUPPORT")!.holdPct === 100);
  assert.deepEqual(roundLevels(23146).map((x) => x.price), [22700, 22800, 22900, 23000, 23100, 23200, 23300, 23400, 23500, 23600]);
});
