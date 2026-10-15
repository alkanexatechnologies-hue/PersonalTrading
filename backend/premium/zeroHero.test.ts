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
  assert.match(zeroHero({ ...base, istMin: 700, closed5Today: morning }).window, /WAIT/);
  assert.match(zeroHero({ ...base, istMin: 900, closed5Today: morning }).window, /CLOSED/);
  assert.match(zeroHero({ ...base, expiry: "2026-10-19", istMin: 830, closed5Today: morning }).window, /NOT AN EXPIRY/);
  // wick above the high is not a trigger; a close above is
  const wick = [...morning, bar("13:35", 22990, 22900, 22930)];
  assert.equal(zeroHero({ ...base, istMin: 830, closed5Today: wick }).sides[0].trigger.state, "WAIT");
  const close = [...morning, bar("13:35", 22970, 22900, 22960)];
  const z = zeroHero({ ...base, istMin: 830, closed5Today: close });
  assert.equal(z.sides[0].trigger.state, "TRIGGERED"); assert.equal(z.sides[0].strike, 23000);
  assert.ok(z.sides[0].moveToDouble! > 0); assert.ok(z.sides[0].lots! >= 0); assert.match(z.history!.text, /2 years/);
});
