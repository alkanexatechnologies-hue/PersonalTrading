// Phase 1.2 (OIAnalysisEngine) coverage: computeOiChange's ±100 oiDirScore/oiVerdict
// is now the ONE OI bias number direction4L.ts and dayOutlook.ts read (previously
// they read oi.ts/growwProvider.ts's ±1-ish verdict.bias instead). This test
// exercises the always-available factors (PCR + futures buildup) that apply even
// before a same-day baseline exists, since those are what a fresh OiAnalysis has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOiChange, classifyOiVerdict } from "./oiChange";
import { OiAnalysis, OiStrike } from "../types";
import { seedBaselineForTest, clearBaselineForTest } from "./baselineStore";
import { istDateStr } from "../util/istTime";

function strikes(): OiStrike[] {
  return [
    { strike: 24800, ceOi: 1000, peOi: 1000, ceChg: 0, peChg: 0 },
    { strike: 25000, ceOi: 1000, peOi: 1000, ceChg: 0, peChg: 0 },
    { strike: 25200, ceOi: 1000, peOi: 1000, ceChg: 0, peChg: 0 },
  ];
}

function baseOi(overrides: Partial<OiAnalysis> = {}): OiAnalysis {
  return {
    symbol: "NIFTY", nseSymbol: "NIFTY", available: true,
    underlying: 25000, expiry: "2026-09-25",
    pcr: 1.0, pcrState: "neutral",
    totalCeOi: 3000, totalPeOi: 3000,
    support: 24800, resistance: 25200, maxPain: 25000,
    ceBuildup: "mixed", peBuildup: "mixed",
    futOi: null, futOiChangePct: null, futBuildup: null,
    verdict: { bias: "Neutral", reasons: [] },
    topStrikes: strikes(),
    asOf: Math.floor(Date.now() / 1000),
    disclaimer: "",
    ...overrides,
  };
}

test("computeOiChange: returns null when OI is unavailable", () => {
  assert.equal(computeOiChange("NIFTY", "NIFTY", "index", null), null);
  assert.equal(computeOiChange("NIFTY", "NIFTY", "index", baseOi({ available: false })), null);
});

test("computeOiChange: high PCR alone tilts oiDirScore bullish (no baseline yet)", () => {
  const oc = computeOiChange("NIFTY", "NIFTY", "index", baseOi({ pcr: 1.3 }));
  assert.ok(oc);
  assert.ok(oc!.oiDirScore > 0, `expected positive oiDirScore, got ${oc!.oiDirScore}`);
  assert.equal(oc!.oiVerdict, "Neutral"); // PCR alone (+15) is below the ±20 verdict threshold
});

test("computeOiChange: low PCR alone tilts oiDirScore bearish", () => {
  const oc = computeOiChange("NIFTY", "NIFTY", "index", baseOi({ pcr: 0.6 }));
  assert.ok(oc);
  assert.ok(oc!.oiDirScore < 0, `expected negative oiDirScore, got ${oc!.oiDirScore}`);
});

test("computeOiChange: PCR + futures long-buildup agree and cross the Bullish verdict threshold", () => {
  const oc = computeOiChange("NIFTY", "NIFTY", "index", baseOi({ pcr: 1.3, futBuildup: "Long buildup" }));
  assert.ok(oc);
  assert.equal(oc!.oiVerdict, "Bullish");
  assert.ok(oc!.oiDirScore >= 20);
});

test("computeOiChange: PCR + futures short-buildup agree and cross the Bearish verdict threshold", () => {
  const oc = computeOiChange("NIFTY", "NIFTY", "index", baseOi({ pcr: 0.6, futBuildup: "Short buildup" }));
  assert.ok(oc);
  assert.equal(oc!.oiVerdict, "Bearish");
  assert.ok(oc!.oiDirScore <= -20);
});

test("computeOiChange: neutral PCR and no futures data stays Neutral", () => {
  const oc = computeOiChange("NIFTY", "NIFTY", "index", baseOi({ pcr: 1.0, futBuildup: null }));
  assert.ok(oc);
  assert.equal(oc!.oiVerdict, "Neutral");
  assert.equal(oc!.oiDirScore, 0);
});

// classifyOiVerdict: pure function, the TWO_SIDED decision in isolation.
test("classifyOiVerdict: Bullish/Bearish bands win regardless of bothHeavyWriting", () => {
  assert.equal(classifyOiVerdict(25, true), "Bullish");
  assert.equal(classifyOiVerdict(-25, true), "Bearish");
});
test("classifyOiVerdict: TWO_SIDED only replaces Neutral, never Bullish/Bearish", () => {
  assert.equal(classifyOiVerdict(0, true), "TWO_SIDED");
  assert.equal(classifyOiVerdict(0, false), "Neutral");
  assert.equal(classifyOiVerdict(19, true), "TWO_SIDED"); // inside the ±20 band
});

// End-to-end: simultaneous heavy CE + PE writing must surface as TWO_SIDED, not
// collapse into the same Neutral a quiet/inactive day would show.
test("computeOiChange: simultaneous heavy CE + PE writing surfaces TWO_SIDED, not Neutral", () => {
  const symbol = "NIFTY_TWOSIDED_TEST";
  clearBaselineForTest(symbol);
  seedBaselineForTest(symbol, {
    date: istDateStr(),
    underlying: 25000,
    strikes: new Map([
      [24800, { ceOi: 1000, peOi: 1000, ceLtp: 100, peLtp: 100 }],
      [25000, { ceOi: 1000, peOi: 1000, ceLtp: 100, peLtp: 100 }],
      [25200, { ceOi: 1000, peOi: 1000, ceLtp: 100, peLtp: 100 }],
    ]),
  });
  const oi = baseOi({
    pcr: 1.0, futBuildup: null, support: null, resistance: null,
    topStrikes: [
      { strike: 24800, ceOi: 2000, peOi: 1000, ceChg: 0, peChg: 0 }, // CE doubled here (heavy call writing)
      { strike: 25000, ceOi: 1000, peOi: 1000, ceChg: 0, peChg: 0 },
      { strike: 25200, ceOi: 1000, peOi: 2000, ceChg: 0, peChg: 0 }, // PE doubled here (heavy put writing)
    ],
  });
  const oc = computeOiChange(symbol, "NIFTY", "index", oi);
  assert.ok(oc);
  assert.ok(oc!.maxCeBuildup?.veryHigh, "expected CE buildup to be flagged veryHigh");
  assert.ok(oc!.maxPeBuildup?.veryHigh, "expected PE buildup to be flagged veryHigh");
  assert.equal(oc!.oiVerdict, "TWO_SIDED");
  assert.ok(oc!.oiReasons.some((r) => r.includes("TWO_SIDED")));
  clearBaselineForTest(symbol);
});
