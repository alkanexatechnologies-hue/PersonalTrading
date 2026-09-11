// ---- Step 9: tradeDedup.ts ----
// Last filter before emission (runs AFTER tradeScore + the display threshold).
//
// Fingerprint: mode + direction + strike + roundedEntryZone + wallReference.
// A fingerprint is SUPPRESSED from re-firing until either:
//   - its exit condition hits (the existing exit stack — call releaseOnExit), or
//   - price moves away from the entry zone by an ATR-based distance and back
//     (armed then re-cleared — call observePrice each mark).
//
// After an exit, re-entry at the SAME wall is only allowed if wallReactionState
// changed, marketRegime changed, or the wall shifted strike / lost heaviest-OI
// status; otherwise the fingerprint stays suppressed.
//
// State is passed in/out (persisted inside PaperState) so the engine stays the
// single owner of persistence.

import { MarketRegime, WallReactionState } from "./types";
import { CONFIG } from "../../config/arbitration";

export interface DedupRecord {
  fp: string;                 // fingerprint key
  openedAt: number;           // epoch when suppression armed (entry)
  entryZone: number;          // rounded entry price zone
  atrDist: number;            // ATR-based distance defining "moved away"
  wallRef: number | null;     // wall strike/level referenced at entry
  wallReaction: WallReactionState;
  regime: MarketRegime;
  wallHeaviest: boolean;      // was the wall the heaviest-OI strike at entry
  status: "open" | "exited";  // open = position live; exited = closed, awaiting re-arm rules
  movedAway: boolean;         // price left the entry zone by >= atrDist since exit
}

export interface DedupContext {
  mode: "directional" | "scalp";
  direction: "Bullish" | "Bearish";
  strike: number;
  entryPrice: number;
  atr: number;                // underlying ATR (defines zone + move-away distance)
  wallRef: number | null;
  wallReaction: WallReactionState;
  regime: MarketRegime;
  wallHeaviest: boolean;
}

const ZONE_ATR_FRAC = 0.25; // entry "zone" width = 25% of ATR

function roundZone(price: number, atr: number): number {
  const step = Math.max(0.01, atr * ZONE_ATR_FRAC);
  return Math.round(price / step) * step;
}

export function fingerprint(ctx: DedupContext): string {
  const zone = roundZone(ctx.entryPrice, ctx.atr);
  return [ctx.mode, ctx.direction, ctx.strike, Math.round(zone), ctx.wallRef == null ? "noWall" : Math.round(ctx.wallRef)].join("|");
}

/**
 * Decide whether a candidate may be emitted.
 * Returns { allowed, fp, record } — when allowed, the caller should push `record`
 * into the dedup store (arming suppression). When not allowed, `reason` explains.
 */
export function checkDedup(
  ctx: DedupContext,
  store: DedupRecord[],
  nowEpoch: number,
): { allowed: boolean; fp: string; reason: string; record?: DedupRecord } {
  const fp = fingerprint(ctx);
  const existing = store.find((r) => r.fp === fp);

  const record: DedupRecord = {
    fp,
    openedAt: nowEpoch,
    entryZone: roundZone(ctx.entryPrice, ctx.atr),
    atrDist: Math.max(0.01, ctx.atr * CONFIG.dedup.atrDistanceMultiplier),
    wallRef: ctx.wallRef,
    wallReaction: ctx.wallReaction,
    regime: ctx.regime,
    wallHeaviest: ctx.wallHeaviest,
    status: "open",
    movedAway: false,
  };

  if (!existing) return { allowed: true, fp, reason: "new fingerprint", record };

  if (existing.status === "open") {
    return { allowed: false, fp, reason: "fingerprint still open (position live)" };
  }

  // status === "exited": re-entry only after a genuine change OR a move-away-and-return.
  const wallChanged = existing.wallReaction !== ctx.wallReaction;
  const regimeChanged = existing.regime !== ctx.regime;
  const wallShifted = existing.wallRef !== ctx.wallRef || (existing.wallHeaviest && !ctx.wallHeaviest);
  if (wallChanged || regimeChanged || wallShifted || existing.movedAway) {
    return { allowed: true, fp, reason: `re-arm ok (${wallChanged ? "wallReaction " : ""}${regimeChanged ? "regime " : ""}${wallShifted ? "wallShift " : ""}${existing.movedAway ? "moved-away " : ""}changed)`, record };
  }
  return { allowed: false, fp, reason: "suppressed (no wallReaction/regime/wall change, no move-away)" };
}

/** Arm suppression for an opened trade. Replaces any prior record for the fp. */
export function armDedup(store: DedupRecord[], record: DedupRecord): DedupRecord[] {
  const next = store.filter((r) => r.fp !== record.fp);
  next.push(record);
  return next.slice(-200); // bound memory
}

/** Mark a fingerprint's position as exited (does NOT delete it — re-arm rules apply). */
export function releaseOnExit(store: DedupRecord[], fp: string): void {
  const r = store.find((x) => x.fp === fp);
  if (r) { r.status = "exited"; r.movedAway = false; }
}

/**
 * Observe the latest underlying price for exited fingerprints and flag when price
 * has moved away from the entry zone by >= atrDist (the "move away" half of
 * move-away-and-return). Re-entry then becomes eligible on the next return.
 */
export function observePrice(store: DedupRecord[], price: number): void {
  for (const r of store) {
    if (r.status === "exited" && !r.movedAway) {
      if (Math.abs(price - r.entryZone) >= r.atrDist) r.movedAway = true;
    }
  }
}
