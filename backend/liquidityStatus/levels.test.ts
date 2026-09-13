import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKeyLevels } from "./levels";
import { OiAnalysis } from "../types";
import { OiChangeResult } from "../oi/oiChange";

function fakeOi(): OiAnalysis {
  return {
    symbol: "^NSEI", nseSymbol: "NIFTY", available: true, underlying: 25124, expiry: "2026-09-25",
    pcr: 1.2, pcrState: "bullish", totalCeOi: 1, totalPeOi: 1, support: 25000, resistance: 25200, maxPain: 25100,
    ceBuildup: "short buildup", peBuildup: "long buildup", verdict: { bias: "Bullish", reasons: [] },
    topStrikes: [], asOf: Math.floor(Date.now() / 1000), disclaimer: "-",
  };
}
function leg(oi: number, oiChg: number) { return { type: "CE" as const, moneyness: "OTM" as const, oi, oiChg, oiChgPct: 0, ltp: 1, ltpChg: 0, ltpChgPct: 0, vol: 0, action: "-", bullish: null }; }
function fakeOc(): OiChangeResult {
  return {
    symbol: "^NSEI", name: "NIFTY 50", type: "index", underlying: 25124, atmStrike: 25100, expiry: "2026-09-25",
    baselineSpot: 25000, spotChg: 124, spotChgPct: 0.5,
    levels: [], chain: [
      { strike: 25000, ce: leg(1000, 10), pe: leg(180000, 20000) },
      { strike: 24900, ce: leg(500, 5), pe: leg(90000, 8000) },
      { strike: 25200, ce: leg(120000, -8000), pe: leg(3000, 200) },
      { strike: 25300, ce: leg(60000, -2000), pe: leg(1000, 50) },
    ],
    best: null, maxCeBuildup: null, maxPeBuildup: null, netCeChg: 0, netPeChg: 0,
    bias: "Bullish", note: "-", moveRead: "-", oiDirScore: 30, oiVerdict: "Bullish", oiConfidence: 60, oiReasons: [],
    major: false, majorReason: null, hasBaseline: true, baselineNote: "-", asOf: Math.floor(Date.now() / 1000),
  };
}

test("buildKeyLevels: reads key support/resistance from OiAnalysis, with strength from the SAME strike's own OI-change", () => {
  const levels = buildKeyLevels(fakeOi(), fakeOc(), 25124, 24900, 25300);
  const support = levels.find((l) => l.label === "KEY SUPPORT")!;
  const resistance = levels.find((l) => l.label === "KEY RESISTANCE")!;
  assert.equal(support.price, 25000);
  assert.equal(support.strength, "STRONG"); // put OI at 25000 is increasing
  assert.equal(resistance.price, 25200);
  assert.equal(resistance.strength, "WEAKENING"); // call OI at 25200 is decreasing
});

test("buildKeyLevels: distance is signed correctly (support below spot, resistance above)", () => {
  const levels = buildKeyLevels(fakeOi(), fakeOc(), 25124, 24900, 25300);
  const support = levels.find((l) => l.label === "KEY SUPPORT")!;
  const resistance = levels.find((l) => l.label === "KEY RESISTANCE")!;
  assert.equal(support.distancePts, 124);
  assert.equal(resistance.distancePts, 76);
});

test("buildKeyLevels: falls back to PDH/PDL when OI support/resistance are unavailable", () => {
  const oi = fakeOi(); oi.support = null; oi.resistance = null;
  const levels = buildKeyLevels(oi, null, 25124, 24800, 25400);
  assert.equal(levels.find((l) => l.label === "KEY SUPPORT")!.price, 24800);
  assert.equal(levels.find((l) => l.label === "KEY RESISTANCE")!.price, 25400);
});
