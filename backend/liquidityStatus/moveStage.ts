// ============================ Sections 4-5 — Market Move / Move Status ============================
// One canonical state machine (see types.ts's MoveStage comment for how Section
// 5's overlapping vocabulary maps onto it). Relative to the symbol's OWN daily
// ATR% — a flat percentage-gain threshold is explicitly rejected by the spec
// ("+4.2% does NOT automatically mean Strong Buy").

import { LS_CONFIG } from "./config";
import { MoveStage } from "./types";

export interface MoveStageInput {
  movePct: number; // signed % from a stable reference (today's open) to now
  atrPct: number; // daily ATR as % of price
  rvol: number | null;
  oiConfirming: boolean; // does OI structure agree with the move's own direction
  premiumConfirming: boolean; // does option premium agree with the move's own direction
  retracedFromExtremePct: number; // 0..1, given back from today's extreme, in the move's own direction
  momentumDiverging: boolean;
}

export interface MoveStageResult { stage: MoveStage; ratio: number; continuationLikely: boolean; confirmCount: number }

export function classifyMoveStage(input: MoveStageInput): MoveStageResult {
  const m = LS_CONFIG.movement;
  const ratio = input.atrPct > 0 ? Math.abs(input.movePct) / input.atrPct : 0;
  const confirmCount = [
    input.rvol != null && input.rvol >= LS_CONFIG.rvol.expansion,
    input.oiConfirming,
    input.premiumConfirming,
  ].filter(Boolean).length;

  let stage: MoveStage;
  if (ratio >= m.exhaustionMinRatio && input.momentumDiverging) stage = "EXHAUSTION";
  else if (ratio >= m.strongMaxRatio) stage = "EXTENDED";
  else if (input.momentumDiverging && ratio >= m.reversalMinRatio) stage = "REVERSAL_WATCH";
  else if (input.retracedFromExtremePct >= m.pullbackMinRetrace && ratio >= m.pullbackMinRatio) stage = "PULLBACK";
  else if (ratio >= m.developingMaxRatio) stage = "STRONG_MOVE";
  else if (ratio >= m.earlyMaxRatio) stage = "DEVELOPING";
  else if (ratio >= m.preMoveMaxRatio) stage = "EARLY_MOVE";
  else stage = "PRE_MOVE";

  const continuationLikely = (stage === "STRONG_MOVE" || stage === "DEVELOPING") && confirmCount >= 2 && !input.momentumDiverging;
  return { stage, ratio, continuationLikely, confirmCount };
}

/** Section 12's "no-chase" trigger: an already-extended or exhausting move must
 * never come back as PREPARE FOR BUY/SELL, regardless of how good other signals look. */
export function isNoChaseStage(stage: MoveStage): boolean {
  return stage === "EXTENDED" || stage === "EXHAUSTION";
}
