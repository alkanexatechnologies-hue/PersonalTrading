import { test } from "node:test";
import assert from "node:assert/strict";
import { planProblems, realisticRisk, marketWarnings } from "./tradeCheck";
import { planBlock, triggerStatus, bestOpportunityMsg } from "./tgFormat";
import { gradeTrade } from "./closing";
import { levelProblem } from "../watchlist/scanner";

// a NIFTY bear plan like the ones sent 19–23 Oct
const mk = (plan: any, o: { spot?: number; state?: string; trends?: any[]; rangeDay?: any; expiry?: string; candles?: any[] } = {}) => ({
  symbol: "^NSEI", name: "NIFTY 50", available: true, expiry: o.expiry ?? "2026-10-27",
  spot: { price: o.spot ?? 22680, change: -6, changePct: -0.02, high: 22787, low: 22664 },
  chart: { candles: o.candles ?? [] },
  trader: { atr15: 60, trends: o.trends ?? [], rangeDay: o.rangeDay ?? null, radar: { bear: { state: o.state ?? "TRIGGERED" } }, review: {}, plans: { bear: { strike: 22700, premNow: 141, premAtEntry: 133, ...plan } } },
});
const good = { entry: 22699, stop: 22740, t1: 22600, t2: 22540, premAtT1: 190, rr: 2.4 };

test("planProblems: a consistent plan passes", () => {
  assert.deepEqual(planProblems(mk(good), "bear", { triggered: true }), []);
});

