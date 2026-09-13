import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyOiInterpretation, interpretOi } from "./oiInterpretation";
import { OiChangeResult } from "../oi/oiChange";
import { OiAnalysis } from "../types";

function fakeOc(overrides: Partial<OiChangeResult> = {}): OiChangeResult {
  const leg = (bullish: boolean | null) => ({
    type: "CE" as const, moneyness: "ATM" as const, oi: 100000, oiChg: 1000, oiChgPct: 5,
    ltp: 50, ltpChg: 1, ltpChgPct: 2, vol: 1000, action: "Call writing ↑", bullish,
  });
  return {
    symbol: "RELIANCE", name: "Reliance Industries", type: "equity",
    underlying: 2400, atmStrike: 2400, expiry: "2026-09-25",
    baselineSpot: 2380, spotChg: 20, spotChgPct: 0.84,
    levels: [{ strike: 2400, ce: leg(false), pe: { ...leg(null), type: "PE", action: "Put writing ↑" } }],
    chain: [], best: null,
    maxCeBuildup: { strike: 2500, side: "CE", oiChg: 50000, oiChgPct: 40, veryHigh: false, label: "Call writing at 2500" },
    maxPeBuildup: { strike: 2300, side: "PE", oiChg: 60000, oiChgPct: 45, veryHigh: false, label: "Put writing at 2300" },
    netCeChg: -1000, netPeChg: 5000,
    bias: "Bullish", note: "Put writing dominates", moveRead: "-",
    oiDirScore: 30, oiVerdict: "Bullish", oiConfidence: 65, oiReasons: ["Put buildup exceeds call buildup"],
    major: false, majorReason: null,
    hasBaseline: true, baselineNote: "-",
    asOf: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function fakeOi(overrides: Partial<OiAnalysis> = {}): OiAnalysis {
  return {
    symbol: "RELIANCE", nseSymbol: "RELIANCE", available: true,
    underlying: 2400, expiry: "2026-09-25",
    pcr: 1.3, pcrState: "bullish",
    totalCeOi: 1000000, totalPeOi: 1300000,
    support: 2300, resistance: 2500, maxPain: 2400,
    ceBuildup: "short buildup", peBuildup: "long buildup",
    verdict: { bias: "Bullish", reasons: [] },
    topStrikes: [],
    asOf: Math.floor(Date.now() / 1000),
    disclaimer: "-",
    ...overrides,
  };
}

test("interpretOi: reads walls, ATM action and PCR from a healthy OI-change result", () => {
  const r = interpretOi(fakeOc(), fakeOi(), 2400);
  assert.equal(r.callResistanceWall?.strike, 2500);
  assert.equal(r.putSupportWall?.strike, 2300);
  assert.equal(r.atmAction.ce, "Call writing");
  assert.equal(r.atmAction.pe, "Put writing");
  assert.equal(r.oiVerdict, "Bullish");
  assert.equal(r.hasBaseline, true);
  assert.equal(r.pcrState, "bullish");
});

test("interpretOi: a null OI-change result (e.g. stale chain) never fabricates a verdict from nothing", () => {
  const r = interpretOi(null, fakeOi({ verdict: { bias: "Neutral", reasons: [] } }), 2400);
  assert.equal(r.hasBaseline, false);
  assert.equal(r.oiConfidence, 0);
  assert.ok(r.oiReasons[0].toLowerCase().includes("baseline"));
});

test("emptyOiInterpretation: a stock with no F&O chain degrades to a neutral, zero-confidence read", () => {
  const r = emptyOiInterpretation();
  assert.equal(r.oiVerdict, "Neutral");
  assert.equal(r.oiConfidence, 0);
  assert.equal(r.hasBaseline, false);
});
