import { test } from "node:test";
import assert from "node:assert/strict";
import { Candle, OiAnalysis, OiStrike } from "../types";
import { runSession, constructPlan, Level, BREAKOUT_CONFIG, TradePlan } from "./breakoutEngine";
import { buildOptionPlan } from "./breakoutOption";
import { session, setBar, Leg } from "./breakoutFixtures";

// Ascending triangle under ~22101 (flat top, rising lows) above a prior session
// whose levels sit well below — the base for the bullish scenarios. Bearish
// scenarios are the exact mirror image, so the two sides are tested symmetrically.
const LEGS: Leg[] = [
  { to: 22090, bars: 6 }, { to: 22080, bars: 3 }, { to: 22100, bars: 5 }, { to: 22085, bars: 4 }, { to: 22100, bars: 4 },
  { to: 22090, bars: 3 }, { to: 22100, bars: 3 }, { to: 22094, bars: 3 }, { to: 22098, bars: 2 }, { to: 22098, bars: 1 },
];
const base = (prevMid = 22060, prevBand = 42) => session(prevMid, prevBand, 22070, LEGS);
const lastBar = (cs: Candle[], o: number, h: number, l: number, c: number, vol?: number) => { setBar(cs, cs.length - 1, o, h, l, c, vol); return cs; };
const BREAK = (cs: Candle[]) => lastBar(cs, 22098, 22105, 22097.5, 22104.5);
const FALSE = (cs: Candle[]) => lastBar(cs, 22098, 22106, 22095, 22097);
const EXTEND = (cs: Candle[]) => lastBar(cs, 22098, 22125, 22097.5, 22124);
const K = 44200;
const mirror = (cs: Candle[]): Candle[] => cs.map((x) => ({ time: x.time, open: K - x.open, high: K - x.low, low: K - x.high, close: K - x.close, volume: x.volume }));
const last = (cs: Candle[]) => { const r = runSession(cs, { intervalSec: 300 }); return { r, L: r.rows[r.rows.length - 1] }; };

// ---------------- 1–4: bullish ----------------
test("1. bullish trend, resistance just above → WAIT FOR BREAKOUT (no BUY on indicators alone)", () => {
  const { r, L } = last(base());
  assert.equal(L.bias.direction, "BULLISH");
  assert.equal(L.state, "WAIT FOR BREAKOUT");
  assert.equal(L.command, "WAIT");
  assert.ok(L.triggerLevel != null && L.triggerLevel > L.spot, "trigger is the resistance above price");
  assert.equal(r.signals.length, 0);
});

test("2. bullish trend + confirmed resistance breakout → BUY with full plan", () => {
  const { r, L } = last(BREAK(base()));
  assert.equal(L.state, "BUY");
  assert.equal(L.confirmation, "PASS");
  assert.equal(L.breakoutStatus, "BROKEN");
  const p = L.plan!;
  assert.equal(p.triggerType, "RESISTANCE BREAKOUT");
  assert.ok(p.entry > p.trigger && p.stopLoss < p.trigger, "entry above the broken level, SL back inside it");
  assert.ok(p.target1 > p.entry);
  assert.ok(p.rr >= BREAKOUT_CONFIG.rrMin);
  assert.ok(p.slReason.length > 0 && p.targetReason.length > 0, "SL and target reasons recorded");
  assert.equal(r.signals.length, 1);
});

test("3. bullish trend + false breakout (wick above, close back below) → no BUY, FALSE BREAK", () => {
  const { r, L } = last(FALSE(base()));
  assert.equal(L.breakoutStatus, "FALSE BREAK");
  assert.equal(L.state, "WAIT FOR BREAKOUT");
  assert.match(L.reason, /closed back below/);
  assert.equal(r.signals.length, 0);
});

test("4. bullish trend + extended breakout → WAIT FOR PULLBACK (do not chase)", () => {
  const { r, L } = last(EXTEND(base()));
  assert.equal(L.confirmation, "PASS");
  assert.equal(L.extension, "EXTENDED");
  assert.equal(L.state, "WAIT FOR PULLBACK");
  assert.match(L.rejectionReason!, /already extended/);
  assert.equal(r.signals.length, 0);
});