test("planProblems: the 23 Oct message — stop = start, T1 = T2, target 699 pts away", () => {
  const bad = planProblems(mk({ entry: 22699, stop: 22699, t1: 22000, t2: 22000, premAtT1: 700 }), "bear", { triggered: true });
  assert.ok(bad.some((x) => /not beyond the start/.test(x)));
  assert.ok(bad.some((x) => /Target 1 = Target 2/.test(x)));
  assert.ok(bad.some((x) => /realistic day's move/.test(x)));
});

test("planProblems: index already past the stop / already at T1 — only once triggered", () => {
  const pastStop = mk(good, { spot: 22745 });
  assert.ok(planProblems(pastStop, "bear", { triggered: true }).some((x) => /already past the stop/.test(x)));
  assert.deepEqual(planProblems(pastStop, "bear", { triggered: false }), [], "an approaching plan may sit beyond its stop");
  assert.ok(planProblems(mk(good, { spot: 22590 }), "bear", { triggered: true }).some((x) => /already reached Target 1/.test(x)));
});

test("planProblems: T1 premium not above the premium now (22 Oct)", () => {
  const d = mk({ ...good, premAtT1: 176 }); d.trader.plans.bear.premNow = 183;
  assert.ok(planProblems(d, "bear", {}).some((x) => /Target 1 premium/.test(x)));
});

test("realisticRisk: stop distance from the index now + one 15-min ATR", () => {
  assert.deepEqual(realisticRisk(mk(good, { spot: 22680 }), "bear"), { stopPts: 60, worstPts: 120 });
  assert.deepEqual(realisticRisk(mk(good, { spot: 22760 }), "bear"), { stopPts: 41, worstPts: 101 }, "not triggered yet: from the start 22,699");
});

test("marketWarnings: expiry day, against the trend, late premium, fast market, VIX", () => {
  const big = Array.from({ length: 6 }, (_, i) => ({ time: i, open: 1, high: 200, low: 50, close: 100 }));   // range 150 = 2.5× ATR 60
  const d = mk(good, { expiry: "2026-10-27", trends: [{ tf: "Daily", verdict: "UP" }, { tf: "15m", verdict: "DOWN" }], candles: big });
  d.trader.plans.bear.premNow = 160;   // 20% above the start premium 133
  const w = marketWarnings(d, "bear", { day: "2026-10-27", vix: { value: 19.2, changePct: 3 } });
  for (const re of [/EXPIRY DAY/, /AGAINST THE TREND — Daily/, /LATE — premium now ₹160/, /FAST MARKET/, /VIX 19.2/]) assert.ok(w.some((x) => re.test(x)), String(re));
  assert.ok(!w.some((x) => /15m/.test(x) && /AGAINST/.test(x)), "a 15m down-trend is not against a bear trade");
});

test("planBlock: an impossible plan is shown as NOT A TRADE, without Buy / table / review", () => {
  const txt = planBlock(mk({ entry: 22699, stop: 22699, t1: 22000, t2: 22000 }), "bear").join("\n");
  assert.match(txt, /NOT A TRADE/);
  assert.doesNotMatch(txt, /Buy <b>22700 PE/);
  assert.doesNotMatch(txt, /Reward : risk/);
});

test("planBlock: real-risk line; review verdict replaced by the real status or 'if it triggers'", () => {
  const d: any = mk(good); d.trader.review.bear = { grade: "B", score: 63, verdict: "TAKE SMALL — half size", checks: [{ ok: true, label: "x" }], reasoning: [] };
  assert.match(planBlock(d, "bear").join("\n"), /plan for up to <b>~120 pts<\/b> against you/);
  assert.match(planBlock(d, "bear", { status: "NOT GIVEN" }).join("\n"), /→ <b>NOT GIVEN<\/b>/);
  d.trader.radar.bear.state = "APPROACHING";
  assert.match(planBlock(d, "bear").join("\n"), /→ if it triggers: <b>TAKE SMALL/);
});

test("triggerStatus: waiting for the retest / not given / under review — never a bare TAKE", () => {
  const d = mk(good);
  assert.match(triggerStatus(d, "bear", { pending: { side: "bear", trigger: 22699, until: 1792731000 } })!.say, /Not a trade yet/);
  const ng = triggerStatus(d, "bear", { notGiven: [{ index: "NIFTY 50", side: "PE", level: 22699, time: 1792729200, why: "RANGE DAY" }] })!;
  assert.equal(ng.status, "NOT GIVEN"); assert.match(ng.say, /range day/);
  assert.match(triggerStatus(d, "bear", {})!.status, /under review/);
  assert.equal(triggerStatus(mk(good, { state: "ARMED" }), "bear", {}), null);
});

test("bestOpportunityMsg: an open trade uses the chain premium; closed trades are listed with their result", () => {
  const d: any = mk(good);
  const trade = { index: "^NSEI", side: "PE", strike: 22700, entryPrem: 151.8, entrySpot: 22656, stop: 22699, t1: 22600, t2: 22540, state: "OPEN" };
  const m = bestOpportunityMsg([{ d, trade, eye: null, zh: null, cp: { livePrem: 181, closed: [{ index: "^NSEI", strike: 22650, side: "CE", exitWhy: "STOP LOSS", closedAt: 1792729213, entryPrem: 120, exitPrem: 96 }] } }]);
  assert.match(m, /now <b>₹181<\/b> \(\+19%\)/);
  assert.match(m, /📒 Today: 22650 CE · STOP LOSS at 09:50 · ₹120 → ₹96 \(-20%\)/);
});

test("gradeTrade: no recorded premium → graded on the index (19 Oct Target-2 trade was '➖')", () => {
  const g = gradeTrade({ source: "co-pilot", name: "SENSEX", side: "PE", strike: 74700, openedAt: 1, closedAt: 2, entrySpot: 74708, exitSpot: 74031, entryPrem: 455, exitPrem: null, exitWhy: "TARGET 2", state: "CLOSED" });
  assert.equal(g.result, "SUCCESS"); assert.equal(g.basis, "index");
  const s = gradeTrade({ source: "co-pilot", name: "NIFTY 50", side: "CE", strike: 22700, openedAt: 1, closedAt: 2, entrySpot: 22700, exitSpot: 22650, entryPrem: 100, exitPrem: null, exitWhy: "STOP LOSS", state: "CLOSED" });
  assert.equal(s.result, "FAILED");
  assert.equal(gradeTrade({ source: "x", name: "N", side: "CE", strike: 1, openedAt: 1, entryPrem: 10, exitPrem: 12, state: "CLOSED" }).basis, "premium");
});

test("watchlist levelProblem: equal, wrong-side and already-void setups (24 Oct rows)", () => {
  assert.match(levelProblem("Bearish", 1394.2, 1400, 1400)!, /trigger = invalidation/);
  assert.match(levelProblem("Bearish", 1892.1, 1900, 1840)!, /wrong side/);
  assert.match(levelProblem("Bearish", 2530, 2200, 2400)!, /already past the invalidation/);
  assert.match(levelProblem("Bullish", 11230, 12000, 11500)!, /already past the invalidation/);
  assert.equal(levelProblem("Bullish", 3647, 3700, 3600), null);
  assert.equal(levelProblem("Neutral", 100, null, null), null);
});
