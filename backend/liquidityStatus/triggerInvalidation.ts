// ============================ Sections 10-11 — Move Trigger & Invalidation ============================
import { Direction, Invalidation, KeyLevel, MoveTrigger } from "./types";

export function buildTrigger(direction: Direction | null, resistance: KeyLevel, support: KeyLevel, atrPts: number): MoveTrigger | null {
  if (!direction) return null;
  const level = direction === "Bullish" ? resistance.price : support.price;
  if (level == null) return null;
  const zoneNear = Math.round((level + (direction === "Bullish" ? 1 : -1) * atrPts * 0.3) * 100) / 100;
  const zoneFar = Math.round((level + (direction === "Bullish" ? 1 : -1) * atrPts * 0.9) * 100) / 100;
  return {
    direction: direction === "Bullish" ? "UP" : "DOWN",
    level,
    requiredConfirmation: direction === "Bullish"
      ? ["5-minute close above " + level, "Volume expansion", "CE premium expansion", "Call OI unwinding continues"]
      : ["5-minute close below " + level, "Volume expansion", "PE premium expansion", "Put OI unwinding continues"],
    potentialMoveZone: direction === "Bullish" ? [zoneNear, zoneFar] : [zoneFar, zoneNear],
  };
}

export function buildInvalidation(direction: Direction | null, resistance: KeyLevel, support: KeyLevel): Invalidation | null {
  if (!direction) return null;
  if (direction === "Bullish") {
    if (support.price == null) return null;
    return { level: support.price, warning: `Loss of ${support.price} support with increasing volume would weaken the bullish thesis.` };
  }
  if (resistance.price == null) return null;
  return { level: resistance.price, warning: `Reclaim of ${resistance.price} resistance with increasing volume would weaken the bearish thesis.` };
}
