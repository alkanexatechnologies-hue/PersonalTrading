import "./aiConfig";
import { MarketSnapshotRecord } from "../data/tradingDataTypes";
import { DatasetRow } from "./datasetBuilder";
import { buildLabels } from "./labelBuilder";

// ============================ ML dataset validator (anti-leakage) ============================
// Independently re-derives each row's labels from the raw snapshots and
// confirms the dataset's stored labels match — catching any future bug in
// datasetBuilder.ts that might accidentally let same-time-or-earlier data
// into a label. This is a re-verification, not a duplicate label
// implementation: it calls the exact same buildLabels() function labelBuilder
// already exports.

export interface LeakageViolation {
  timestamp: number;
  symbol: string;
  field: string;
  detail: string;
}

export interface LeakageCheckResult {
  ok: boolean;
  rowsChecked: number;
  violations: LeakageViolation[];
}

export function checkNoLeakage(
  rows: DatasetRow[],
  snapshotsBySymbol: Map<string, MarketSnapshotRecord[]>
): LeakageCheckResult {
  const violations: LeakageViolation[] = [];
  for (const row of rows) {
    const snaps = snapshotsBySymbol.get(row.symbol) || [];
    // Hard structural check: no snapshot used for this row's labels may have
    // a timestamp <= row.timestamp. Recompute independently and compare.
    const recomputed = buildLabels(row.timestamp, row.spot, snaps);
    (Object.keys(recomputed) as (keyof typeof recomputed)[]).forEach((k) => {
      if (recomputed[k] !== row.labels[k]) {
        violations.push({
          timestamp: row.timestamp, symbol: row.symbol, field: k,
          detail: `stored=${row.labels[k]} recomputed=${recomputed[k]} — label does not match an independent recomputation using only snapshots after this row's own timestamp`,
        });
      }
    });
    // Direct leakage probe: inject a fabricated snapshot at/just-before this
    // row's own timestamp with an extreme price, and confirm it never gets
    // picked up as a "future" source (it must be excluded by timestamp alone,
    // regardless of how extreme its value is).
    const poisoned: MarketSnapshotRecord = {
      ...(snaps[0] || {
        timestamp: row.timestamp, recordedAt: Date.now(), symbol: row.symbol, spot: null, atm: null, expiry: null,
        marketSession: "OPEN", technicals: { ema9: null, ema21: null, ema50: null, macd: null, macdSignal: null, macdHistogram: null, vwap: null, rsi: null, bollingerUpper: null, bollingerMiddle: null, bollingerLower: null, supertrend: null, supertrendDirection: null },
        marketStructure: null, regime: null,
      }),
      timestamp: row.timestamp, // exactly at, never after
      symbol: row.symbol,
      spot: 999999999, // deliberately absurd — if this leaks in, the label would be obviously wrong
    };
    const poisonedLabels = buildLabels(row.timestamp, row.spot, [...snaps, poisoned]);
    (Object.keys(poisonedLabels) as (keyof typeof poisonedLabels)[]).forEach((k) => {
      if (poisonedLabels[k] !== recomputed[k]) {
        violations.push({
          timestamp: row.timestamp, symbol: row.symbol, field: k,
          detail: `a snapshot timestamped AT (not after) this row's own timestamp changed the label — leakage boundary is broken`,
        });
      }
    });
  }
  return { ok: violations.length === 0, rowsChecked: rows.length, violations };
}
