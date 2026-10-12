import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateTrade, runDay, stats, bootstrapLB } from "./sim";
import type { DayData, Min } from "./data";

const T0 = Math.floor(Date.parse("2026-03-04T04:30:00Z") / 1000);   // 10:00 IST, a non-expiry day
function day(path: [number, number, number, number][], gapAt?: number): DayData {
  const legs = new Map<string, Min[]>(), spot = new Map<number, number>();
  const arr: Min[] = path.map(([o, h, l, c], i) => ({ t: T0 + (i + (gapAt != null && i >= gapAt ? 5 : 0)) * 60, o, h, l, c, v: 1000, oi: 1, iv: 15 }));
  legs.set("22000CE", arr); arr.forEach((m) => spot.set(m.t, 22000));
  return { day: "2026-03-04", spot, legs, expiryGuess: null };
}
const P = { target: 20, stop: 10, maxMin: 30, slip: 0 };

test("fills at the NEXT minute's open after the signal; target from the executable entry", () => {
  const d = day([[100, 101, 99, 100], [102, 110, 101, 108], [108, 125, 107, 121]]);
  const t = simulateTrade(d, { t: T0, side: "CE", strike: 22000, family: "X" }, P)!;
  assert.equal(t.entry, 102); assert.equal(t.why, "TARGET"); assert.equal(t.exit, 122); assert.equal(t.gross, 20); assert.ok(t.net < 20);
  assert.equal(t.minsToTarget, 1); assert.equal(t.mfe, 23);
});

test("a minute touching both levels is a STOP; a gap below the stop fills at the open", () => {
  const both = day([[100, 100, 100, 100], [100, 125, 85, 100]]);
  assert.equal(simulateTrade(both, { t: T0, side: "CE", strike: 22000, family: "X" }, P)!.why, "STOP");
  const gap = day([[100, 100, 100, 100], [100, 101, 99, 100], [80, 82, 78, 80]]);
  const g = simulateTrade(gap, { t: T0, side: "CE", strike: 22000, family: "X" }, P)!;
  assert.equal(g.why, "STOP"); assert.equal(g.exit, 80); assert.equal(g.gross, -20);
});

test("slippage is paid on entry and exit", () => {
  const d = day([[100, 101, 99, 100], [102, 110, 101, 108], [108, 125, 107, 121]]);
  const t = simulateTrade(d, { t: T0, side: "CE", strike: 22000, family: "X" }, { ...P, slip: 1 })!;
  assert.equal(t.entry, 103); assert.equal(t.exit, 122); assert.equal(t.gross, 19);
});

test("time exit, data gap and no fill when the next bar is too late", () => {
  const flat = day(Array.from({ length: 40 }, () => [100, 101, 99, 100] as [number, number, number, number]));
  const t = simulateTrade(flat, { t: T0, side: "CE", strike: 22000, family: "X" }, P)!;
  assert.equal(t.why, "TIME"); assert.equal(t.minsHeld, 30);
  const gap = day([[100, 100, 100, 100], [100, 101, 99, 100], [100, 101, 99, 100], [105, 106, 104, 105]], 3);
  assert.equal(simulateTrade(gap, { t: T0, side: "CE", strike: 22000, family: "X" }, P)!.why, "DATA_GAP");
  const late = day([[100, 100, 100, 100], [100, 101, 99, 100]], 1);
  assert.equal(simulateTrade(late, { t: T0, side: "CE", strike: 22000, family: "X" }, P), null);
});

test("daily rules: no overlapping trades, stop after a target, max 2", () => {
  const d = day([[100, 100, 100, 100], [100, 101, 99, 100], [100, 125, 99, 121], ...Array.from({ length: 10 }, () => [100, 101, 99, 100] as [number, number, number, number])]);
  const tr = runDay(d, [{ t: T0, side: "CE", strike: 22000, family: "X" }, { t: T0 + 60, side: "CE", strike: 22000, family: "X" }, { t: T0 + 300, side: "CE", strike: 22000, family: "X" }], P);
  assert.equal(tr.length, 1); assert.equal(tr[0].why, "TARGET");
});

test("stats: break-even win rate, profit factor, block bootstrap", () => {
  const mk = (day: string, net: number) => ({ day, net, why: net > 0 ? "TARGET" : "STOP", minsToTarget: net > 0 ? 5 : null, mae: 3 }) as any;
  const tr = [mk("a", 19), mk("b", -11), mk("c", -11), mk("d", 19), mk("e", -11), mk("f", 19), mk("g", -11), mk("h", -11), mk("i", 19), mk("j", -11)];
  const s = stats(tr, 12);
  assert.equal(s.winRate, 40); assert.equal(s.breakEvenWinRate, 36.67); assert.equal(s.noTradeDays, 2);
  assert.equal(s.profitFactor, Math.round((76 / 66) * 100) / 100);
  assert.ok(bootstrapLB(tr)! < s.expectancy);
});
