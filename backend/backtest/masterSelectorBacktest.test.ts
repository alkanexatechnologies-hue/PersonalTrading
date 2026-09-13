// Verifies the Layer 2 safety guarantees explicitly required: no synthetic OI,
// no reuse of today's/future OI for historical timestamps, and FULL_MASTER
// fails safely (never reaches candidate generation / arbitrate()) until a
// real historical option-chain provider exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { historicalOptionChainProvider } from "./historicalOptionChainProvider";
import { runMasterSelectorBacktest } from "./masterSelectorBacktest";
import { FullMasterUnavailableError } from "./backtestMode";
import { buildMarketSnapshot, buildMarketSnapshots } from "./dhanSnapshotBuilder";
import { Candle } from "../types";

function fakeCandles(n: number, start = 20000): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: 1_700_000_000 + i * 60,
    open: start + i, high: start + i + 5, low: start + i - 5, close: start + i + (i % 3),
    volume: 1000,
  }));
}

test("historicalOptionChainProvider always returns NOT_AVAILABLE (no provider exists yet)", async () => {
  const r1 = await historicalOptionChainProvider.getSnapshot(1_700_000_000, "^NSEI", "2026-09-30");
  const r2 = await historicalOptionChainProvider.getSnapshot(Date.now() / 1000, "^NSEBANK", "2026-10-30");
  assert.equal(r1, "NOT_AVAILABLE");
  assert.equal(r2, "NOT_AVAILABLE");
});

test("buildMarketSnapshot never populates optionChain — always NOT_AVAILABLE, never fabricated", () => {
  const candles = fakeCandles(80);
  const snap = buildMarketSnapshot("^NSEI", candles, candles.length - 1);
  assert.equal(snap.optionChain, "NOT_AVAILABLE");
  assert.equal(snap.symbol, "^NSEI");
  assert.equal(typeof snap.spot, "number");
  // Technicals are real computed values, not placeholders.
  assert.ok(snap.technicals.ema21 != null);
  assert.ok(snap.technicals.ema50 != null);
});

test("TECHNICAL_ONLY mode is unaffected — never blocked, never touches the OI provider", async () => {
  const candles = fakeCandles(80);
  const snapshots = buildMarketSnapshots("^NSEI", candles);
  const result = await runMasterSelectorBacktest("TECHNICAL_ONLY", "^NSEI", "2026-09-30", snapshots);
  assert.equal(result.blocked, false);
  assert.equal(result.mode, "TECHNICAL_ONLY");
});

test("FULL_MASTER fails safely with the exact required message — never fabricates OI, never reaches arbitrate()", async () => {
  const candles = fakeCandles(80);
  const snapshots = buildMarketSnapshots("^NSEI", candles);
  await assert.rejects(
    () => runMasterSelectorBacktest("FULL_MASTER", "^NSEI", "2026-09-30", snapshots),
    (e: unknown) => {
      assert.ok(e instanceof FullMasterUnavailableError);
      assert.equal((e as Error).message, "Historical option-chain data unavailable. Full Master Trade Selector backtest cannot be executed.");
      return true;
    }
  );
});
