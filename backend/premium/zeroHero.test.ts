import { test } from "node:test";
import assert from "node:assert/strict";
import { zeroHero, levelForPremium, pTouch } from "./zeroHero";
import { bsPrice } from "../analysis/greeks";

const mk = (spot: number, step: number) => [-3, -2, -1, 0, 1, 2, 3].map((r) => { const k = Math.round(spot / step) * step + r * step, t = 100 / (375 * 252);
  const ce = bsPrice({ spot, strike: k, tYears: t, iv: 0.15 }, "CE")!, pe = bsPrice({ spot, strike: k, tYears: t, iv: 0.15 }, "PE")!;
  return { strike: k, ceOi: 1000, peOi: 1000, ceChg: 0, peChg: 0, ceLtp: ce, peLtp: pe, ceIv: 15, peIv: 15, ceBid: ce * 0.98, ceAsk: ce * 1.02, peBid: pe * 0.98, peAsk: pe * 1.02 } as any; });
const T = (hm: string) => Math.floor(Date.parse(`2026-10-15T${hm}:00Z`) / 1000) - 19800;
const bar = (hm: string, h: number, l: number, c: number) => ({ time: T(hm), high: h, low: l, close: c });

test("double level and touch probability are consistent with Black-Scholes", () => {
  const t = 60 / (375 * 252), p0 = bsPrice({ spot: 22900, strike: 23000, tYears: t, iv: 0.15 }, "CE")!;
  const L = levelForPremium("CE", 23000, 22900, 0.15, t, 2 * p0)!;
  assert.ok(Math.abs(bsPrice({ spot: L, strike: 23000, tYears: t, iv: 0.15 }, "CE")! - 2 * p0) < 0.05);
  assert.ok(pTouch(22900, L, 0.15, t) > 0 && pTouch(22900, L, 0.15, t) < 100);
  assert.ok(pTouch(22900, L + 100, 0.15, t) < pTouch(22900, L, 0.15, t));   // farther = less likely
});
test("window, trigger on a 5-min CLOSE beyond the day range, and verdicts", () => {
  const chain = mk(22900, 50), base = { symbol: "^NSEI", expiry: "2026-10-15", today: "2026-10-15", spot: 22900, step: 50, lot: 75, chain, oiNow: null, oi15Ago: null, budget: 3000 };
  const morning = [bar("09:15", 22950, 22850, 22900), bar("09:20", 22940, 22860, 22910)];
  assert.match(zeroHero({ ...base, istMin: 560, closed5Today: morning }).window, /WAIT/);
  assert.match(zeroHero({ ...base, istMin: 915, closed5Today: morning }).window, /CLOSED/);
  assert.match(zeroHero({ ...base, expiry: "2026-10-19", istMin: 830, closed5Today: morning }).window, /NOT AN EXPIRY/);
  // wick above the high is not a trigger; a close above is
  const wick = [...morning, bar("13:35", 22990, 22900, 22930)];
  assert.equal(zeroHero({ ...base, istMin: 830, closed5Today: wick }).sides[0].trigger.state, "WAIT");
  const close = [...morning, bar("13:35", 22970, 22900, 22960)];
  const z = zeroHero({ ...base, istMin: 830, closed5Today: close });
  assert.equal(z.sides[0].trigger.state, "TRIGGERED"); assert.equal(z.sides[0].strike, 23000);
  assert.ok(z.sides[0].moveToDouble! > 0); assert.ok(z.sides[0].lots! >= 0); assert.match(z.history!.text, /2 years/);
});
test("frozen zero-hero trade: levels fixed; T1 2× → breakeven; T2 3×; stops; time", async () => {
  const { newZhTrade, stepZhTrade } = await import("./zeroHero");
  const mk = () => newZhTrade({ n: 1, day: "2026-10-15", symbol: "^BSESN", name: "SENSEX", side: "CE", strike: 74500, expiry: "2026-10-15", lot: 20, at: 1000, entryPrem: 40, entryIndex: 74240, triggerLevel: 74218 });
  let t = mk(); const frozen = JSON.stringify([t.entryPrem, t.t1Prem, t.t2Prem, t.slPrem, t.triggerLevel]);
  assert.deepEqual(stepZhTrade(t, { prem: 55, spot: 74300, last5: { time: 1300, close: 74290 }, nowSec: 1300, istMin: 830 }), []);
  assert.deepEqual(stepZhTrade(t, { prem: 81, spot: 74420, last5: null, nowSec: 1400, istMin: 835 }), ["T1"]); assert.equal(t.state, "T1");
  assert.deepEqual(stepZhTrade(t, { prem: 121, spot: 74480, last5: null, nowSec: 1500, istMin: 840 }), ["TARGET 2 (3×)"]); assert.equal(t.state, "CLOSED");
  assert.equal(JSON.stringify([t.entryPrem, t.t1Prem, t.t2Prem, t.slPrem, t.triggerLevel]), frozen);   // never changed
  // −51 %: breakout still intact, time left, recovery within reach → HOLD with a −75 % floor; below the floor → stop
  t = mk(); assert.deepEqual(stepZhTrade(t, { prem: 19, spot: 74230, last5: null, nowSec: 1200, istMin: 832, straddle: 250 }), ["RECHECK_HOLD"]);
  assert.equal(t.floorPrem, 10); assert.equal(t.state, "OPEN");
  assert.deepEqual(stepZhTrade(t, { prem: 9.5, spot: 74222, last5: null, nowSec: 1250, istMin: 840, straddle: 250 }), ["STOP — final floor −75% after recheck"]);
  // −51 % with too little time left → RESET (closed, ready for a fresh opportunity)
  t = mk(); const f = stepZhTrade(t, { prem: 19, spot: 74230, last5: null, nowSec: 1200, istMin: 895, straddle: 250 });
  assert.match(f[0], /^RESET/); assert.equal(t.state, "CLOSED"); assert.equal(t.reset, true);
  t = mk(); assert.deepEqual(stepZhTrade(t, { prem: 30, spot: 74200, last5: { time: 1300, close: 74210 }, nowSec: 1310, istMin: 832 }), ["STOP LOSS (breakout failed)"]);
  t = mk(); stepZhTrade(t, { prem: 82, spot: 74420, last5: null, nowSec: 1400, istMin: 835 });
  assert.deepEqual(stepZhTrade(t, { prem: 39, spot: 74300, last5: null, nowSec: 1500, istMin: 840 }), ["BREAKEVEN STOP (after T1)"]);
  t = mk(); assert.deepEqual(stepZhTrade(t, { prem: 45, spot: 74260, last5: null, nowSec: 2000, istMin: 920 }), ["TIME EXIT 15:20"]);
});

test("fresh trigger after a reset needs a NEW 5-min close beyond the day range", async () => {
  const { freshTrigger } = await import("./zeroHero");
  const T2 = (hm: string) => Math.floor(Date.parse(`2026-10-15T${hm}:00Z`) / 1000) - 19800;
  const b = (hm: string, h: number, l: number, c: number) => ({ time: T2(hm), high: h, low: l, close: c });
  const bars = [b("09:15", 110, 90, 100), b("13:25", 112, 100, 111), b("13:30", 113, 105, 112.5), b("13:45", 116, 108, 115)];
  assert.equal(freshTrigger(bars, "CE", T2("13:30") + 300)?.close, 115);   // after the reset, only the 13:45 close counts
  assert.equal(freshTrigger(bars, "CE", T2("13:50")), null);
});
