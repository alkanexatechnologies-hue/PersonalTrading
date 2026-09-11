import test from "node:test";
import assert from "node:assert/strict";
import { srRoomOk, capTargetAndStop, LevelContext } from "./entryRules";

// srRoomOk and capTargetAndStop drive whether a paper-trade idea is allowed to
// enter near a support/resistance wall, and what its target/stop premium levels
// are - previously flat percentages regardless of volatility, and a room check
// loose enough to barely block an entry sitting right at the wall.

function lv(overrides: Partial<LevelContext> = {}): LevelContext {
  return {
    pdh: null, pdl: null, pdc: null, dayOpen: null, vwap: null,
    orHigh: null, orLow: null, majorSupport: null, majorResistance: null,
    swingHigh: null, swingLow: null, bias: 0, notes: [],
    ...overrides,
  };
}

test("srRoomOk: blocks a CE entry sitting right at major resistance (room well under the threshold)", () => {
  // spot=25000, resistance=25010 -> only 10 points of room, far under
  // max(spot*0.003, 0.35*atrDaily) = max(75, ...).
  const r = srRoomOk("Bullish", 25000, lv({ majorResistance: 25010 }), 100);
  assert.equal(r.ok, false);
  assert.match(r.reason, /resistance/);
});

test("srRoomOk: allows a CE entry with real room to resistance", () => {
  const r = srRoomOk("Bullish", 25000, lv({ majorResistance: 25300 }), 100);
  assert.equal(r.ok, true);
});

test("srRoomOk: symmetric for a PE entry against major support", () => {
  const blocked = srRoomOk("Bearish", 25000, lv({ majorSupport: 24990 }), 100);
  assert.equal(blocked.ok, false);
  const ok = srRoomOk("Bearish", 25000, lv({ majorSupport: 24700 }), 100);
  assert.equal(ok.ok, true);
});

test("capTargetAndStop: a normal-volatility day (ATR at the 1% baseline) caps profit at +15%, and never lets the stop drift looser than the ~1.3 reward:risk floor", () => {
  // A wide/loose input premiumStop (50) so the computed RR-based floor is what
  // actually governs the result, not the input.
  const idea = { direction: "Bullish" as const, spot: 25000, spotTarget: 25500, spotStop: 24800, premium: 100, premiumTarget: 200, premiumStop: 50 };
  const out = capTargetAndStop(idea, lv(), 250); // atrDaily=250 = 1% of spot = baseline
  assert.equal(out.premiumTarget, 115); // 100 * 1.15
  // reward = 15, stopForRR = 100 - 15/1.3 = 88.46 (tighter than the -12% floor of 88)
  assert.equal(out.premiumStop, 88.46);
});

test("capTargetAndStop: a quiet day (low ATR) tightens the profit cap below the flat +15%", () => {
  const idea = { direction: "Bullish" as const, spot: 25000, spotTarget: 25500, spotStop: 24800, premium: 100, premiumTarget: 200, premiumStop: 95 };
  // atrDaily=125 = 0.5% of spot -> half the baseline -> volMult clamps to 0.7
  const out = capTargetAndStop(idea, lv(), 125);
  assert.equal(out.premiumTarget, 110.5); // 100 * (1 + 0.15*0.7)
});

test("capTargetAndStop: a volatile day (high ATR) widens the profit cap above the flat +15%", () => {
  const idea = { direction: "Bullish" as const, spot: 25000, spotTarget: 25500, spotStop: 24800, premium: 100, premiumTarget: 200, premiumStop: 95 };
  // atrDaily=750 = 3% of spot -> 3x the baseline -> volMult clamps to 1.6
  const out = capTargetAndStop(idea, lv(), 750);
  assert.equal(out.premiumTarget, 124); // 100 * (1 + 0.15*1.6)
});

test("capTargetAndStop: projected spot target is capped at the major-wall level, never beyond it", () => {
  const idea = { direction: "Bullish" as const, spot: 25000, spotTarget: 25500, spotStop: 24800, premium: 100, premiumTarget: 200, premiumStop: 95 };
  const out = capTargetAndStop(idea, lv({ majorResistance: 25200 }), 250);
  assert.equal(out.spotTarget, 25200);
});
