import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateOrb, computeOrbLevels, OrbInputs, DEFAULT_ORB_CONFIG } from "./orbStrategy";
import type { OrbRange, OrbBreakoutSignal } from "../orb/OpeningRangeBreakoutEngine";

const range: OrbRange = { high: 22800, low: 22750, formed: true, barsSeen: 3 };
const upBreak: OrbBreakoutSignal = { optionType: "CE", breakoutClose: 22815, breakoutEpochSec: 1000, rangeHigh: 22800, rangeLow: 22750, breakoutVolume: 3000, volumeSma20: 1500, volumeConfirmed: true, note: "" };
const dnBreak: OrbBreakoutSignal = { optionType: "PE", breakoutClose: 22735, breakoutEpochSec: 1000, rangeHigh: 22800, rangeLow: 22750, breakoutVolume: 3000, volumeSma20: 1500, volumeConfirmed: true, note: "" };

// A fully-confirmed bullish setup within the entry window.
const goodCE: OrbInputs = {
  nowMin: 10 * 60, range, breakout: upBreak, falseBreakout: false,
  price: 22815, vwap: 22790, ema9: 22800, ema21: 22780, structureDirection: "BULLISH",
  oiSupportsDirection: true, opposingLevel: 22950, optionLiquidityOk: true,
  masterMinRR: 2, riskOk: true, existingPosition: false,
};

test("no opening range → WAIT / NO_OPENING_RANGE", () => {
  const e = evaluateOrb({ ...goodCE, range: null });
  assert.equal(e.status, "WAIT"); assert.equal(e.final, "WAIT");
  assert.deepEqual(e.reasons, ["NO_OPENING_RANGE"]);
});

test("range formed but no breakout → WAIT / NO_BREAKOUT", () => {
  const e = evaluateOrb({ ...goodCE, breakout: null });
  assert.equal(e.status, "WAIT"); assert.deepEqual(e.reasons, ["NO_BREAKOUT"]);
});

test("fully confirmed bullish → TAKE CE", () => {
  const e = evaluateOrb(goodCE);
  assert.equal(e.status, "TAKE"); assert.equal(e.final, "TAKE CE"); assert.equal(e.direction, "BULLISH");
  assert.equal(e.gates.vwap, "PASS"); assert.equal(e.gates.ema, "PASS"); assert.equal(e.gates.master, "PASS");
  assert.deepEqual(e.reasons, []);
});

test("fully confirmed bearish → TAKE PE", () => {
  const e = evaluateOrb({ ...goodCE, breakout: dnBreak, price: 22735, vwap: 22760, ema9: 22740, ema21: 22770, structureDirection: "BEARISH", opposingLevel: 22600 });
  assert.equal(e.final, "TAKE PE"); assert.equal(e.direction, "BEARISH");
});

test("VWAP misaligned → INVALIDATED / VWAP_MISALIGNED", () => {
  const e = evaluateOrb({ ...goodCE, vwap: 22830 }); // price below vwap on a CE
  assert.equal(e.gates.vwap, "FAIL"); assert.ok(e.reasons.includes("VWAP_MISALIGNED"));
  assert.equal(e.status, "INVALIDATED");
});

test("EMA misaligned → EMA_MISALIGNED", () => {
  const e = evaluateOrb({ ...goodCE, ema9: 22770, ema21: 22800 });
  assert.equal(e.gates.ema, "FAIL"); assert.ok(e.reasons.includes("EMA_MISALIGNED"));
});

test("structure disagrees → STRUCTURE_MISALIGNED", () => {
  const e = evaluateOrb({ ...goodCE, structureDirection: "BEARISH" });
  assert.equal(e.gates.structure, "FAIL"); assert.ok(e.reasons.includes("STRUCTURE_MISALIGNED"));
});

test("insufficient room → INSUFFICIENT_ROOM", () => {
  const e = evaluateOrb({ ...goodCE, opposingLevel: 22820 }); // 5 pts room < 20
  assert.equal(e.gates.room, "FAIL"); assert.ok(e.reasons.includes("INSUFFICIENT_ROOM"));
});

