import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, Leg, legKey, parseIdx } from "./data";
import { featuresAt, impliedVol, classify, Features } from "./features";
import { outcomeFor, grade } from "./outcomes";
import { buildRows, wilson } from "./run";
import { bsPrice } from "../../analysis/greeks";

const day = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
const EXP = "2025-03-27";
function mk(n: number, drift = 10): Session[] {
  const out: Session[] = [];
  for (let i = 0; i < n; i++) {
    const c = 22000 + i * drift + (i % 3) * 15, legs = new Map<string, Leg>();
    for (let k = 21000; k <= 23500; k += 50) for (const side of ["CE", "PE"] as const) {
      const p = bsPrice({ spot: c, strike: k, tYears: (60 - i) / 365, iv: 0.14 }, side)!;
      legs.set(legKey(EXP, k, side), { expiry: EXP, strike: k, side, o: p, h: p * 1.05, l: p * 0.95, c: p, settle: p, oi: 1000, chgOi: side === "PE" ? 50 : 10, vol: 100 });
    }
    out.push({ day: day(i), nifty: { day: day(i), o: c - 20, h: c + 30, l: c - 40, c }, vix: { day: day(i), o: 14, h: 14, l: 14, c: 14 }, legs, expiries: [EXP] });
  }
  return out;
}

test("implied volatility round-trips Black-Scholes", () => {
  const p = bsPrice({ spot: 22600, strike: 22700, tYears: 5 / 365, iv: 0.15, rate: 0.065 }, "CE")!;
  assert.ok(Math.abs(impliedVol(p, 22600, 22700, 5 / 365, "CE")! - 0.15) < 1e-4);
  assert.equal(impliedVol(0.01, 22600, 22000, 5 / 365, "CE"), null);   // below intrinsic
});
test("no look-ahead: changing D+1 never changes D's features", () => {
  const s = mk(40), spot = new Map<string, number[]>();
  const before = buildRows(s, spot).map((r) => JSON.stringify(r.f));
  const t = mk(40); for (let i = 30; i < 40; i++) { t[i].nifty.c += 500; t[i].nifty.h += 900; for (const l of t[i].legs.values()) l.c *= 3; }
  const after = buildRows(t, spot).map((r) => JSON.stringify(r.f));
  for (let i = 0; i < 28; i++) assert.equal(after[i], before[i], `row ${i} (D=${s[i + 1].day}) changed`);
});
test("rising market with rising calls scores bullish on spot and premium", () => {
  const f = featuresAt(mk(40, 25));
  assert.ok(f.A > 0); assert.ok(f.nCE >= 5 && f.nPE >= 5); assert.ok(f.B! > 0); assert.ok(f.d1! > 0);
  assert.equal(f.expiry, EXP); assert.equal(f.atm % 50, 0);
});
test("expiry day uses the next expiry", () => {
  const s = mk(30); s[29].expiries = [s[29].day, EXP];
  assert.equal(featuresAt(s).expiry, EXP);
});
test("classes: thresholds, conflict = NO_EDGE, missing premium = INSUFFICIENT_DATA", () => {
  const f = { insufficientSpot: false, A: 0.6, a1: 1, a2: 0, a3: 1, B: -0.5, b1: -0.5, b2: -0.5, Dx: 0 } as unknown as Features;
  assert.equal(classify(f, "A", 0.3), "BULLISH");
  assert.equal(classify(f, "B", 0.3), "BEARISH");
  assert.equal(classify(f, "C", 0.3), "NO_EDGE");
  assert.equal(classify({ ...f, B: null } as any, "C", 0.3), "INSUFFICIENT_DATA");
  assert.equal(classify({ ...f, A: 0.05, B: 0.05 } as any, "C", 0.3), "NEUTRAL");
});
test("first touch uses gap, then daily, then 1-minute order", () => {
  const s = mk(3); const D = s[1], N = s[2];
  N.nifty = { day: N.day, o: D.nifty.c + 60, h: D.nifty.c + 80, l: D.nifty.c - 10, c: D.nifty.c + 50 };
  assert.equal(outcomeFor(D, N, 100, null).o2, "UP");                     // gap ≥ +50
  N.nifty = { day: N.day, o: D.nifty.c, h: D.nifty.c + 60, l: D.nifty.c - 60, c: D.nifty.c };
  assert.equal(outcomeFor(D, N, 100, null).o2, "AMBIGUOUS");
  assert.equal(outcomeFor(D, N, 100, [D.nifty.c - 10, D.nifty.c - 55, D.nifty.c + 60]).o2, "DOWN");
  const o = outcomeFor(D, N, 100, null); assert.equal(grade("BULLISH", { ...o, o1: "UP", openToClose: 20 }).pnl, 17);
});
test("official index file parsing and Wilson interval", () => {
  const p = parseIdx("Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value\nNifty 50,13-10-2026,22364.15,22721.95,22288.45,22721.95\nIndia VIX,13-10-2026,15.25,15.35,13.94,14.12");
  assert.equal(p.nifty!.day, "2026-10-13"); assert.equal(p.nifty!.h, 22721.95); assert.equal(p.vix!.c, 14.12);
  const [lo, hi] = wilson(60, 100) as number[]; assert.ok(lo > 49 && lo < 51 && hi > 68 && hi < 70);
});
