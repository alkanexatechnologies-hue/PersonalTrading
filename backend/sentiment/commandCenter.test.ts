import { test } from "node:test";
import assert from "node:assert/strict";
import { levelStatus, priceKinds, displayDecision, buildCommandCenter, buildLevels, scores, contributionView, type CCInputs, type Bar } from "./commandCenter";

const ist = (hh: number, mm: number, d = 13) => Math.floor(Date.UTC(2026, 9, d, hh, mm) / 1000) - 19800;
const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ time: t, open: o, high: h, low: l, close: c });
function series(fromMin: number, n: number, start = 22400, step = 0, d = 13): Bar[] {
  return Array.from({ length: n }, (_, i) => { const t = ist(0, fromMin + i * 5, d); const c = start + step * i; return bar(t, c - 1, c + 5, c - 5, c); });
}
const decision = (over: any = {}) => ({ finalAction: "WAIT", reason: "Score building", rejection: null, candleTime: ist(11, 0), candleIso: "2026-10-13 11:00 IST", dataStatus: "LIVE", direction: "BEARISH", regime: "RANGE", regimeEvidence: ["ATR ratio 0.9"], spot: 22380, plan: null, option: null, invalidation: 22420, candidates: [], bias: null, setupLabel: "Momentum continuation", evidence: null, ...over });
function base(over: Partial<CCInputs> = {}): CCInputs {
  return {
    nowSec: ist(11, 6), phase: "OPEN",
    nifty: { live: 22380, liveTs: ist(11, 6), prevClose: 22363.35, prevCloseDate: "2026-10-12" },
    candles5: series(9 * 60 + 15, 21, 22400, -1),
    vix: { value: 15, ts: ist(11, 5) },
    oi: { asOf: ist(11, 5), expiry: "2026-10-13", pcr: 0.75, maxPain: 22400, strikes: [
      { strike: 22300, ceOi: 4e6, peOi: 19e6, ceChg: 1e6, peChg: 8e6 }, { strike: 22350, ceOi: 7e6, peOi: 15e6, ceChg: 6e6, peChg: 10e6 },
      { strike: 22400, ceOi: 21e6, peOi: 19e6, ceChg: 18e6, peChg: 8e6 }, { strike: 22500, ceOi: 26e6, peOi: 8e6, ceChg: 16e6, peChg: -4e6 } ] },
    decision: decision() as any, bankDecision: null,
    probability: { nifty: { upside: 23, downside: 46, range: 31, bias: "BEARISH", confidence: "HIGH" }, bank: null, ts: ist(11, 5) },
    predictionReport: null,
    overview: { positives: ["News flow positive"], negatives: ["Banking heavyweights dragging"], globalPcts: [0.6, 0.5], globalTs: ist(8, 0), fii: { asOf: "2026-10-12", rows: [{ longPct: 9.6 }] } },
    heat: null, model: null, liveMoves: null, ...over,
  };
}

test("level status: approaching, breaking, reclaiming, rejecting", () => {
  const t = ist(10, 0);
  assert.equal(levelStatus(22400, "below", [bar(t, 22380, 22392, 22375, 22390)], 20), "APPROACHING");
  assert.equal(levelStatus(22400, "below", [bar(t, 22380, 22395, 22375, 22390), bar(t + 300, 22390, 22410, 22388, 22405)], 20), "BREAKING");
  assert.equal(levelStatus(22400, "below", [bar(t, 22390, 22410, 22388, 22405), bar(t + 300, 22405, 22406, 22380, 22385)], 20), "RECLAIMING");
  assert.equal(levelStatus(22400, "below", [bar(t, 22370, 22380, 22360, 22375), bar(t + 300, 22375, 22404, 22370, 22378)], 5), "REJECTING");
  assert.equal(levelStatus(22400, "below", [bar(t, 22300, 22310, 22290, 22300)], 20), "FAR");
});

test("price kinds: after the close, official close and last traded are shown separately with the adjustment", () => {
  const bars = [...series(9 * 60 + 15, 74, 22320, 0, 13)];
  bars.push(bar(ist(15, 25), 22316.85, 22363.35, 22316.85, 22363.35));
  const p = priceKinds(base({ phase: "CLOSED", nowSec: ist(15, 45), candles5: bars, nifty: { live: 22363.35, liveTs: ist(15, 30), prevClose: 22520.45, prevCloseDate: "2026-10-09" } }));
  assert.equal(p.officialClose!.value, 22363.35);
  assert.equal(p.lastTraded!.value, 22320);
  assert.equal(p.closingAdjustment!.points, 43.35);
  assert.equal(p.previousClose!.value, 22520.45);
});

test("decision: arbiter WAIT stays WAIT even with strong OI walls (no trade from OI alone)", () => {
  const cc = buildCommandCenter(base());
  assert.equal(cc.d.action, "WAIT");
  assert.equal(cc.d.plan, null);
});

