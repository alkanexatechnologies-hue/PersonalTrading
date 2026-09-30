import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOiSummary } from "./summary";
import { OiAnalysis } from "../../types";

function chain(over: Partial<OiAnalysis> = {}): OiAnalysis {
  return {
    symbol: "NIFTY", nseSymbol: "NIFTY", available: true, underlying: 22000,
    expiry: "2026-10-08", pcr: 1.3, pcrState: "bullish",
    totalCeOi: 4_000_000, totalPeOi: 6_000_000, support: 21800, resistance: 22200,
    maxPain: 22000, ceBuildup: "short covering", peBuildup: "short buildup",
    verdict: { bias: "Bullish", reasons: [] },
    topStrikes: [
      { strike: 21800, ceOi: 200000, peOi: 900000, ceChg: 0, peChg: 0 },
      { strike: 22000, ceOi: 500000, peOi: 500000, ceChg: 0, peChg: 0 },
      { strike: 22200, ceOi: 950000, peOi: 200000, ceChg: 0, peChg: 0 },
    ],
    asOf: Date.now(), disclaimer: "",
    ...over,
  } as OiAnalysis;
}

test("unavailable chain → summary reports DATA UNAVAILABLE", () => {
  const s = buildOiSummary("NIFTY", { available: false, message: "blocked" } as OiAnalysis, null);
  assert.equal(s.available, false);
  assert.equal(s.directionGuide, "DATA UNAVAILABLE");
});

test("put-heavy bullish chain yields Bullish bias with confidence and evidence", () => {
  const s = buildOiSummary("NIFTY", chain(), null);
  assert.equal(s.available, true);
  assert.equal(s.bias, "Bullish");
  assert.ok(s.confidencePct > 0);
  assert.ok(s.evidence.length >= 4);
  assert.equal(s.putWall?.strike, 21800);
  assert.equal(s.callWall?.strike, 22200);
});

test("walls map to support/resistance zones", () => {
  const s = buildOiSummary("NIFTY", chain(), null);
  assert.equal(s.supportZone, 21800);
  assert.equal(s.resistanceZone, 22200);
  assert.equal(s.scenarios.length, 2);
});

test("balanced chain → neutral, low confidence", () => {
  const s = buildOiSummary("NIFTY", chain({
    pcr: 1.0, pcrState: "neutral", totalCeOi: 5_000_000, totalPeOi: 5_000_000,
    ceBuildup: "mixed", peBuildup: "mixed",
  }), null);
  assert.equal(s.bias, "Neutral");
  assert.ok(s.confidencePct < 50);
});
