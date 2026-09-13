import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLabels } from "./labelBuilder";
import { MarketSnapshotRecord } from "../data/tradingDataTypes";

function snap(timestamp: number, spot: number): MarketSnapshotRecord {
  return {
    timestamp, recordedAt: Date.now(), symbol: "^NSEI", spot, atm: null, expiry: null, marketSession: "OPEN",
    technicals: { ema9: null, ema21: null, ema50: null, macd: null, macdSignal: null, macdHistogram: null, vwap: null, rsi: null, bollingerUpper: null, bollingerMiddle: null, bollingerLower: null, supertrend: null, supertrendDirection: null },
    marketStructure: null, regime: null,
  };
}

const T = 1_000_000_000; // arbitrary base epoch second (10:15-equivalent, per the scenario in the instructions)

test("ANTI-LEAKAGE: a snapshot AT the current timestamp never contributes to that timestamp's own label", () => {
  // Scenario straight from the instructions: snapshot at "10:15" (T). A
  // snapshot with the SAME timestamp T but a wildly different price must be
  // completely invisible to the label — only timestamps strictly AFTER T count.
  const sneaky = snap(T, 999999); // same instant, extreme price
  const labels = buildLabels(T, 100, [sneaky]);
  assert.equal(labels.return5m, null);
  assert.equal(labels.return15m, null);
  assert.equal(labels.return30m, null);
  assert.equal(labels.return60m, null);
});

test("ANTI-LEAKAGE: a snapshot BEFORE the current timestamp never contributes to the label", () => {
  const past = snap(T - 3600, 500); // one hour in the past
  const labels = buildLabels(T, 100, [past]);
  assert.equal(labels.return5m, null);
  assert.equal(labels.return60m, null);
});

test("label becomes available once a real future snapshot exists at/after the target minute (10:45 example from the instructions)", () => {
  const future30m = snap(T + 30 * 60, 110); // exactly 30 minutes later, price up 10%
  const labels = buildLabels(T, 100, [future30m]);
  assert.equal(labels.return30m, 10); // (110-100)/100 * 100 = 10%
  // Other horizons still have no data yet — must stay null, not extrapolated.
  assert.equal(labels.return5m, null);
  assert.equal(labels.return60m, null);
});

test("only future snapshots within tolerance of the target minute are used — a snapshot far past the target is not silently reused", () => {
  const wayLater = snap(T + 3 * 3600, 200); // 3 hours later — way past the 5m target + tolerance
  const labels = buildLabels(T, 100, [wayLater]);
  assert.equal(labels.return5m, null);
});

test("null spot never produces a fabricated label", () => {
  const future = snap(T + 5 * 60, 100);
  const labels = buildLabels(T, null, [future]);
  assert.equal(labels.return5m, null);
  assert.equal(labels.return60m, null);
});
