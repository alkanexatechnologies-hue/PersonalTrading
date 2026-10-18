import { test } from "node:test";
import assert from "node:assert/strict";
import { stepTrade, CoTrade, stripTags } from "./copilot";
const base = (): CoTrade => ({ index: "^NSEI", name: "NIFTY 50", side: "CE", strike: 22750, openedAt: 1000, entrySpot: 22743, entryPrem: 123, stop: 22717, t1: 22776, t2: 22800, state: "OPEN" });
test("trade follow-up: T1 → breakeven → T2; stop on a 15-min CLOSE only; time exit", () => {
  let t = base();
  assert.deepEqual(stepTrade(t, { spot: 22760, prem: 135, last15: null, nowSec: 1100, istMin: 600 }), []);
  let m = stepTrade(t, { spot: 22777, prem: 141, last15: null, nowSec: 1200, istMin: 610 });
  assert.match(m[0], /TARGET 1 HIT/); assert.equal(t.state, "T1"); assert.match(m[0], /\+18 per unit/);
  m = stepTrade(t, { spot: 22801, prem: 143, last15: null, nowSec: 1300, istMin: 620 }); assert.match(m[0], /TARGET 2 HIT/); assert.equal(t.state, "CLOSED");
  // a wick below the stop is not a stop; a 15-min close below it is
  t = base();
  assert.deepEqual(stepTrade(t, { spot: 22710, prem: 110, last15: { time: 1050, close: 22725 }, nowSec: 1100, istMin: 600 }), []);
  m = stepTrade(t, { spot: 22710, prem: 108, last15: { time: 1050, close: 22712 }, nowSec: 1150, istMin: 601 }); assert.match(m[0], /STOP LOSS/); assert.equal(t.exitWhy, "STOP LOSS");
  // after T1 the stop is breakeven
  t = base(); stepTrade(t, { spot: 22780, prem: 140, last15: null, nowSec: 1200, istMin: 610 });
  m = stepTrade(t, { spot: 22738, prem: 120, last15: { time: 1250, close: 22740 }, nowSec: 1300, istMin: 615 }); assert.match(m[0], /BREAKEVEN STOP/);
  t = base(); m = stepTrade(t, { spot: 22760, prem: 130, last15: null, nowSec: 1300, istMin: 912 }); assert.match(m[0], /TIME EXIT/);
  assert.equal(stripTags("<b>x</b> y"), "x y");
});
test("retest entry: a closed 5-min candle back within 0.25 ATR of the broken level that closes beyond it; else expires after 30 min", async () => {
  const { retestCheck } = await import("./copilot");
  const T0 = 1_792_040_400, b = (k: number, low: number, high: number, close: number) => ({ time: T0 + k * 300, low, high, close });
  const p = { side: "bull" as const, trigger: 100, atr: 20, from: T0, until: T0 + 1800 };
  const bars = [b(0, 106, 112, 110), b(1, 107, 111, 109), b(2, 101, 106, 104)];   // only bar 2 dips to ≤ 105 (101) and closes 104 > 100
  assert.equal(retestCheck(p, bars, T0 + 2 * 300 + 299).hit, null);                  // bar 2 not closed yet
  assert.equal(retestCheck(p, bars, T0 + 3 * 300)!.hit!.close, 104);
  assert.equal(retestCheck(p, [b(0, 106, 110, 108), b(1, 98, 104, 99)], T0 + 600).hit, null);   // the dip closed back below the level: not a hold
  const r = retestCheck(p, [b(0, 106, 112, 110)], T0 + 1800 + 300);
  assert.equal(r.hit, null); assert.equal(r.expired, true);
  assert.equal(retestCheck({ ...p, side: "bear", trigger: 100 }, [b(0, 92, 99, 95)], T0 + 300)!.hit!.close, 95);
});