test("breakout on weak participation is not confirmed", () => {
  const { L } = last(lastBar(base(), 22098, 22105, 22097.5, 22104.5, 300));
  assert.equal(L.confirmation, "FAIL");
  assert.match(L.confirmationDetail!, /weak participation/);
  assert.notEqual(L.state, "BUY");
});

// ---------------- 5–7: bearish (mirror) ----------------
test("5. bearish trend, support just below → WAIT FOR SUPPORT BREAK", () => {
  const { L } = last(mirror(base()));
  assert.equal(L.bias.direction, "BEARISH");
  assert.equal(L.state, "WAIT FOR SUPPORT BREAK");
  assert.ok(L.triggerLevel != null && L.triggerLevel < L.spot);
});

test("6. bearish trend + confirmed support breakdown → SELL with full plan", () => {
  const { r, L } = last(mirror(BREAK(base())));
  assert.equal(L.state, "SELL");
  const p = L.plan!;
  assert.equal(p.triggerType, "SUPPORT BREAKDOWN");
  assert.ok(p.entry < p.trigger && p.stopLoss > p.trigger && p.target1 < p.entry);
  assert.ok(p.rr >= BREAKOUT_CONFIG.rrMin);
  assert.equal(r.signals[0].dir, "SELL");
});

test("7. bearish trend + false breakdown → no SELL", () => {
  const { r, L } = last(mirror(FALSE(base())));
  assert.equal(L.breakoutStatus, "FALSE BREAK");
  assert.equal(r.signals.length, 0);
});

// ---------------- 8: range ----------------
test("8. range market → mostly NO EDGE, no trades", () => {
  const flat: Leg[] = [];
  for (let k = 0; k < 15; k++) flat.push({ to: 22000 + (k % 2 ? 8 : -8), bars: 5 });
  const r = runSession(session(22000, 8, 22000, flat), { intervalSec: 300 });
  const noEdge = r.rows.filter((x) => x.state === "NO EDGE").length;
  assert.ok(noEdge > r.rows.length / 3, `NO EDGE ${noEdge}/${r.rows.length}`);
  assert.equal(r.signals.length, 0);
});

// ---------------- 9–11: trade construction ----------------
const lvl = (price: number, kinds: string[], major = false): Level => ({ price, kinds, label: kinds.join("/"), major, touches: 1 });
const candle = (o: number, h: number, l: number, c: number): Candle => ({ time: 0, open: o, high: h, low: l, close: c, volume: 1 });

test("9. strong trend with large target room → target beyond the obstacle, R:R passes", () => {
  // ATR 2; minor swing 101 inside 1 ATR is an OBSTACLE, not the target; PDH 108 is the target.
  const lv = [lvl(97, ["Swing Low"]), lvl(99, ["Swing High"]), lvl(101, ["Swing High"]), lvl(108, ["PDH"], true), lvl(112, ["R1 Pivot"], true)];
  const { plan, block } = constructPlan("BUY", 100, lv[1], "RESISTANCE BREAKOUT", candle(99, 100.2, 98.8, 100), lv, 2);
  assert.equal(block, null);
  assert.equal(plan!.stopLoss, 96.5);                 // protected swing low 97 − 0.25 ATR
  assert.match(plan!.slReason, /Protected swing low 97/);
  assert.equal(plan!.target1, 108);                   // not the nearest level (101)
  assert.equal(plan!.target2, 112);
  assert.deepEqual(plan!.obstacles.map((o) => o.price), [101]);
  // Part 6 maths: risk = entry − SL, reward = target − entry, R:R = reward / risk
  assert.equal(plan!.risk, 3.5); assert.equal(plan!.reward, 8); assert.equal(plan!.rr, 2.29);
});

test("10. strong trend but MAJOR level right overhead → blocked: immediate resistance too close", () => {
  const lv = [lvl(97, ["Swing Low"]), lvl(99, ["Swing High"]), lvl(101, ["PDH"], true), lvl(108, ["R1 Pivot"], true)];
  const { block } = constructPlan("BUY", 100, lv[1], "RESISTANCE BREAKOUT", candle(99, 100.2, 98.8, 100), lv, 2);
  assert.match(block!, /Immediate resistance too close — PDH 101/);
});

