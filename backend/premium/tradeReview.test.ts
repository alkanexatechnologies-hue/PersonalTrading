import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewTrade, reviewHtml, learn, learnedLines } from "./tradeReview";

const mk = (o: any = {}) => ({
  spot: { price: 23070 }, chart: { vwap: [23000, 23020] },
  master: { arbiterSays: "GO — confirmed", riskGate: { ok: true, gates: [] } },
  ce: { behaviour: { response: "RISING" }, liquidity: { status: "GOOD" } }, pe: { behaviour: { response: "FALLING" } },
  ranking: [{ side: "CE", strike: 23050, change: 12, oiChg: 5000, liquidity: "GOOD" }],
  trader: { atr15: 40, trends: [{ tf: "Daily", verdict: "UP" }, { tf: "1H", verdict: "UP" }, { tf: "15m", verdict: "UP" }],
    radar: { bull: { state: "TRIGGERED" }, bear: { state: "IDLE" } }, eventStats: { up: { n: 100, pct: 58 }, down: { n: 100, pct: 50 } },
    plans: { bull: { entry: 23061, stop: 23040, t1: 23157, rr: 4.5, strike: 23050, triggerRisk: { roomPts: 95 } }, bear: { entry: 22896, stop: 22917, t1: 22776, rr: 5, strike: 22900, triggerRisk: { roomPts: 120 } } } },
  ...o,
});

test("review: a clean confirmed CE trade grades A; chasing past 60% of T1 or 2 losses today = C (critical)", () => {
  const a = reviewTrade(mk(), "bull", { istMin: 600, eye: { lead: "UP", upPct: 50, downPct: 20 } })!;
  assert.equal(a.grade, "A"); assert.match(a.verdict, /TAKE/); assert.equal(a.failed.length, 0);
  const chase = reviewTrade(mk({ spot: { price: 23130 } }), "bull", { istMin: 600 })!;
  assert.equal(chase.grade, "C"); assert.ok(chase.critical.some((c) => /not chasing/.test(c)));
  const tilt = reviewTrade(mk(), "bull", { istMin: 600, lossesToday: 2 })!;
  assert.equal(tilt.grade, "C"); assert.match(tilt.critical.join(), /stop for the day/);
  const late = reviewTrade(mk(), "bull", { istMin: 890 })!;
  assert.equal(late.grade, "C");
});
test("review: bear side against an up trend with writers adding on the PE grades low; html bolds the verdict and lists failures", () => {
  const d = mk({ spot: { price: 22890 }, ranking: [{ side: "PE", strike: 22900, change: -5, oiChg: 9000, liquidity: "GOOD" }] });
  d.trader.radar.bear.state = "TRIGGERED";
  const rv = reviewTrade(d, "bear", { istMin: 600 })!;
  assert.ok(rv.failed.includes("trend") && rv.failed.includes("oi") && rv.failed.includes("premium"));
  assert.notEqual(rv.grade, "A");
  const h = reviewHtml(rv);
  assert.match(h, /<b>Trade review: [BC]<\/b>/); assert.match(h, /✗ 4 failed/); assert.match(h, /⚠️ trend:/); assert.match(h, /writers adding/);
  assert.equal(reviewTrade({ trader: { plans: {} } }, "bull", { istMin: 600 }), null);
});
test("learning: per-check win rates, shown only with enough trades on both sides", () => {
  let s = { checks: {}, trades: 0 };
  const many = [...Array(12)].map((_, i) => ({ passed: ["premium"], failed: [] as string[], win: i < 8 })).concat([...Array(10)].map((_, i) => ({ passed: [] as string[], failed: ["premium"], win: i < 2 })));
  s = learn(s, many);
  assert.equal(s.trades, 22);
  assert.deepEqual(learnedLines(s), ["premium: passed → 67% wins (n=12) · failed → 20% (n=10)"]);
  assert.deepEqual(learnedLines(learn({ checks: {}, trades: 0 }, many.slice(0, 5))), []);
});
test("15th point: logic pillars + decisive trader's reasoning (A = take it, C = pass with the reason)", () => {
  const a = reviewTrade(mk(), "bull", { istMin: 600, eye: { lead: "UP", upPct: 50, downPct: 20 } })!;
  assert.equal(a.checks.find((c) => c.key === "logic")!.ok, true);
  assert.match(a.reasoning.join("\n"), /WITH the higher timeframes/); assert.match(a.reasoning.join("\n"), /CLOSED above 23,061/);
  assert.match(a.reasoning.join("\n"), /closes below 23,040 — then the idea is dead/);
  assert.match(a.reasoning[a.reasoning.length - 1], /^Decision: TAKE IT/);
  const d = mk({ spot: { price: 22890 }, ranking: [{ side: "PE", strike: 22900, change: -5, oiChg: 9000, liquidity: "GOOD" }] });
  d.trader.radar.bear.state = "TRIGGERED";
  const b = reviewTrade(d, "bear", { istMin: 600 })!;
  assert.match(b.reasoning.join("\n"), /AGAINST the higher timeframes/); assert.match(b.reasoning.join("\n"), /trap/);
  const c = reviewTrade(mk(), "bull", { istMin: 600, lossesToday: 2 })!;
  assert.match(c.reasoning[c.reasoning.length - 1], /^Decision: PASS\. discipline/);
  assert.match(reviewHtml(a), /Trader's reasoning<\/b>[\s\S]*<b>Decision: TAKE IT/);
  assert.ok(!/Trader's reasoning/.test(reviewHtml(a, false)));
});
