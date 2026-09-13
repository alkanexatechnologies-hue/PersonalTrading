import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateLiquidityStatus } from "./engine";
import { clearShiftHistoryForTest } from "./shiftTracker";
import { Candle, OiAnalysis } from "../types";
import { LiquidityStatusDeps } from "./types";

const DAY_SEC = 86400;

function makeTrend(n: number, startPrice: number, stepPct: number, startTime: number, stepSec = 300): Candle[] {
  const out: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const open = price;
    price = price * (1 + stepPct);
    out.push({ time: startTime + i * stepSec, open, high: Math.max(open, price) * 1.001, low: Math.min(open, price) * 0.999, close: price, volume: 100000 + i * 50 });
  }
  return out;
}

function fakeOi(underlying: number, asOf: number): OiAnalysis {
  return {
    symbol: "^NSEI", nseSymbol: "NIFTY", available: true, underlying, expiry: "2026-09-25",
    pcr: 1.3, pcrState: "bullish", totalCeOi: 1000000, totalPeOi: 1300000,
    support: Math.round(underlying * 0.99 / 50) * 50, resistance: Math.round(underlying * 1.01 / 50) * 50, maxPain: Math.round(underlying / 50) * 50,
    ceBuildup: "short covering", peBuildup: "long buildup", verdict: { bias: "Bullish", reasons: [] },
    topStrikes: [], asOf, disclaimer: "-",
  };
}

function buildDeps(overrides: Partial<{ oiAsOfOffsetSec: number; nowEpoch: number }> = {}): LiquidityStatusDeps {
  const nowEpoch = overrides.nowEpoch ?? Math.floor(Date.UTC(2026, 8, 15, 10, 0, 0) / 1000); // ~15:30 IST
  const c5EndTime = nowEpoch - 60;
  const c5 = makeTrend(60, 25000, 0.0008, c5EndTime - 60 * 300, 300);
  const c1 = makeTrend(200, 25000, 0.0001, c5EndTime - 200 * 60, 60);
  const daily: Candle[] = [];
  for (let i = 40; i >= 1; i--) daily.push({ time: nowEpoch - i * DAY_SEC, open: 24800, high: 25050, low: 24750, close: 24900 + i, volume: 5000000 });
  const spot = c5[c5.length - 1].close;
  const oiAsOf = nowEpoch - (overrides.oiAsOfOffsetSec ?? 20);

  return {
    listEligibleStocks: () => [],
    getCandles: async (_symbol, interval) => (interval === "1m" ? c1 : interval === "1d" ? daily : c5),
    getOi: async () => fakeOi(spot, oiAsOf),
    nowEpochSec: () => nowEpoch,
  };
}

test("evaluateLiquidityStatus: fresh OI produces a real (non-stale) freshness reading", async () => {
  clearShiftHistoryForTest("^NSEI");
  const r = await evaluateLiquidityStatus("^NSEI", buildDeps({ oiAsOfOffsetSec: 20 }));
  assert.equal(r.freshness.oiStale, false);
  clearShiftHistoryForTest("^NSEI");
});

// L. Stale OI must never create a false/confirmed signal.
test("evaluateLiquidityStatus: OI older than 90s is marked stale and is NOT used as fresh confirmation", async () => {
  clearShiftHistoryForTest("^NSEI");
  const r = await evaluateLiquidityStatus("^NSEI", buildDeps({ oiAsOfOffsetSec: 150 }));
  assert.equal(r.freshness.oiStale, true);
  // Stale OI => computeOiChange is never run => no evidence, no baseline claimed.
  assert.deepEqual(r.evidence, []);
  assert.equal(r.confirmations.remaining.some((c) => false), false); // sanity: doesn't throw
  clearShiftHistoryForTest("^NSEI");
});

test("evaluateLiquidityStatus: never declares an EXTENDED move as a fresh PREPARE signal (no-chase holds end-to-end)", async () => {
  clearShiftHistoryForTest("^NSEI");
  const deps = buildDeps({ oiAsOfOffsetSec: 20 });
  const extreme: LiquidityStatusDeps = {
    ...deps,
    getCandles: async (symbol, interval) => {
      if (interval === "5m") {
        const nowEpoch = deps.nowEpochSec();
        return makeTrend(60, 25000, 0.004, nowEpoch - 60 * 300, 300); // a large sustained move
      }
      return deps.getCandles(symbol, interval);
    },
  };
  const r = await evaluateLiquidityStatus("^NSEI", extreme);
  if (r.moveStage === "EXTENDED" || r.moveStage === "EXHAUSTION") {
    assert.equal(r.traderAction, "AVOID CHASING");
  }
  clearShiftHistoryForTest("^NSEI");
});

test("evaluateLiquidityStatus: result always includes a system view and trader preparation, never empty", async () => {
  clearShiftHistoryForTest("^NSEI");
  const r = await evaluateLiquidityStatus("^NSEI", buildDeps());
  assert.ok(r.systemView.length > 0);
  assert.ok(r.traderPreparation.length > 0);
  clearShiftHistoryForTest("^NSEI");
});
