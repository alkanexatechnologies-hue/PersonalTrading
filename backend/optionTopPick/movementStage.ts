// ============================ Movement stage (Parts 7-8) ============================
// Classifies how far today's move already is relative to the stock's OWN normal
// move (its daily ATR%), not an absolute number — a 3% move is "just getting
// going" for a high-ATR stock and "already extended" for a quiet one. Priority
// order below matters: EXTENDED (no-chase) always wins over a fresh breakout
// label, and a real divergence/pullback signal is checked before the plain
// magnitude buckets.

import { OTP_CONFIG } from "./config";
import { MovementStage } from "./types";

export interface MovementStageInput {
  movePct: number; // signed % from today's open to now
  atrPct: number; // daily ATR as % of price — the stock's own "normal move" yardstick
  justCrossedResistance: boolean;
  justCrossedSupport: boolean;
  retracedFromExtremePct: number; // 0..1 — how much of today's extreme has been given back, in the move's own direction
  momentumDiverging: boolean; // price extended but RSI/momentum failing to confirm
}

export function classifyMovementStage(input: MovementStageInput): { stage: MovementStage; ratio: number } {
  const { movement } = OTP_CONFIG;
  const ratio = input.atrPct > 0 ? Math.abs(input.movePct) / input.atrPct : 0;

  if (ratio >= movement.strongMaxRatio) return { stage: "EXTENDED", ratio };
  if (input.momentumDiverging && ratio >= movement.reversalMinRatio) return { stage: "REVERSAL WATCH", ratio };
  if (input.retracedFromExtremePct >= movement.pullbackMinRetrace && ratio >= movement.pullbackMinRatio) return { stage: "PULLBACK", ratio };
  if (input.justCrossedResistance) return { stage: "BREAKOUT", ratio };
  if (input.justCrossedSupport) return { stage: "BREAKDOWN", ratio };
  if (ratio >= movement.movingMaxRatio) return { stage: "STRONG MOVE", ratio };
  if (ratio >= movement.earlyMaxRatio) return { stage: "MOVING", ratio };
  return { stage: "EARLY MOVE", ratio };
}

/** Part 12 — mandatory no-chase: EXTENDED (and REVERSAL WATCH, since a stalling
 * divergence at an extended move is exactly "don't chase") must always force the
 * final decision away from TOP PICK, regardless of how good the scores look. */
export function isNoChaseStage(stage: MovementStage): boolean {
  return stage === "EXTENDED" || stage === "REVERSAL WATCH";
}
