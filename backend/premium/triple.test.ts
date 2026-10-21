import { test } from "node:test";
import assert from "node:assert/strict";
import { sameDayOdds, byExpiryOdds, slotOf, topTwo, TripleTable, Cand } from "./triple";

const t: TripleTable = { index: "T", from: "a", to: "b", sessions: 500, step: 50, times: [570, 600, 630], cells: {
  "CE|2|600|E": { n: 100, hit3: 20, hit2: 40 }, "PE|2|600|E": { n: 100, hit3: 10, hit2: 30 }, "CE|1|600|N": { n: 10, hit3: 1, hit2: 2 }, "PE|1|600|N": { n: 25, hit3: 0, hit2: 3 },
  "CE|1|570|N": { n: 40, hit3: 0, hit2: 4 } }, expiry: { "CE|3|1|570": { n: 200, hit3: 40, hit2: 80 }, "PE|3|1|570": { n: 5, hit3: 5, hit2: 5 }, "CE|3|1|750": { n: 190, hit3: 30, hit2: 70 } } };

test("odds: exact bucket first; too small (< 30) → both sides together → the neighbouring half hours; none → null", () => {
  assert.deepEqual(sameDayOdds(t, "CE", 2, 600, true), { p3: 20, p2: 40, n: 100 });
  assert.deepEqual(sameDayOdds(t, "CE", 1, 600, false), { p3: 2.9, p2: 14.3, n: 35 }, "10 + 25 sessions merged across sides");
  assert.equal(sameDayOdds(t, "CE", 3, 600, false), null);
  assert.deepEqual(byExpiryOdds(t, "CE", 3, 1, 600), { p3: 20, p2: 40, n: 200 }); assert.deepEqual(byExpiryOdds(t, "CE", 3, 1, 760), { p3: 15.8, p2: 36.8, n: 190 }, "12:30 decision");
  assert.deepEqual(byExpiryOdds(t, "PE", 3, 1, 570), { p3: 22, p2: 41.5, n: 205 }, "5 PE sessions → merged with CE");
  assert.equal(slotOf(t, 615), 600); assert.equal(slotOf(t, 500), 570);
});
test("topTwo: the best tested 3× chance (the horizon that applies), liquid only, no duplicates", () => {
  const c = (side: "CE" | "PE", strike: number, otm: number, p3: number | null, liq = "GOOD", p2 = 30): Cand => ({ side, strike, otm, ltp: 50, liq, spreadPct: 1, delta: 0.3, today: p3 == null ? null : { p3, p2, n: 100 }, toExpiry: { p3: 5, p2: 10, n: 100 } });
  const picks = topTwo([c("CE", 100, 1, 12), c("PE", 90, 2, 21), c("CE", 110, 2, 25, "POOR"), c("PE", 80, 3, 21, "GOOD", 40), c("CE", 120, 3, null)], true);
  assert.deepEqual(picks.map((x) => `${x.strike}${x.side}`), ["80PE", "90PE"], "POOR liquidity left out; tie on 21% → the higher 2× chance first");
  assert.equal(picks[0].horizon, "today");
  assert.equal(topTwo([c("CE", 100, 1, 12)], false)[0].horizon, "by expiry", "not expiry day → odds to expiry");
});