test("decision: mapping of arbiter actions", () => {
  const map = (fa: string, reason = "") => displayDecision(base({ decision: decision({ finalAction: fa, reason }) as any }), 22380, 20, []).action;
  assert.equal(map("AVOID"), "BLOCK TRADE");
  assert.equal(map("HOLD"), "HOLD");
  assert.equal(map("WAIT", "Waiting for a retest of Swing Low"), "WAIT FOR PULLBACK");
  assert.equal(map("WAIT", "No directional edge (buy 35 / sell 55)"), "NO EDGE");
  assert.equal(displayDecision(base({ decision: null }), 22380, 20, []).action, "NO EDGE");
});

test("decision guard: stale decision, non-live data, or price moved > 1 ATR → BLOCK TRADE (never upgrades)", () => {
  const stale = displayDecision(base({ decision: decision({ finalAction: "BUY_PE", candleTime: ist(10, 30) }) as any }), 22380, 20, []);
  assert.equal(stale.action, "BLOCK TRADE"); assert.equal(stale.guard, "stale");
  const data = displayDecision(base({ decision: decision({ dataStatus: "DELAYED" }) as any }), 22380, 20, []);
  assert.equal(data.action, "BLOCK TRADE"); assert.equal(data.guard, "data");
  const moved = displayDecision(base({ decision: decision({ finalAction: "BUY_PE", spot: 22340, plan: { entry: 22340 } }) as any }), 22380, 20, []);
  assert.equal(moved.action, "BLOCK TRADE"); assert.equal(moved.guard, "moved");
  const ok = displayDecision(base({ decision: decision({ finalAction: "BUY_PE", spot: 22375, plan: { entry: 22375 } }) as any }), 22380, 20, [{ kind: "Immediate support", price: 22350 } as any]);
  assert.equal(ok.action, "TAKE PE"); assert.deepEqual(ok.distanceToOpposing, { level: 22350, kind: "Immediate support", points: 25 });
  const closed = displayDecision(base({ phase: "CLOSED", decision: decision({ candleTime: ist(10, 0) }) as any }), 22380, 20, []);
  assert.equal(closed.guard, null);
});

test("levels carry method, evidence, invalidation and timestamp; none from OI when the chain is missing", () => {
  const { levels } = buildLevels(base(), 22380);
  const bd = levels.find((l) => l.kind === "Downside breakdown zone")!;
  assert.equal(bd.price, 22300); assert.match(bd.method, /put-OI/); assert.match(bd.invalidation, /CLOSE below 22300/); assert.ok(bd.ts);
  assert.equal(levels.find((l) => l.kind === "Upside breakout zone")!.price, 22500);
  assert.equal(levels.find((l) => l.kind === "Immediate resistance")!.price, 22400);
  const none = buildLevels(base({ oi: null }), 22380);
  assert.ok(!none.levels.some((l) => /OI/.test(l.method)));
  assert.match(none.note!, /Option chain unavailable/);
});

test("scores are hidden (null) when inputs are missing and experimental ones are flagged", () => {
  const s = scores(base({ oi: null, overview: { positives: [], negatives: [], globalPcts: [], globalTs: null, fii: null } }), null);
  assert.ok(s.every((x) => x.value === null));
  const full = scores(base(), 0.4);
  assert.equal(full.find((x) => x.key === "institutional")!.experimental, true);
  assert.ok(full.find((x) => x.key === "institutional")!.value! < 0);
});

test("probabilities: RESEARCH ONLY without validation, never 'HIGH'", () => {
  const cc = buildCommandCenter(base());
  assert.equal(cc.a.probabilities.status, "RESEARCH ONLY");
  assert.ok(!JSON.stringify(cc.a.probabilities).includes("HIGH"));
  assert.equal(cc.a.probabilities.horizons.length, 3);
});

test("contributions: hidden unless the model passed; pre-open uses only the 09:13 snapshot", () => {
  assert.equal(contributionView(base(), 22363).available, false);
  const model: any = { version: "v", fittedAt: 1, validation: { pass: true }, coefs: { HDFCBANK: 0.1, ITC: 0.03 } };
  const heat: any = { date: "2026-10-13", status: "OK", takenAt: ist(9, 13), sectors: [{ stocks: [{ s: "HDFCBANK", pct: 0.5 }, { s: "ITC", pct: -1 }] }] };
  const pre = contributionView(base({ phase: "PRE_OPEN", model, heat, liveMoves: { moves: { HDFCBANK: -2 }, ts: 1 } }), 22363) as any;
  assert.equal(pre.available, true); assert.equal(pre.session, null);           // no session data before 09:15
  assert.equal(pre.preopen.explainedPoints, Math.round((0.1 * 0.5 + 0.03 * -1) / 100 * 22363 * 10) / 10);
  const sess = contributionView(base({ model, heat, liveMoves: { moves: { HDFCBANK: -1, ITC: -3 }, ts: 1 } }), 22363) as any;
  assert.ok(sess.session && sess.preopen);                                       // both, labelled separately
  assert.match(sess.model.label, /ESTIMATED CONTRIBUTION MODEL/);
  const unvalidated = contributionView(base({ model: { ...model, validation: { pass: false } } }), 22363);
  assert.equal(unvalidated.available, false);
});

