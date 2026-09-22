import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeStrikes } from "./strikeAnalysis";
import { OiAnalysis, OiStrike } from "../types";

function strike(o: Partial<OiStrike> & { strike: number }): OiStrike {
  return { ceOi: 0, peOi: 0, ceChg: 0, peChg: 0, ...o } as OiStrike;
}

// Minimal OiAnalysis with a realistic near-money chain for NIFTY ~23400.
function chain(strikes: OiStrike[], underlying = 23400): OiAnalysis {
  return {
    symbol: "^NSEI", nseSymbol: "NIFTY", available: true, underlying,
    expiry: "2026-09-25", topStrikes: strikes,
  } as any;
}

test("bearish → analyses PUT side, picks a responsive+liquid strike, marks spread unavailable", () => {
  const oi = chain([
    strike({ strike: 23300, peLtp: 40, peOi: 900000, peVol: 20000, peDelta: -0.30 }),  // OTM put
    strike({ strike: 23400, peLtp: 90, peOi: 2100000, peVol: 60000, peDelta: -0.50 }),  // ATM
    strike({ strike: 23500, peLtp: 150, peOi: 1200000, peVol: 40000, peDelta: -0.68 }), // ITM put
    strike({ strike: 23600, peLtp: 220, peOi: 30000, peVol: 500, peDelta: -0.80 }),     // deep ITM, illiquid
  ]);
  const a = analyzeStrikes(oi, "BEARISH", { finalAction: "WAIT", masterVerdict: "WAIT", name: "NIFTY 50" });
  assert.equal(a.available, true);
  assert.equal(a.side, "PE");
  assert.equal(a.atmStrike, 23400);
  assert.ok(a.rows.length >= 3);
  assert.ok(a.primary, "a primary strike is chosen");
  // Spread must be reported as unavailable, never fabricated.
  assert.match(a.spreadNote, /INSUFFICIENT DATA|not in the option feed/);
  // STATUS follows Master (WAIT), even though a fast strike exists.
  assert.equal(a.summary.status, "WAIT");
  assert.equal(a.summary.optionView, "PE");
});

test("neutral direction selects no side; still lists ATM", () => {
  const oi = chain([
    strike({ strike: 23400, ceLtp: 88, peLtp: 90, ceOi: 1e6, peOi: 1e6, ceDelta: 0.5, peDelta: -0.5 }),
  ]);
  const a = analyzeStrikes(oi, "NEUTRAL", { masterVerdict: "WAIT" });
  assert.equal(a.available, true);
  assert.equal(a.side, null);
  assert.equal(a.primary, null);
  assert.ok(a.atm.ce && a.atm.pe);
});

test("stale or missing chain → DATA UNAVAILABLE, never a strike pick", () => {
  const stale = analyzeStrikes(chain([strike({ strike: 23400, ceLtp: 80, ceDelta: 0.5 })]), "BULLISH", { stale: true });
  assert.equal(stale.available, false);
  assert.match(stale.reason!, /DATA UNAVAILABLE/);
  assert.equal(stale.primary, null);

  const none = analyzeStrikes(null, "BULLISH", {});
  assert.equal(none.available, false);
  assert.equal(none.primary, null);
});

test("no premiums in chain → INSUFFICIENT DATA", () => {
  const oi = chain([strike({ strike: 23400, ceOi: 100000, peOi: 100000 })]); // OI only, no LTP
  const a = analyzeStrikes(oi, "BULLISH", {});
  assert.equal(a.available, false);
  assert.match(a.reason!, /INSUFFICIENT DATA/);
});
