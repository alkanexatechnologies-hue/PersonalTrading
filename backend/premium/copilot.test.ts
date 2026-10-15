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
