import "./aiConfig";
import { MarketSnapshotRecord } from "../data/tradingDataTypes";

// ============================ Label builder — ANTI-LEAKAGE BOUNDARY ============================
// This is the ONE place a label (a future return) is computed. The rule that
// makes it safe: a snapshot is only ever eligible to produce a label for
// `currentTimestamp` if its own timestamp is STRICTLY GREATER than
// `currentTimestamp` (line marked below). A label is left null - never
// estimated/interpolated/backfilled - when no snapshot with timestamp >=
// target (within tolerance) exists yet. See featureSchema.test.ts /
// labelBuilder.test.ts for the automated tests this file's contract is
// checked against.

const HORIZON_MINUTES = [5, 15, 30, 60] as const;
type HorizonMinutes = (typeof HORIZON_MINUTES)[number];

// How far past the exact target minute we'll accept the nearest available
// snapshot (the recorder polls opportunistically, not on a fixed timer).
const TOLERANCE_SEC = 5 * 60;

export interface Labels {
  return5m: number | null;
  return15m: number | null;
  return30m: number | null;
  return60m: number | null;
}

function pctReturn(fromSpot: number, toSpot: number): number {
  return Math.round(((toSpot - fromSpot) / fromSpot) * 10000) / 100; // percent, 2dp
}

function findFutureSpotForHorizon(
  currentTimestamp: number,
  minutesAhead: HorizonMinutes,
  allSnapshotsForSymbolSorted: MarketSnapshotRecord[]
): number | null {
  const targetTime = currentTimestamp + minutesAhead * 60;
  let best: MarketSnapshotRecord | null = null;
  for (const s of allSnapshotsForSymbolSorted) {
    // ANTI-LEAKAGE: only timestamps strictly after currentTimestamp are ever
    // eligible - never `>=`, so a snapshot recorded at the exact same moment
    // (shouldn't exist given write-time dedup, but checked defensively) can
    // never be used as its own future label.
    if (s.timestamp <= currentTimestamp) continue;
    if (s.timestamp < targetTime) continue;
    if (s.timestamp - targetTime > TOLERANCE_SEC) continue;
    if (best == null || s.timestamp < best.timestamp) best = s;
  }
  return best?.spot ?? null;
}

// `allSnapshotsForSymbolSorted` should be every known snapshot for this
// symbol (any order is fine - not assumed pre-sorted internally, but pass
// sorted for O(n) instead of this function's current O(n) scan per horizon
// anyway being fine at today's data volumes).
export function buildLabels(
  currentTimestamp: number,
  currentSpot: number | null,
  allSnapshotsForSymbolSorted: MarketSnapshotRecord[]
): Labels {
  const out: Partial<Record<`return${HorizonMinutes}m`, number | null>> = {};
  for (const h of HORIZON_MINUTES) {
    const futureSpot = currentSpot != null ? findFutureSpotForHorizon(currentTimestamp, h, allSnapshotsForSymbolSorted) : null;
    out[`return${h}m`] = futureSpot != null && currentSpot != null ? pctReturn(currentSpot, futureSpot) : null;
  }
  return out as Labels;
}