test("freshness flags missing and stale inputs", () => {
  const cc = buildCommandCenter(base({ oi: null, nifty: { live: null, liveTs: null, prevClose: null, prevCloseDate: null } }));
  assert.equal(cc.a.freshness.oi, "MISSING");
  const stale = buildCommandCenter(base({ oi: { ...base().oi!, asOf: ist(10, 0) } }));
  assert.equal(stale.a.freshness.oi, "STALE");
});

// ---------------- route integration (handler + cache + failure modes) ----------------
import { commandRoute } from "./commandCenter";
const fakeRes = () => { const r: any = { body: null }; r.json = (b: any) => { r.body = b; return r; }; r.status = () => r; return r; };

test("route: one build per TTL shared by all viewers, concurrent requests coalesce", async () => {
  let calls = 0;
  const h = commandRoute(async () => { calls++; await new Promise((x) => setTimeout(x, 20)); return base(); }, 60_000);
  const [a, b] = [fakeRes(), fakeRes()];
  await Promise.all([h({}, a), h({}, b)]);
  assert.equal(calls, 1);
  const c = fakeRes(); await h({}, c);
  assert.equal(calls, 1); assert.equal(c.body.cached, true);
  assert.equal(a.body.d.action, "WAIT");
});

test("route: a failing input gather returns an explicit unavailable message, not a crash", async () => {
  const h = commandRoute(async () => { throw new Error("chain timeout"); }, 1);
  const r = fakeRes(); await h({}, r);
  assert.equal(r.body.available, false); assert.match(r.body.error, /chain timeout/);
});

test("route: missing data is flagged end-to-end (no decision, no chain, no price)", async () => {
  const h = commandRoute(async () => base({ decision: null, oi: null, nifty: { live: null, liveTs: null, prevClose: null, prevCloseDate: null }, candles5: [] }), 1);
  const r = fakeRes(); await h({}, r);
  assert.equal(r.body.d.action, "NO EDGE");
  assert.equal(r.body.c.spot, null);
  assert.equal(r.body.a.freshness.oi, "MISSING");
  assert.equal(r.body.a.freshness.decision, "MISSING");
  assert.equal(r.body.c.levels.length, 0);
});

test("route: arbiter integration — a stale BUY becomes BLOCK TRADE with the reason", async () => {
  const h = commandRoute(async () => base({ decision: decision({ finalAction: "BUY_CE", candleTime: ist(10, 0), plan: { entry: 22380 } }) as any }), 1);
  const r = fakeRes(); await h({}, r);
  assert.equal(r.body.d.action, "BLOCK TRADE"); assert.match(r.body.d.reason, /min old/);
});

test("levels ignore OI walls more than 1 % from spot", () => {
  const b = base();
  b.oi!.strikes.push({ strike: 22000, ceOi: 1e6, peOi: 99e6, ceChg: 0, peChg: 50e6 });   // 1.7 % below 22380
  const { levels } = buildLevels(b, 22380);
  assert.equal(levels.find((l) => l.kind === "Downside breakdown zone")!.price, 22300);
});

test("after the close, an after-hours option chain is flagged as provisional", () => {
  const cc = buildCommandCenter(base({ phase: "CLOSED", nowSec: ist(16, 10), oi: { ...base().oi!, asOf: ist(16, 6) } }));
  assert.match(cc.c.note!, /after the close/);
  assert.equal(cc.a.freshness.oi, "AFTER-HOURS");
});

test("route: ?force=true bypasses the cache, at most once per 20 s", async () => {
  let calls = 0;
  const h = commandRoute(async () => { calls++; return base(); }, 60_000);
  await h({}, fakeRes()); await h({ query: { force: "true" } }, fakeRes()); await h({ query: { force: "true" } }, fakeRes());
  assert.equal(calls, 2);
});

import { levelSequence } from "./commandCenter";
test("levels in price sequence: highest first, same price merged, spot inserted with distances", () => {
  const L = (kind: string, price: number) => ({ kind, price, method: "m", evidence: "e", invalidation: "i", ts: 1, status: "FAR" as const });
  const seq = levelSequence([L("Immediate support", 22350), L("Upside breakout zone", 22500), L("Reversal-down zone", 22500), L("Day high", 22651.1), L("Downside breakdown zone", 22300)], 22363.35);
  assert.deepEqual(seq.map((r) => (r.spot ? "SPOT" : r.kinds.join("+"))), ["Day high", "Upside breakout+Reversal-down", "SPOT", "Immediate support", "Downside breakdown"]);
  assert.equal(seq[1].distance, 136.7); assert.equal(seq[1].side, "resistance"); assert.equal(seq[3].side, "support");
  assert.equal(levelSequence([L("x", 1)], null).length, 1);
});
