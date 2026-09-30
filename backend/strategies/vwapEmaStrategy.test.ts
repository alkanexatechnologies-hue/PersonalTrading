import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateVwapEma, deriveTrend, clusterDistance, vwapEmaConfigFor, VwapEmaInputs, InstrumentContext } from "./vwapEmaStrategy";

const nifty: InstrumentContext = { instrument: "^NSEI", name: "NIFTY 50", instrumentType: "index", strikeStep: 50, lotSize: 65 };
const sensex: InstrumentContext = { instrument: "^BSESN", name: "SENSEX", instrumentType: "index", strikeStep: 100, lotSize: 20 };

// A fully-confirmed bullish continuation within the 10:00–13:00 window.
const goodBull = (ctx: InstrumentContext, p = 22800, v = 22790, e = 22785, ep = 22780, sh = 22900, sl = 22770, opp = 22950): VwapEmaInputs => ({
  ctx, nowMin: 11 * 60, price: p, vwap: v, ema20: e, ema20Prev: ep, atr: 30,
  structureDirection: "BULLISH", reversalConfirmed: true, oiSupportsDirection: true,
  sessionHigh: sh, sessionLow: 22700, swingSL: sl, opposingLevel: opp,
  optionLiquidityOk: true, masterMinRR: 2, riskOk: true, existingPosition: false,
});

test("deriveTrend: price above VWAP/EMA with rising EMA → BULLISH", () => {
  assert.equal(deriveTrend(101, 100, 99, 98), "BULLISH");
  assert.equal(deriveTrend(97, 100, 99, 100), "BEARISH");
  assert.equal(deriveTrend(100, 100, 100, 100), "NEUTRAL");
});

test("clusterDistance = distance to the nearer of VWAP / EMA", () => {
  assert.equal(clusterDistance(110, 100, 105), 5);
});

test("outside the setup window → OUTSIDE_WINDOW", () => {
  const e = evaluateVwapEma({ ...goodBull(nifty), nowMin: 9 * 60 + 45 });
  assert.deepEqual(e.reasons, ["OUTSIDE_WINDOW"]); assert.equal(e.final, "WAIT");
});

test("no trend → NO_TREND", () => {
  // Price above EMA20 but below VWAP → neither clean-above nor clean-below → NEUTRAL.
  const e = evaluateVwapEma({ ...goodBull(nifty), price: 22789, vwap: 22790, ema20: 22788, ema20Prev: 22788 });
  assert.equal(e.gates.trend, "FAIL"); assert.deepEqual(e.reasons, ["NO_TREND"]);
});

test("fully confirmed bullish → TAKE CE", () => {
  const e = evaluateVwapEma(goodBull(nifty));
  assert.equal(e.final, "TAKE CE"); assert.equal(e.direction, "BULLISH");
  assert.equal(e.gates.trend, "PASS"); assert.equal(e.gates.pullback, "PASS"); assert.equal(e.gates.reversal, "PASS"); assert.equal(e.gates.master, "PASS");
});

test("fully confirmed bearish → TAKE PE", () => {
  const e = evaluateVwapEma({ ...goodBull(nifty), price: 22700, vwap: 22712, ema20: 22715, ema20Prev: 22725, structureDirection: "BEARISH", sessionLow: 22600, sessionHigh: 22800, swingSL: 22730, opposingLevel: 22550 });
  assert.equal(e.direction, "BEARISH"); assert.equal(e.final, "TAKE PE");
});

test("no pullback (price far from cluster) → NO_PULLBACK", () => {
  const e = evaluateVwapEma({ ...goodBull(nifty), price: 22860 }); // 70+ pts from cluster, > 0.75*ATR(30)=22.5
  assert.equal(e.gates.pullback, "FAIL"); assert.ok(e.reasons.includes("NO_PULLBACK"));
});

test("no reversal candle → NO_REVERSAL", () => {
  const e = evaluateVwapEma({ ...goodBull(nifty), reversalConfirmed: false });
  assert.equal(e.gates.reversal, "FAIL"); assert.ok(e.reasons.includes("NO_REVERSAL"));
});

test("structure disagrees → STRUCTURE_MISALIGNED", () => {
  const e = evaluateVwapEma({ ...goodBull(nifty), structureDirection: "BEARISH" });
  assert.ok(e.reasons.includes("STRUCTURE_MISALIGNED"));
});

test("R:R below master requirement → RR_FAILED", () => {
  const e = evaluateVwapEma({ ...goodBull(nifty), masterMinRR: 5 });
  assert.ok(e.reasons.includes("RR_FAILED")); assert.notEqual(e.final, "TAKE CE");
});

test("existing position blocks", () => {
  const e = evaluateVwapEma({ ...goodBull(nifty), existingPosition: true });
  assert.equal(e.gates.master, "FAIL"); assert.ok(e.reasons.includes("EXISTING_POSITION"));
});

test("missing engines are UNAVAILABLE and don't block", () => {
  const e = evaluateVwapEma({ ...goodBull(nifty), structureDirection: null, oiSupportsDirection: null });
  assert.equal(e.gates.structure, "UNAVAILABLE"); assert.equal(e.gates.oi, "UNAVAILABLE"); assert.equal(e.final, "TAKE CE");
});

test("GENERIC: identical logic yields TAKE CE for a DIFFERENT index (SENSEX)", () => {
  // Same shape of setup, different instrument + price scale → same decision.
  const e = evaluateVwapEma(goodBull(sensex, 72970, 72960, 72950, 72900, 73400, 72900, 73600));
  assert.equal(e.instrument, "^BSESN");
  assert.equal(e.final, "TAKE CE");
});

test("config is generic by default and instrument-overridable", () => {
  const c = vwapEmaConfigFor("^NSEI");
  assert.equal(c.emaPeriod, 20); assert.equal(c.setupStartMin, 600); assert.equal(c.setupEndMin, 780);
  assert.equal(c.timeframe, "5m");
});
