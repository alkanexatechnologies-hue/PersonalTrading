import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, adopt, step, live } from "./oneTrade";

const T = (h: number, m: number) => Date.parse(`2026-10-28T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+05:30`) / 1000;
// 28 Oct: co-pilot 22700 PE given on the retest at 14:35 (entry 22,695.95, ₹180.25, stop 22,722)
const co = { index: "^NSEI", name: "NIFTY 50", side: "PE" as const, strike: 22700, openedAt: T(14, 35), entrySpot: 22695.95, entryPrem: 180.25, stop: 22722 };

test("adopts the first trade with a 1:2 target and Hindi reasons; a second trade is refused while it is open", () => {
  const st = fresh("2026-10-28"), e = adopt(st, co, { delta: 0.45, review: "A", trigger: 22700 })!;
  assert.equal(st.trade!.risk, 26.05); assert.equal(st.trade!.target, 22643.85);   // 22,695.95 − 2 × 26.05
  assert.equal(st.trade!.stopPrem, Math.round(180.25 - 0.45 * 26.05)); assert.equal(st.trade!.targetPrem, Math.round(180.25 + 0.45 * 52.1));
  assert.match(e.text, /नया trade: NIFTY 50 22700 PE, ₹180 पर।.*22,700 के नीचे बंद.*14:35.*review A.*Target 1:2: NIFTY 50 22,644/);
  assert.equal(adopt(st, { ...co, index: "^BSESN", strike: 73200 }, {}), null);
  assert.equal(adopt(fresh("d"), { ...co, stop: 22680 }, {}), null);   // a PE stop below the entry is not a trade
});

test("exits: target touch, 15-min close stop (only after the entry), 15:12 time; progress and warning notes once", () => {
  let st = fresh("d"); adopt(st, co, { delta: 0.45 });
  assert.deepEqual(step(st, { spot: 22705, prem: 176, last15: { time: T(14, 30), close: 22730 }, nowSec: T(14, 36), istMin: 876 }).map((e) => e.kind), []);   // that 15-min close was before the entry
  assert.deepEqual(step(st, { spot: 22716, prem: 172, last15: null, nowSec: T(14, 40), istMin: 880 }).map((e) => e.kind), ["WARN"]);
  assert.deepEqual(step(st, { spot: 22718, prem: 171, last15: null, nowSec: T(14, 41), istMin: 881 }).map((e) => e.kind), []);   // the warning is said once
  const sl = step(st, { spot: 22725, prem: 168, last15: { time: T(14, 45), close: 22723 }, nowSec: T(14, 45), istMin: 885 });
  assert.equal(sl[0].kind, "SL"); assert.match(sl[0].text, /−₹12 प्रति unit, 1 lot पर −₹919/); assert.equal(st.trade, null); assert.equal(st.closed[0].state, "SL");

  st = fresh("d"); adopt(st, co, { delta: 0.45 });
  assert.deepEqual(step(st, { spot: 22669, prem: 192, last15: null, nowSec: T(14, 40), istMin: 880 }).map((e) => e.kind), ["PROGRESS"]);
  assert.equal(step(st, { spot: 22643, prem: 204, last15: null, nowSec: T(14, 50), istMin: 890 })[0].kind, "TARGET");
  assert.ok(adopt(st, { ...co, openedAt: T(14, 55) }, {}));   // flat again → the next trade is allowed

  st = fresh("d"); adopt(st, co, {});
  const tm = step(st, { spot: 22698, prem: 177.45, last15: null, nowSec: T(15, 12), istMin: 912 });
  assert.equal(tm[0].kind, "TIME"); assert.equal(st.closed[0].exitPrem, 177.45);
});

test("live numbers: P&L per unit and per lot, R multiple", () => {
  const st = fresh("d"); adopt(st, co, { delta: 0.45 });
  assert.deepEqual(live(st.trade!, 22669.9, 192.25), { spot: 22669.9, prem: 192.25, pnl: 12, pnlLot: 900, r: 1, lot: 75 });
});
