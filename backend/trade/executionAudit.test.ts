import { test } from "node:test";
import assert from "node:assert/strict";
import { auditTrade, summarizeAudit } from "./executionAudit";

const T = Math.floor(Date.parse("2026-10-07T04:13:10Z") / 1000);   // 09:43:10 IST
const trade = (o: any = {}) => ({ id: "x", seq: 1, date: "2026-10-07", time: "09:43:10", execTs: T, index: "NIFTY 50", symbol: "^NSEI", type: "PE", strike: 22700, entry: 209.3, sl: 190, target: 250, rr: "1:2.2", status: "SL Hit", exitPrice: 190, exitTime: "09:50:00", remarks: "Auto signal · TRADE", totalPoint: -19.3, ...o }) as any;
const dec = (action: string, minsBefore: number) => ({ type: "decision", candleClosed: true, finalAction: action, decidedAt: T - minsBefore * 60 + 30, candleTime: T - minsBefore * 60, candleIso: "2026-10-07 09:40 IST" });

test("blocked when the arbiter was WAIT at the trade time", () => {
  const r = auditTrade(trade(), [dec("WAIT", 3)]);
  assert.equal(r.verdict, "BLOCKED"); assert.match(r.checks[0].text, /Arbiter said WAIT/);
});
test("allowed when the arbiter was BUY on the same side, recent, with a real stop and reachable target", () => {
  const r = auditTrade(trade(), [dec("BUY_PE", 3)]);
  assert.equal(r.verdict, "ALLOWED");
});
test("stale arbiter BUY (> 15 min) and opposite side are blocked", () => {
  assert.equal(auditTrade(trade(), [dec("BUY_PE", 30)]).verdict, "BLOCKED");
  assert.equal(auditTrade(trade(), [dec("BUY_CE", 3)]).verdict, "BLOCKED");
});
test("SL ₹0.05 and out-of-reach R:R are flagged even without a ledger", () => {
  const r = auditTrade(trade({ sl: 0.05, rr: "1:0.28" }), null);
  assert.equal(r.verdict, "BLOCKED"); assert.equal(r.checks.find((c) => c.key === "stop")!.ok, false);
  const r2 = auditTrade(trade({ rr: "1:83.81" }), null);
  assert.equal(r2.checks.find((c) => c.key === "target")!.ok, false);
  assert.equal(auditTrade(trade(), null).verdict, "NOT RECORDED");
});
test("EOD square-off labelled Target Hit is shown as EOD Exit; summary totals", () => {
  const r = auditTrade(trade({ status: "Target Hit", exitPrice: 220, remarks: "Auto signal · EOD square-off @ 220 (in profit; target/SL not touched)" }), [dec("BUY_PE", 3)]);
  assert.equal(r.status, "EOD Exit"); assert.ok(r.checks.some((c) => c.key === "label"));
  const s = summarizeAudit([r, auditTrade(trade(), [dec("WAIT", 3)])]);
  assert.equal(s.blocked, 1); assert.equal(s.blockedPoints, -19.3); assert.equal(s.relabelled, 1);
});
