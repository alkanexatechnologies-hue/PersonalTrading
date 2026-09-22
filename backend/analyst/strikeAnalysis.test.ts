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

test("option setup: entry/SL/target/R:R derived from real delta + spot levels", () => {
  const oi = chain([
    strike({ strike: 23300, peLtp: 40, peOi: 900000, peVol: 20000, peDelta: -0.30 }),
    strike({ strike: 23400, peLtp: 90, peOi: 2100000, peVol: 60000, peDelta: -0.50 }),  // ATM
    strike({ strike: 23500, peLtp: 150, peOi: 1200000, peVol: 40000, peDelta: -0.68 }),
  ]);
  // Bearish: spot 23400, SL 23440 (40 pts), target 23320 (80 pts).
  const a = analyzeStrikes(oi, "BEARISH", { spotSL: 23440, spotTarget: 23320, name: "NIFTY 50" });
  assert.ok(a.bestSetup, "best setup computed");
  const s = a.bestSetup!;
  assert.equal(s.entryPremium != null, true);
  // premium move ≈ |delta| × underlying move; risk uses 40pts, reward 80pts → R:R ≈ 2.
  assert.ok(s.rr != null && s.rr >= 1.8, `R:R ~2 expected, got ${s.rr}`);
  assert.equal(s.meets1to2, true);
  assert.ok(s.stopPremium! < s.entryPremium! && s.targetPremium! > s.entryPremium!);
});

test("option setup: R:R below 1:2 is flagged, never widened to fake it", () => {
  const oi = chain([strike({ strike: 23400, peLtp: 90, peOi: 2e6, peVol: 6e4, peDelta: -0.50 })]);
  // Reward (20pts) < 2× risk (40pts) → R:R ~0.5, must NOT meet 1:2.
  const a = analyzeStrikes(oi, "BEARISH", { spotSL: 23440, spotTarget: 23380 });
  const s = a.bestSetup!;
  assert.equal(s.meets1to2, false);
  assert.match(s.note, /< 1:2|WAIT/);
});