test("10b. R:R below minimum is explained — insufficient target room", () => {
  // ATR 3: stop 96.25 (1.25 ATR — not wide), next target 104 only 4 pts away.
  const lv = [lvl(97, ["Swing Low"]), lvl(99, ["Swing High"]), lvl(104, ["Swing High"])];
  const { block, plan } = constructPlan("BUY", 100, lv[1], "RESISTANCE BREAKOUT", candle(99, 100.2, 98.8, 100), lv, 3);
  assert.equal(plan!.rr, 1.07);
  assert.match(block!, /below 1:2\.00 — Insufficient target room/);
});

test("10c. R:R failure from a late entry is classified as poor entry location", () => {
  const lv = [lvl(96, ["Swing High"]), lvl(103, ["Swing High"])];
  const { block } = constructPlan("BUY", 100, lv[0], "RESISTANCE BREAKOUT", candle(96.5, 100.2, 96.2, 100), lv, 3);
  assert.match(block!, /Poor entry location/);
});

test("11. wide structural SL → blocked with the ATR distance", () => {
  const lv = [lvl(85, ["Swing Low"]), lvl(98, ["Swing High"]), lvl(120, ["PDH"], true)];
  const { plan, block } = constructPlan("BUY", 100, lv[1], "RESISTANCE BREAKOUT", candle(91, 100.5, 90, 100), lv, 2);
  assert.equal(plan, null);
  assert.match(block!, /Structural SL too wide/);
});

test("SELL construction mirrors BUY (SL above, target below)", () => {
  const lv = [lvl(92, ["PDL"], true), lvl(99, ["Swing Low"]), lvl(101, ["Swing Low"]), lvl(103, ["Swing High"])];
  const { plan, block } = constructPlan("SELL", 100, lv[2], "SUPPORT BREAKDOWN", candle(101, 101.2, 99.8, 100), lv, 2);
  assert.equal(block, null);
  assert.equal(plan!.stopLoss, 103.5);
  assert.equal(plan!.target1, 92);
  assert.equal(plan!.risk, 3.5); assert.equal(plan!.reward, 8);
});

// ---------------- no look-ahead ----------------
test("no look-ahead: a bar's decision is identical whether or not later candles exist", () => {
  const full = BREAK(base());
  const tail = [22106, 22110, 22095, 22090, 22120];
  let t = full[full.length - 1].time;
  for (const c of tail) { t += 300; full.push({ time: t, open: c - 2, high: c + 3, low: c - 4, close: c, volume: 1000 }); }
  const withFuture = runSession(full, { intervalSec: 300 });
  for (let cut = full.length - tail.length - 6; cut <= full.length - tail.length; cut++) {
    const truncated = runSession(full.slice(0, cut), { intervalSec: 300 });
    const a = truncated.rows[truncated.rows.length - 1];
    const b = withFuture.rows.find((x) => x.time === a.time)!;
    assert.equal(b.state, a.state, `state at ${a.iso}`);
    assert.deepEqual(b.plan, a.plan, `plan at ${a.iso}`);
    assert.equal(b.triggerLevel, a.triggerLevel);
  }
});

test("live: a still-forming last candle is never evaluated", () => {
  const cs = BREAK(base());
  const lastT = cs[cs.length - 1].time;
  const r = runSession(cs, { intervalSec: 300, nowSec: lastT + 120 });   // 2 min into the bar
  assert.notEqual(r.latest!.time, lastT);
  assert.equal(r.signals.length, 0);
});

test("data issue → AVOID with the reason (never a stale signal)", () => {
  const r = runSession(BREAK(base()), { intervalSec: 300, dataIssue: "STALE DATA — last candle 4 min old" });
  assert.equal(r.latest!.state, "AVOID");
  assert.equal(r.signals.length, 0);
});

