import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfirmationChecklist, buildEarlyWarnings, detectConflict } from "./checklist";
import { OiChangeResult } from "../oi/oiChange";

function fakeOc(oiVerdict: OiChangeResult["oiVerdict"], hasBaseline = true): OiChangeResult {
  return {
    symbol: "^NSEI", name: "NIFTY 50", type: "index", underlying: 25124, atmStrike: 25100, expiry: "2026-09-25",
    baselineSpot: 25000, spotChg: 124, spotChgPct: 0.5, levels: [], chain: [], best: null,
    maxCeBuildup: null, maxPeBuildup: null, netCeChg: 0, netPeChg: 0,
    bias: "Neutral", note: "-", moveRead: "-", oiDirScore: 0, oiVerdict, oiConfidence: 60, oiReasons: [],
    major: false, majorReason: null, hasBaseline, baselineNote: "-", asOf: Math.floor(Date.now() / 1000),
  };
}

// G. OI/price conflict
test("detectConflict: price up but OI bearish is a genuine conflict, forcing WAIT downstream", () => {
  const r = detectConflict("up", fakeOc("Bearish"));
  assert.equal(r.conflict, true);
  assert.ok(r.reason?.toLowerCase().includes("not confirmed"));
});
test("detectConflict: price down but OI bullish is a genuine conflict", () => {
  const r = detectConflict("down", fakeOc("Bullish"));
  assert.equal(r.conflict, true);
});
test("detectConflict: price and OI agreeing is NOT a conflict", () => {
  const r = detectConflict("up", fakeOc("Bullish"));
  assert.equal(r.conflict, false);
});
test("detectConflict: no baseline yet -> never fabricate a conflict from nothing", () => {
  const r = detectConflict("up", fakeOc("Bearish", false));
  assert.equal(r.conflict, false);
});

test("buildConfirmationChecklist: no direction -> a single honest 'not confirmed' item, no fabricated checks", () => {
  const c = buildConfirmationChecklist({
    direction: null, vwapStatus: "Choppy", emaStructure: "Mixed", ema9: null, ema21: null, ema50: null,
    evidence: [], rvol: null, rvolExpansion: 1.3, premiumConfirming: false, triggerLabel: null,
  });
  assert.equal(c.confirmed.length, 0);
  assert.equal(c.remaining.length, 1);
});

test("buildConfirmationChecklist: a fully-aligned bullish read confirms every item", () => {
  const c = buildConfirmationChecklist({
    direction: "Bullish", vwapStatus: "Above+Rising", emaStructure: "Strong Bullish", ema9: 110, ema21: 105, ema50: 100,
    evidence: [
      { side: "PUT", strike: 25000, oiChange: 100, oiChangePct: 10, premiumChangePct: -5, volumeMultiple: null, interpretation: "PUT WRITING / SUPPORT BUILDING" },
      { side: "CALL", strike: 25200, oiChange: -100, oiChangePct: -5, premiumChangePct: 8, volumeMultiple: null, interpretation: "CALL UNWINDING" },
    ],
    rvol: 2.1, rvolExpansion: 1.3, premiumConfirming: true, triggerLabel: null,
  });
  assert.equal(c.confirmed.length, 7);
  assert.equal(c.remaining.length, 0);
});

// N. False breakout precedent: early warning should flag weakening resistance without asserting a breakout happened
test("buildEarlyWarnings: call unwinding near resistance is flagged as a warning, not a confirmed breakout", () => {
  const w = buildEarlyWarnings({
    evidence: [{ side: "CALL", strike: 25200, oiChange: -80000, oiChangePct: -8.2, premiumChangePct: 18, volumeMultiple: null, interpretation: "CALL UNWINDING" }],
    distanceToResistancePts: 76, distanceToSupportPts: 124, rvol: 1.5, rvolStrong: 2.0, vwapStatus: "Above+Rising",
  });
  assert.ok(w.some((x) => x.text.toLowerCase().includes("resistance")));
});
