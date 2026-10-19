import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict, windowStart, reportedHeadline, ResultRow } from "./resultsReview";

const row = (o: Partial<ResultRow>): ResultRow => ({ sym: "X", name: "X Ltd", reportedAt: 0, quarter: "2Q2027", epsActual: 10, epsEst: 10, surprisePct: 0, profit: 100, profitPrev: 100, revenue: 1000, revenuePrev: 1000, dayChgPct: 0, ...o });

test("results verdict: beat / miss / in line with growth / profit drop / mixed", () => {
  assert.equal(verdict(row({ surprisePct: 1.09 * 2, epsActual: 12.63, epsEst: 12.37 })).verdict, "GOOD");
  assert.equal(verdict(row({ surprisePct: -3 })).verdict, "BAD");
  assert.equal(verdict(row({ surprisePct: 0.8, profit: 106, revenue: 1010 })).verdict, "GOOD");   // in line, +6% profit, revenue up
  assert.equal(verdict(row({ surprisePct: 0.8, profit: 106, revenue: 990 })).verdict, "MIXED");   // revenue down
  assert.equal(verdict(row({ surprisePct: null, profit: 85 })).verdict, "BAD");                   // −15% QoQ profit
  assert.equal(verdict(row({ surprisePct: null })).verdict, "MIXED");
  const v = verdict(row({ surprisePct: 1.09, epsActual: 12.63, epsEst: 12.494, profit: 19509, profitPrev: 19059, revenue: 48450, revenuePrev: 46355 }));
  assert.equal(v.profitQoQ, 2.4); assert.equal(v.revenueQoQ, 4.5); assert.match(v.why, /EPS 12\.63 vs est 12\.494 \(\+1\.09% in line\)/);
});
test("window = since the start of the previous trading day (weekends reach back to Friday)", () => {
  const ist = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m - 1, d, h) - 19800000;
  assert.equal(new Date((windowStart(ist(2026, 10, 18)) + 19800) * 1000).toISOString().slice(0, 10), "2026-10-16");   // Sunday → Friday
  assert.equal(new Date((windowStart(ist(2026, 10, 19)) + 19800) * 1000).toISOString().slice(0, 10), "2026-10-16");   // Monday → Friday
  assert.equal(new Date((windowStart(ist(2026, 10, 21)) + 19800) * 1000).toISOString().slice(0, 10), "2026-10-20");   // Wednesday → Tuesday
});
test("only headlines that REPORT results count (previews / date stories are dropped)", () => {
  assert.equal(reportedHeadline("Axis Bank Q2 profit up 38% on loan growth"), true);
  assert.equal(reportedHeadline("What’s next for IDBI Bank stock after Q2 net profit slumps 39%"), true);
  assert.equal(reportedHeadline("Bajaj Finance Q2 preview: Profit may jump 29%, NII 24%"), false);
  assert.equal(reportedHeadline("Bajaj Finance Q2 results 2026: Date, time, preview, expectations"), false);
  assert.equal(reportedHeadline("Adani Group stocks Q2 results 2026 date this week"), false);
});
