import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEvidence, summarizeEvidence } from "./evidence";
import { OiChangeResult } from "../oi/oiChange";

function fakeOc(overrides: Partial<OiChangeResult> = {}): OiChangeResult {
  const leg = (oiChg: number, ltpChgPct: number) => ({
    type: "CE" as const, moneyness: "ATM" as const, oi: 100000, oiChg, oiChgPct: 5,
    ltp: 50, ltpChg: 1, ltpChgPct, vol: 1000, action: "-", bullish: null,
  });
  return {
    symbol: "^NSEI", name: "NIFTY 50", type: "index", underlying: 25124, atmStrike: 25100, expiry: "2026-09-25",
    baselineSpot: 25000, spotChg: 124, spotChgPct: 0.5,
    levels: [], chain: [
      { strike: 25000, ce: leg(-5000, 10), pe: leg(1840000, -14.2) },
      { strike: 25200, ce: leg(-980000, 22.1), pe: leg(3000, -5) },
    ],
    best: null,
    maxCeBuildup: { strike: 25200, side: "CE", oiChg: -980000, oiChgPct: -9.8, veryHigh: false, label: "Call unwinding at 25200" },
    maxPeBuildup: { strike: 25000, side: "PE", oiChg: 1840000, oiChgPct: 18.4, veryHigh: true, label: "Put writing at 25000" },
    netCeChg: -980000, netPeChg: 1840000,
    bias: "Bullish", note: "Put writing dominates", moveRead: "-",
    oiDirScore: 40, oiVerdict: "Bullish", oiConfidence: 65, oiReasons: [],
    major: false, majorReason: null, hasBaseline: true, baselineNote: "-",
    asOf: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// C. Call unwinding
test("buildEvidence: call OI decreasing + premium rising -> CALL UNWINDING", () => {
  const rows = buildEvidence(fakeOc());
  const call = rows.find((r) => r.side === "CALL");
  assert.equal(call?.interpretation, "CALL UNWINDING");
});

// A. Put writing / support building (bullish liquidity buildup)
test("buildEvidence: put OI increasing + premium falling -> PUT WRITING / SUPPORT BUILDING", () => {
  const rows = buildEvidence(fakeOc());
  const put = rows.find((r) => r.side === "PUT");
  assert.equal(put?.interpretation, "PUT WRITING / SUPPORT BUILDING");
});

// D. Put unwinding
test("buildEvidence: put OI decreasing + premium rising -> PUT UNWINDING", () => {
  const oc = fakeOc({
    maxPeBuildup: { strike: 25000, side: "PE", oiChg: -500000, oiChgPct: -12, veryHigh: false, label: "-" },
    chain: [{ strike: 25000, ce: { type: "CE", moneyness: "ATM", oi: 1, oiChg: 0, oiChgPct: 0, ltp: 1, ltpChg: 0, ltpChgPct: 0, vol: 0, action: "-", bullish: null }, pe: { type: "PE", moneyness: "ATM", oi: 1, oiChg: -500000, oiChgPct: -12, ltp: 20, ltpChg: 3, ltpChgPct: 15, vol: 0, action: "-", bullish: null } }],
  });
  const rows = buildEvidence(oc);
  assert.equal(rows.find((r) => r.side === "PUT")?.interpretation, "PUT UNWINDING");
});

test("buildEvidence: no baseline yet -> no evidence rows fabricated", () => {
  const rows = buildEvidence(fakeOc({ hasBaseline: false }));
  assert.deepEqual(rows, []);
});

test("summarizeEvidence: bullish-leaning rows summarize toward the bullish side", () => {
  const rows = buildEvidence(fakeOc());
  assert.equal(summarizeEvidence(rows), "Liquidity is shifting toward the bullish side.");
});

test("summarizeEvidence: no evidence at all is reported honestly, not guessed", () => {
  assert.ok(summarizeEvidence([]).toLowerCase().includes("no liquidity evidence"));
});
