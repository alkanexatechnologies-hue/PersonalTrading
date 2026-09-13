import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNoLeakage } from "./dataValidator";
import { buildLabels } from "./labelBuilder";
import { MarketSnapshotRecord } from "../data/tradingDataTypes";
import { DatasetRow } from "./datasetBuilder";
import { FeatureRow } from "./featureSchema";

const T = 1_000_000_000;

function snap(timestamp: number, spot: number): MarketSnapshotRecord {
  return {
    timestamp, recordedAt: Date.now(), symbol: "^NSEI", spot, atm: null, expiry: null, marketSession: "OPEN",
    technicals: { ema9: null, ema21: null, ema50: null, macd: null, macdSignal: null, macdHistogram: null, vwap: null, rsi: null, bollingerUpper: null, bollingerMiddle: null, bollingerLower: null, supertrend: null, supertrendDirection: null },
    marketStructure: null, regime: null,
  };
}

function featureRow(timestamp: number, spot: number): FeatureRow {
  return {
    timestamp, symbol: "^NSEI", spot,
    technicalFeatures: { ema9: null, ema21: null, ema50: null, macd: null, macdSignal: null, macdHistogram: null, vwap: null, rsi: null, bollingerUpper: null, bollingerMiddle: null, bollingerLower: null, supertrend: null, supertrendDirection: null },
    oiFeatures: { totalCallOi: null, totalPutOi: null, putCallRatio: null, totalOiChange: null, strikesRecorded: 0 },
    marketStructure: null, regime: null, strategyScore: null, masterDecision: null, oiBias: null,
  };
}

test("checkNoLeakage passes for correctly-built dataset rows", () => {
  const snapshots = [snap(T, 100), snap(T + 30 * 60, 110)];
  const labels = buildLabels(T, 100, snapshots);
  const row: DatasetRow = { ...featureRow(T, 100), labels };
  const result = checkNoLeakage([row], new Map([["^NSEI", snapshots]]));
  assert.equal(result.ok, true);
  assert.equal(result.violations.length, 0);
});

test("checkNoLeakage DETECTS a corrupted row whose stored label doesn't match an honest recomputation", () => {
  const snapshots = [snap(T, 100), snap(T + 30 * 60, 110)];
  const honestLabels = buildLabels(T, 100, snapshots);
  // Simulate a bug: someone hand-edited/corrupted the stored label to a value
  // that could only come from leaked future information beyond what's real.
  const corrupted: DatasetRow = { ...featureRow(T, 100), labels: { ...honestLabels, return30m: 9999 } };
  const result = checkNoLeakage([corrupted], new Map([["^NSEI", snapshots]]));
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.field === "return30m"));
});

test("checkNoLeakage's poisoned-snapshot probe: a same-timestamp snapshot must never change the label", () => {
  // This exercises the validator's own internal probe (it injects an extreme
  // same-timestamp snapshot itself) — a clean row must still report ok=true,
  // proving the probe alone doesn't produce false positives.
  const snapshots = [snap(T, 100)];
  const labels = buildLabels(T, 100, snapshots); // no future data at all yet — all nulls
  const row: DatasetRow = { ...featureRow(T, 100), labels };
  const result = checkNoLeakage([row], new Map([["^NSEI", snapshots]]));
  assert.equal(result.ok, true);
});
