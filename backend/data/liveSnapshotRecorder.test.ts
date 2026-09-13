// Uses a clearly-fake, far-future test date partition (never a real trading
// day) so these tests never touch real collected data, and cleans up after
// itself. No changes were made to liveSnapshotRecorder.ts to enable this -
// same file-based storage a real run would use.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { recordLiveSnapshot } from "./liveSnapshotRecorder";
import { Candle, OiAnalysis } from "../types";

const TEST_DATE = "2099-01-01";
const TEST_DIR = path.join(process.cwd(), "data", "trading_data", TEST_DATE);
// 2099-01-01 00:00 UTC epoch seconds, used as the base so istDateStr(new
// Date(timestamp*1000)) resolves to TEST_DATE regardless of host timezone.
const BASE_TS = Math.floor(Date.UTC(2099, 0, 1, 6, 0, 0) / 1000); // ~11:30 IST

after(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
});

function fakeCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: BASE_TS - (n - i) * 900, // 15m bars leading up to BASE_TS
    open: 24000 + i, high: 24010 + i, low: 23990 + i, close: 24005 + i,
    volume: 10000,
  }));
}

function fakeOi(): OiAnalysis {
  return {
    symbol: "^NSEI", nseSymbol: "NIFTY", available: true, underlying: 24500,
    expiry: "2099-01-08", pcr: 1.1, pcrState: "neutral", totalCeOi: 100000, totalPeOi: 110000,
    support: 24400, resistance: 24600, maxPain: 24500,
    ceBuildup: "long buildup", peBuildup: "long buildup",
    verdict: { bias: "Bullish", reasons: [] },
    topStrikes: [
      { strike: 24500, ceOi: 5000, peOi: 6000, ceChg: 100, peChg: -50, ceLtp: 120.5, peLtp: 95.25, ceVol: 1000, peVol: 800 },
      { strike: 24600, ceOi: 4000, peOi: 3000, ceChg: -20, peChg: 80, ceLtp: 80.1, peLtp: 140.75, ceVol: 500, peVol: 600 },
    ],
    asOf: BASE_TS, disclaimer: "test",
  };
}

function readJsonl(filePath: string): any[] {
  let raw = "";
  try { raw = fs.readFileSync(filePath, "utf8"); } catch { return []; }
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("recordLiveSnapshot writes one market_snapshot with real computed technicals (same indicator functions as live)", () => {
  const result = recordLiveSnapshot({
    symbol: "^NSEI", timestamp: BASE_TS, spot: 24505, atm: 24500, expiry: "2099-01-08",
    candles: fakeCandles(60), oi: fakeOi(), oiVerdict: "Bullish", masterDecision: "GO", finalScore: 62, regime: "Trending",
  });
  assert.equal(result.marketSnapshot.symbol, "^NSEI");
  assert.equal(result.marketSnapshot.timestamp, BASE_TS);
  assert.ok(result.marketSnapshot.technicals.ema21 != null, "EMA21 should be a real computed number, not null, with 60 bars");
  assert.ok(result.marketSnapshot.technicals.rsi != null);
  assert.equal(result.optionChainRows, 4); // 2 strikes x CE+PE

  const rows = readJsonl(path.join(TEST_DIR, "market_snapshots.jsonl"));
  assert.equal(rows.length, 1);
});

test("option_chain rows never contain fabricated OHLC — always null (Groww's live chain has no per-option candles)", () => {
  const rows = readJsonl(path.join(TEST_DIR, "option_chain.jsonl"));
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.open, null);
    assert.equal(r.high, null);
    assert.equal(r.low, null);
    assert.equal(r.close, null);
  }
});

test("duplicate snapshot at the same timestamp+symbol is handled safely — no duplicate rows written", () => {
  const before = readJsonl(path.join(TEST_DIR, "market_snapshots.jsonl")).length;
  const beforeChain = readJsonl(path.join(TEST_DIR, "option_chain.jsonl")).length;
  const beforeStrat = readJsonl(path.join(TEST_DIR, "strategy_snapshots.jsonl")).length;

  // Same timestamp+symbol as the first test — simulates two overlapping
  // /oi-command callers (a browser tab + a background job) both triggering
  // the recorder for the same already-computed data.
  const result = recordLiveSnapshot({
    symbol: "^NSEI", timestamp: BASE_TS, spot: 24505, atm: 24500, expiry: "2099-01-08",
    candles: fakeCandles(60), oi: fakeOi(), oiVerdict: "Bullish", masterDecision: "GO", finalScore: 62, regime: "Trending",
  });

  assert.equal(result.optionChainRows, 0, "every strike/side was already recorded — nothing new should be written");
  const after1 = readJsonl(path.join(TEST_DIR, "market_snapshots.jsonl")).length;
  const afterChain = readJsonl(path.join(TEST_DIR, "option_chain.jsonl")).length;
  const afterStrat = readJsonl(path.join(TEST_DIR, "strategy_snapshots.jsonl")).length;
  assert.equal(after1, before, "market_snapshots must not grow on a duplicate");
  assert.equal(afterChain, beforeChain, "option_chain must not grow on a duplicate");
  assert.equal(afterStrat, beforeStrat, "strategy_snapshots must not grow on a duplicate");
});

test("missing option chain (oi=null) still records the market/strategy snapshot, with zero option_chain rows — never fabricated", () => {
  const ts2 = BASE_TS + 900; // a new, distinct timestamp so this isn't deduped against the earlier tests
  const result = recordLiveSnapshot({
    symbol: "^NSEBANK", timestamp: ts2, spot: 51000, atm: 51000, expiry: null,
    candles: fakeCandles(60), oi: null, oiVerdict: null, masterDecision: null, finalScore: null, regime: null,
  });
  assert.equal(result.optionChainRows, 0);
  assert.equal(result.marketSnapshot.spot, 51000);
  assert.equal(result.strategySnapshot.oiBias, null);
  assert.equal(result.strategySnapshot.callScore, null);
  assert.equal(result.strategySnapshot.putScore, null);
});
