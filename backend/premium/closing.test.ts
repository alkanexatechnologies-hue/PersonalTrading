import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeTrade, dayScore, trend, closingStatementMsg, Scorecard } from "./closing";

const base = { source: "co-pilot", name: "NIFTY 50", strike: 23050, openedAt: 1_792_125_000, closedAt: 1_792_140_000, state: "CLOSED" };

test("grading: T1 half counted, stop loss failed with lesson, time-exit loss, open trade not scored", () => {
  const t1 = gradeTrade({ ...base, side: "CE", entrySpot: 23060, exitSpot: 23060, entryPrem: 100, t1Prem: 160, exitPrem: 95, exitWhy: "BREAKEVEN STOP (after T1)" });
  assert.equal(t1.premPts, 27.5); assert.equal(t1.result, "SUCCESS"); assert.equal(t1.idxPts, 0);
  const sl = gradeTrade({ ...base, side: "PE", entrySpot: 23000, exitSpot: 23030, entryPrem: 120, exitPrem: 90, exitWhy: "STOP LOSS" });
  assert.equal(sl.result, "FAILED"); assert.equal(sl.idxPts, -30); assert.equal(sl.premPct, -25); assert.match(sl.lesson!, /reversed through the stop/);
  const te = gradeTrade({ ...base, side: "CE", entryPrem: 540.5, exitPrem: 506.6, exitWhy: "TIME EXIT 15:12" });
  assert.equal(te.premPts, -33.9); assert.match(te.lesson!, /time decay/); assert.equal(te.idxPts, null);
  const op = gradeTrade({ ...base, side: "CE", state: "OPEN", entryPrem: 100 });
  assert.equal(op.result, "OPEN");
  const s = dayScore([t1, sl, te, op]);
  assert.deepEqual({ n: s.n, wins: s.wins, losses: s.losses, rate: s.ratePct, net: s.netPremPts }, { n: 3, wins: 1, losses: 2, rate: 33, net: -36.4 });
});
test("trend: pooled rates and direction; statement bolds result, SL failures and lists every trade", () => {
  const card: Scorecard = { days: {} };
  const d = (i: number) => `2026-10-${String(i).padStart(2, "0")}`;
  for (let i = 1; i <= 5; i++) card.days[d(i)] = { n: 2, wins: 0, losses: 2, flat: 0, ratePct: 0, netPremPts: -10 };
  for (let i = 6; i <= 10; i++) card.days[d(i)] = { n: 2, wins: 1, losses: 1, flat: 0, ratePct: 50, netPremPts: 5 };
  const tr = trend(card, d(10));
  assert.equal(tr.last5.ratePct, 50); assert.equal(tr.prev5.ratePct, 0); assert.equal(tr.direction, "IMPROVING");
  assert.equal(trend({ days: {} }, d(1)).direction, "BUILDING HISTORY");
  const g = [gradeTrade({ ...base, side: "PE", entryPrem: 120, exitPrem: 90, exitWhy: "STOP LOSS" })];
  card.days[d(10)] = dayScore(g);
  const m = closingStatementMsg({ day: d(10), indices: [{ name: "NIFTY 50", close: 23146, changePct: 0.65, high: 23150, low: 22914, dayType: "TREND <UP>" }], graded: g, tr: trend(card, d(10)) });
  assert.match(m, /CLOSING STATEMENT/); assert.match(m, /RESULT: 0\/1 successful \(0%\)/);
  assert.match(m, /<b>NIFTY 23050 PE: -30 pts<\/b> — STOP LOSS/); assert.match(m, /TREND &lt;UP&gt;/);
  assert.match(closingStatementMsg({ day: d(11), indices: [], graded: [], tr: trend(card, d(11)) }), /nothing to score/);
});
