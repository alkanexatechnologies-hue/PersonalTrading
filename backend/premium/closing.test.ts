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
test("ProTrader daily review: stop-loss reasons from recorded facts, not-given list, forward scoreboard", async () => {
  const { slReasons, dailyReviewMsg } = await import("./closing");
  const at = (h: number, m: number) => Date.UTC(2026, 9, 19, h, m) / 1000 - 19800;
  assert.deepEqual(slReasons({ name: "NIFTY 50", strike: 23100, side: "CE", openedAt: at(14, 20), premPct: -35, review: { grade: "B", failed: ["trend"] }, rangeDay: false }),
    ["late entry (after 14:00 — the 2-yr record for late entries is the worst)", "review B (half size) — one pillar was soft", "against the higher-timeframe trend", "premium lost 35% before the index stop fired"]);
  assert.match(slReasons({ name: "X", strike: 1, side: "PE", openedAt: at(10, 0), premPct: -20, review: { grade: "A", failed: [] } })[0], /setup was clean/);
  const m = dailyReviewMsg({ day: "2026-10-19", sl: [], notGiven: [{ index: "NIFTY 50", side: "CE", time: at(10, 45), level: 23226, why: "NO RETEST" }, { index: "SENSEX", side: "PE", time: at(11, 0), level: null, why: "RANGE DAY" }],
    board: { since: "2026-10-19", n: 4, wins: 3, avgPct: 6.2 }, expiryBoard: { since: null, n: 0, wins: 0, avgPct: null }, btsdToday: 0 });
  assert.match(m, /STOP LOSSES — WHY \(0\)<\/b>\n  none today/); assert.match(m, /NO RETEST<\/b> ×1: NIFTY CE 23,226 10:45/);
  assert.match(m, /Live trades: 3\/4 wins \(75%\) · avg \+6\.2% per trade on premium/); assert.match(m, /Expiry mode \(paper\): no trades yet/); assert.match(m, /record your own trades/);
});