test("false breakout → FALSE_BREAKOUT / NO EDGE, no auto-reverse", () => {
  const e = evaluateOrb({ ...goodCE, falseBreakout: true });
  assert.equal(e.status, "FALSE_BREAKOUT"); assert.equal(e.final, "NO EDGE");
  assert.deepEqual(e.reasons, ["FALSE_BREAKOUT"]);
});

test("after 11:30 → TIME_WINDOW_EXPIRED / WAIT", () => {
  const e = evaluateOrb({ ...goodCE, nowMin: 11 * 60 + 45 });
  assert.equal(e.status, "INVALIDATED"); assert.equal(e.final, "WAIT");
  assert.ok(e.reasons.includes("TIME_WINDOW_EXPIRED"));
});

test("existing position → EXISTING_POSITION blocks", () => {
  const e = evaluateOrb({ ...goodCE, existingPosition: true });
  assert.equal(e.gates.master, "FAIL"); assert.ok(e.reasons.includes("EXISTING_POSITION"));
});

test("R:R below master requirement → RR_FAILED (respects hard gate)", () => {
  const e = evaluateOrb({ ...goodCE, masterMinRR: 3 }); // ORB builds 1:2, master wants 1:3
  assert.ok(e.reasons.includes("RR_FAILED")); assert.notEqual(e.final, "TAKE CE");
});

test("risk engine rejects → RISK_FAILED", () => {
  const e = evaluateOrb({ ...goodCE, riskOk: false });
  assert.ok(e.reasons.includes("RISK_FAILED"));
});

test("missing engines are UNAVAILABLE, never invented, and do not block", () => {
  const e = evaluateOrb({ ...goodCE, structureDirection: null, oiSupportsDirection: null });
  assert.equal(e.gates.structure, "UNAVAILABLE"); assert.equal(e.gates.oi, "UNAVAILABLE");
  assert.equal(e.final, "TAKE CE"); // still takes — required (available) gates all pass
});

test("index with no volume → volume UNAVAILABLE (neutral, not a veto)", () => {
  const e = evaluateOrb({ ...goodCE, breakout: { ...upBreak, volumeSma20: 0, volumeConfirmed: false } });
  assert.equal(e.gates.volume, "UNAVAILABLE"); assert.equal(e.final, "TAKE CE");
});

test("OI conflict is supporting-only by default (recorded, does not block)", () => {
  const e = evaluateOrb({ ...goodCE, oiSupportsDirection: false });
  assert.ok(e.reasons.includes("OI_CONFLICT")); assert.equal(e.final, "TAKE CE"); // not a hard veto
});

test("OI conflict blocks when configured as a hard gate", () => {
  const e = evaluateOrb({ ...goodCE, oiSupportsDirection: false }, { oiHardGate: true });
  assert.equal(e.gates.oi, "FAIL"); assert.notEqual(e.final, "TAKE CE");
});

test("computeOrbLevels: CE stop at OR low, target 1:2", () => {
  const lv = computeOrbLevels(upBreak, range, DEFAULT_ORB_CONFIG);
  assert.equal(lv.entry, 22815); assert.equal(lv.sl, 22750); // opposite OR side
  const risk = 22815 - 22750;
  assert.equal(lv.target, 22815 + 2 * risk); assert.equal(lv.rr, 2);
});

test("computeOrbLevels: OR_MID stop mode", () => {
  const lv = computeOrbLevels(upBreak, range, { ...DEFAULT_ORB_CONFIG, slMode: "or_mid" });
  assert.equal(lv.sl, (22800 + 22750) / 2);
});

test("orHigh/orLow/orRange/orMid are locked from the range", () => {
  const e = evaluateOrb(goodCE);
  assert.equal(e.orHigh, 22800); assert.equal(e.orLow, 22750);
  assert.equal(e.orRange, 50); assert.equal(e.orMid, 22775);
});
