import { test } from "node:test";
import assert from "node:assert/strict";
import { toWatchStage, toWatchAction, toWatchRow } from "./scanner";
import { LiquidityStatusResult } from "../liquidityStatus/types";

test("toWatchStage: high-magnitude stages win over early ones", () => {
  assert.equal(toWatchStage("EXTENDED", "AVOID CHASING", 90), "EXTENDED");
  assert.equal(toWatchStage("EXHAUSTION", "REDUCE RISK", 80), "REVERSAL WATCH");
  assert.equal(toWatchStage("REVERSAL_WATCH", "WATCH", 60), "REVERSAL WATCH");
  assert.equal(toWatchStage("STRONG_MOVE", "WATCH", 70), "STRONG MOVE");
});

test("toWatchStage: a pending trigger surfaces as BREAKOUT WATCH", () => {
  assert.equal(toWatchStage("DEVELOPING", "WAIT FOR BREAKOUT", 55), "BREAKOUT WATCH");
  assert.equal(toWatchStage("EARLY_MOVE", "WAIT FOR BREAKDOWN", 45), "BREAKOUT WATCH");
});

test("toWatchStage: mid/early stages map through", () => {
  assert.equal(toWatchStage("DEVELOPING", "WATCH", 50), "DEVELOPING");
  assert.equal(toWatchStage("EARLY_MOVE", "WATCH", 40), "EARLY MOVE");
  assert.equal(toWatchStage("PULLBACK", "WAIT FOR PULLBACK", 45), "BUILDING");
});

test("toWatchStage: PRE_MOVE is QUIET until the score picks up, then BUILDING", () => {
  assert.equal(toWatchStage("PRE_MOVE", "WATCH", 10), "QUIET");
  assert.equal(toWatchStage("PRE_MOVE", "WATCH", 30), "BUILDING");
});

test("toWatchAction: maps engine actions onto the 5 watch actions, never inventing a BUY", () => {
  assert.equal(toWatchAction("AVOID CHASING"), "AVOID CHASING");
  assert.equal(toWatchAction("WAIT FOR PULLBACK"), "WAIT FOR PULLBACK");
  assert.equal(toWatchAction("WAIT FOR BREAKOUT"), "BREAKOUT READY");
  assert.equal(toWatchAction("WAIT FOR BREAKDOWN"), "BREAKOUT READY");
  assert.equal(toWatchAction("PREPARE FOR BUY"), "TAKE");
  assert.equal(toWatchAction("PREPARE FOR SELL"), "TAKE");
  // Everything non-actionable collapses to WATCH — the default early-warning state.
  for (const a of ["WATCH", "NO TRADE", "REDUCE RISK", "HOLD EXISTING POSITION"] as const) {
    assert.equal(toWatchAction(a), "WATCH");
  }
});

function fakeResult(over: Partial<LiquidityStatusResult> = {}): LiquidityStatusResult {
  return {
    symbol: "^NSEI", name: "NIFTY 50", spot: 25124, atmStrike: 25100,
    liquidityShift: "Bullish", moveStage: "DEVELOPING", continuationLikely: true,
    directionBias: "Bullish", moveStrength: 62, systemView: "sv", traderPreparation: "prep",
    evidence: [], keyLevels: [], distanceToSupportPts: null, distanceToResistancePts: null,
    liquidityFlowScore: { score: 62, breakdown: [] },
    directionalConfidence: { direction: "Bullish", score: 62, quality: "STRONG" },
    confirmations: { confirmed: [], remaining: [] },
    battlefield: { support: { label: "KEY SUPPORT", price: 25000, oi: null, oiChange: null, strength: "STRONG", distancePts: null }, spot: 25124, resistance: { label: "KEY RESISTANCE", price: 25200, oi: null, oiChange: null, strength: "WEAKENING", distancePts: null } },
    trigger: { direction: "UP", level: 25200, requiredConfirmation: [], potentialMoveZone: null },
    invalidation: { level: 25000, warning: "-" },
    traderAction: "WAIT FOR BREAKOUT", traderActionDetail: "Wait for a confirmed breakout.",
    earlyWarnings: [], shiftHistory: [], lastShiftEvent: null, conflict: { conflict: false, reason: null },
    structure: { ema9: null, ema21: null, ema50: null, emaStructure: "Strong Bullish", vwapStatus: "Above+Rising", vwapValue: null, rsi: 60 },
    rvol: 1.6, detection: {} as any, openingRange: {} as any, levels: [],
    freshness: { priceAgeSec: 10, optionAgeSec: 20, oiAgeSec: 20, oiStale: false, liveFeedStale: false },
    generatedAt: 0, disclaimer: "-",
    ...over,
  };
}

test("toWatchRow: maps a fresh engine result to the watch columns", () => {
  const row = toWatchRow(fakeResult());
  assert.equal(row.symbol, "^NSEI");
  assert.equal(row.score, 62);
  assert.equal(row.bias, "Bullish");
  assert.equal(row.stage, "BREAKOUT WATCH");
  assert.equal(row.price, 25124);
  assert.equal(row.trigger, 25200);
  assert.equal(row.invalidation, 25000);
  assert.equal(row.action, "BREAKOUT READY");
  assert.equal(row.dataState, "OK");
});

test("toWatchRow: a stale feed is reported as STALE (WAIT), never as a live signal", () => {
  const row = toWatchRow(fakeResult({ freshness: { priceAgeSec: 999, optionAgeSec: 999, oiAgeSec: 999, oiStale: true, liveFeedStale: true } }));
  assert.equal(row.dataState, "STALE");
  assert.ok(row.note.toLowerCase().includes("wait"));
});
