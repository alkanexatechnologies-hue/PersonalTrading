// ============================ Room calculation ============================
// Wall levels (majorSupport/majorResistance) are reused from
// backend/paper/entryRules.ts's levelContext() — the same S/R this app's paper
// engine already trades against — not recomputed here. The minimum-required-room
// floor is relative to the stock's OWN price/volatility (not a fixed point count —
// a flat "25 points" only makes sense for an index, not a ₹300 vs ₹4,000 stock).

import { OTP_CONFIG } from "./config";
import { OptionSide, RoomResult } from "./types";

export function computeRoom(
  side: OptionSide,
  spot: number,
  majorSupport: number | null,
  majorResistance: number | null,
  expectedMovePts: number,
): RoomResult {
  const minRequiredPts = Math.max(expectedMovePts, spot * OTP_CONFIG.room.spotPctFloor);
  const wallStrike = side === "CE" ? majorResistance : majorSupport;
  const distancePts = wallStrike == null ? null : side === "CE" ? wallStrike - spot : spot - wallStrike;
  const ok = distancePts != null && distancePts >= minRequiredPts;
  return { side, distancePts, minRequiredPts: Math.round(minRequiredPts * 100) / 100, ok, wallStrike };
}