// ---------------- 12–17: option strike selection ----------------
function chain(name: string, spot: number, step: number, n = 6): OiAnalysis {
  const atm = Math.round(spot / step) * step;
  const strikes: OiStrike[] = [];
  for (let k = -n; k <= n; k++) {
    const K = atm + k * step;
    const m = (spot - K) / step;                         // + = CE ITM
    const ceD = Math.min(0.95, Math.max(0.05, 0.5 + m * 0.12)), peD = -(1 - ceD);
    strikes.push({
      strike: K, ceOi: 100000 - Math.abs(k) * 6000, peOi: 100000 - Math.abs(k) * 6000, ceChg: 1000, peChg: 1000,
      ceLtp: Math.max(1, +(Math.max(0, spot - K) + step * 1.2 * ceD).toFixed(2)), peLtp: Math.max(1, +(Math.max(0, K - spot) + step * 1.2 * -peD).toFixed(2)),
      ceVol: 50000 - Math.abs(k) * 3000, peVol: 50000 - Math.abs(k) * 3000, ceDelta: +ceD.toFixed(2), peDelta: +peD.toFixed(2), ceIv: 14, peIv: 15,
    });
  }
  return { symbol: name, nseSymbol: name, available: true, underlying: spot, expiry: "2026-10-13", pcr: 1, pcrState: "neutral", totalCeOi: 0, totalPeOi: 0, support: null, resistance: null, maxPain: null, ceBuildup: "mixed", peBuildup: "mixed", topStrikes: strikes } as unknown as OiAnalysis;
}
const planFor = (dir: "BUY" | "SELL", spot: number, atrPts: number): TradePlan => ({
  dir, entry: spot, stopLoss: dir === "BUY" ? spot - atrPts : spot + atrPts, target1: dir === "BUY" ? spot + 2.5 * atrPts : spot - 2.5 * atrPts,
  target2: dir === "BUY" ? spot + 4 * atrPts : spot - 4 * atrPts, risk: atrPts, reward: 2.5 * atrPts, rr: 2.5,
  slReason: "test", targetReason: "test", target2Reason: "test", trigger: spot, triggerLabel: "test", triggerType: dir === "BUY" ? "RESISTANCE BREAKOUT" : "SUPPORT BREAKDOWN", obstacles: [],
});

for (const [name, spot, step, atrPts] of [["NIFTY", 22803, 50, 20], ["BANKNIFTY", 55128, 100, 60], ["FINNIFTY", 24946, 50, 25], ["SENSEX", 73067, 100, 70]] as const) {
  for (const dir of ["BUY", "SELL"] as const) {
    test(`${name} ${dir}: strike picked from the live chain grid (no hard-coded strike), full option plan`, () => {
      const oi = chain(name, spot, step);
      const op = buildOptionPlan(planFor(dir, spot, atrPts), oi, { name, securityId: "12345" });
      assert.equal(op.side, dir === "BUY" ? "CE" : "PE");
      assert.ok(op.available, op.reason ?? "");
      assert.ok(op.strike != null && op.strike % step === 0, "strike is on this index's grid");
      // the existing analyser compares ATM ±1 plus one deeper ITM strike on the traded side
      assert.ok(Math.abs(op.strike! - spot) <= 2.5 * step, "near the money");
      assert.ok(op.candidates.length >= 3, "multiple candidate strikes evaluated");
      assert.equal(op.expiry, "2026-10-13");
      assert.ok(op.entry! > 0 && op.stopLoss! < op.entry! && op.target1! > op.entry!, "premium SL below / target above entry (option is bought)");
      assert.ok(op.target2! > op.target1!);
      assert.ok(Math.abs(op.rr! - op.reward! / op.risk!) < 0.01, "R:R = reward / risk");
      assert.ok(op.passesRR);
      assert.equal(op.identity!.verified, true);
    });
  }
}

test("option plan never invents data: no chain → unavailable with reason", () => {
  const op = buildOptionPlan(planFor("BUY", 22800, 20), null, { name: "NIFTY" });
  assert.equal(op.available, false);
  assert.equal(op.entry, null);
  assert.ok(op.reason);
});

test("option plan: missing Security ID → identity not verified, reason given", () => {
  const op = buildOptionPlan(planFor("BUY", 22803, 20), chain("NIFTY", 22803, 50), { name: "NIFTY", securityId: null });
  assert.equal(op.identity!.verified, false);
  assert.match(op.reason!, /Security ID/);
});
