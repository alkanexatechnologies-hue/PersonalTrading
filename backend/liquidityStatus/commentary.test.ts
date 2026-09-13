import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemView, buildTraderPreparation, violatesSafeLanguage } from "./commentary";
import { KeyLevel } from "./types";

const resistance: KeyLevel = { label: "KEY RESISTANCE", price: 25200, oi: 100, oiChange: -10, strength: "WEAKENING", distancePts: 76 };
const support: KeyLevel = { label: "KEY SUPPORT", price: 25000, oi: 200, oiChange: 20, strength: "STRONG", distancePts: 124 };

test("buildSystemView: a bullish view never trips the shared safety check", () => {
  const text = buildSystemView({ name: "NIFTY", direction: "Bullish", evidenceSummary: "Liquidity is shifting toward the bullish side.", vwapStatus: "Above+Rising", moveStage: "STRONG_MOVE", resistance, support });
  assert.equal(violatesSafeLanguage(text), null);
  assert.ok(text.includes("upside"));
});

test("buildSystemView: a conflict view is honest about the disagreement, no forced call", () => {
  const text = buildSystemView({ name: "NIFTY", direction: "Conflict", evidenceSummary: "Liquidity evidence is mixed.", vwapStatus: "Choppy", moveStage: "PRE_MOVE", resistance, support });
  assert.equal(violatesSafeLanguage(text), null);
  assert.ok(text.toLowerCase().includes("disagree"));
});

test("buildTraderPreparation: bullish prep names the trigger, the zone label (not a guarantee), and the invalidation", () => {
  const text = buildTraderPreparation("Bullish", { direction: "UP", level: 25200, requiredConfirmation: [], potentialMoveZone: [25260, 25320] }, { level: 25000, warning: "-" });
  assert.equal(violatesSafeLanguage(text), null);
  assert.ok(text.includes("25200"));
  assert.ok(text.includes("potential move zone"));
  assert.ok(text.includes("25000"));
});

test("buildTraderPreparation: no trigger/invalidation available -> an honest wait message, not a fabricated plan", () => {
  const text = buildTraderPreparation("Neutral", null, null);
  assert.equal(violatesSafeLanguage(text), null);
  assert.ok(text.toLowerCase().includes("wait"));
});
