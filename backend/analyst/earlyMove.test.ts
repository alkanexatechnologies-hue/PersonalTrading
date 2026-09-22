import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEarlyMove, Candle } from "./earlyMove";

// Real 5M candles from 2026-09-22 around the two major BOS events (from the audit).
// Bearish leg into the 11:50 BOS:
const bearSeq: Candle[] = [
  { time: 1, open: 23400, high: 23402, low: 23388, close: 23390 },
  { time: 2, open: 23390, high: 23392, low: 23378, close: 23381 },
  { time: 3, open: 23381, high: 23381, low: 23370, close: 23371 },
  { time: 4, open: 23371, high: 23377, low: 23366, close: 23371 },
  { time: 5, open: 23372, high: 23373, low: 23357, close: 23364 },
  { time: 6, open: 23364, high: 23365, low: 23352, close: 23352 }, // 11:50 BOS candle — strong bearish close
];
// EMA21 well above price throughout (bearish context, price below EMA21).
const bearEma21 = [23420, 23415, 23410, 23405, 23400, 23392];

// Reversal into the 14:10 bullish BOS: bearish context, price approaches EMA21
// from below with long lower wicks (liquidity swept below), bullish rejection.
const revSeq: Candle[] = [
  { time: 1, open: 23330, high: 23338, low: 23320, close: 23322 },
  { time: 2, open: 23322, high: 23325, low: 23305, close: 23308 },
  { time: 3, open: 23308, high: 23320, low: 23302, close: 23305 },
  { time: 4, open: 23305, high: 23309, low: 23286, close: 23308 }, // long lower wick (sweep below)
  { time: 5, open: 23308, high: 23313, low: 23296, close: 23313 }, // bullish rejection, long lower wick
];
const revEma21 = [23345, 23342, 23340, 23336, 23335];

test("bearish leg into a down-BOS → BEARISH CONTINUATION (not a reversal)", () => {
  const r = classifyEarlyMove({
    candles: bearSeq, ema21: bearEma21, context5m: "Bearish", structure15m: "Bearish",
    lastBos: { direction: "Bearish", breakIndex: 5, stage: "Confirmed", time: 6 },
    swingHigh: 23402, swingLow: 23357,
  });
  assert.equal(r.label, "BEARISH CONTINUATION");
  assert.equal(r.bosStatus, "CONFIRMED");
  assert.match(r.action, /Master Trade Selector/);
});

test("bearish context + EMA21 approach + lower-wick rejection + sweep, no BOS yet → EARLY MOVE WATCH", () => {
  const r = classifyEarlyMove({
    candles: revSeq, ema21: revEma21, context5m: "Bearish", structure15m: "Bearish",
    lastBos: null, swingHigh: 23338, swingLow: 23302,
  });
  // A bullish reaction against a bearish context, with liquidity taken below → developing reversal/sweep.
  assert.ok(["REVERSAL DEVELOPING", "LIQUIDITY SWEEP", "EMA REJECTION"].includes(r.label), `got ${r.label}`);
  assert.equal(r.watch, true);
  assert.match(r.action, /WAIT FOR CONFIRMATION/);
  assert.ok(r.evidence.includes("rejection candle"));
});

test("5M vs 15M disagreement → TIMEFRAME CONFLICT, WAIT", () => {
  const r = classifyEarlyMove({
    candles: revSeq, ema21: revEma21, context5m: "Bullish", structure15m: "Bearish",
    lastBos: null, swingHigh: 23338, swingLow: 23302,
  });
  assert.equal(r.label, "TIMEFRAME CONFLICT");
  assert.match(r.action, /WAIT/);
});

test("never manufactures a trade — action is always WAIT or defers to Master Selector", () => {
  for (const ctx of ["Bullish", "Bearish", "Ranging"] as const) {
    const r = classifyEarlyMove({ candles: revSeq, ema21: revEma21, context5m: ctx, lastBos: null, swingHigh: 23338, swingLow: 23302 });
    assert.ok(/WAIT|Master Trade Selector|In-trend/.test(r.action), `${ctx}: ${r.action}`);
    assert.notEqual(r.action, "TAKE");
  }
});
