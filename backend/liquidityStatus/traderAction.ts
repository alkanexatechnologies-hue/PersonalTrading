// ============================ Section 12 — Trader Action ============================
import { isNoChaseStage } from "./moveStage";
import { ConfirmationChecklist, Direction, LiquidityConflict, MoveStage, TraderAction } from "./types";

export interface TraderActionInput {
  direction: Direction | "Neutral" | "Conflict" | null;
  moveStage: MoveStage;
  conflict: LiquidityConflict;
  confirmations: ConfirmationChecklist;
  triggerAlreadyCrossed: boolean;
}

export function decideTraderAction(input: TraderActionInput): { action: TraderAction; detail: string } {
  if (isNoChaseStage(input.moveStage)) {
    return { action: "AVOID CHASING", detail: "Move already extended — avoid chasing. Wait for a controlled pullback/retest." };
  }
  if (input.conflict.conflict) {
    return { action: "WATCH", detail: (input.conflict.reason ?? "Signals conflict.") + " Wait for the conflict to resolve." };
  }
  if (input.direction == null || input.direction === "Neutral" || input.direction === "Conflict") {
    return { action: "NO TRADE", detail: "No confirmed direction — no trade preferred over a low-quality one." };
  }
  if (input.moveStage === "PULLBACK") {
    return { action: "WAIT FOR PULLBACK", detail: "Structure remains directional, but price has retraced — waiting for confirmation on the retest." };
  }
  if (input.moveStage === "PRE_MOVE" || input.moveStage === "EARLY_MOVE") {
    return { action: "WATCH", detail: "Too early for a confirmed setup — monitoring for developing confirmation." };
  }
  const bull = input.direction === "Bullish";
  if (!input.triggerAlreadyCrossed) {
    return {
      action: bull ? "WAIT FOR BREAKOUT" : "WAIT FOR BREAKDOWN",
      detail: `Do not chase current price. Wait for a confirmed ${bull ? "breakout" : "breakdown"}.`,
    };
  }
  if (input.confirmations.remaining.length === 0) {
    return { action: bull ? "PREPARE FOR BUY" : "PREPARE FOR SELL", detail: "All tracked confirmations are in place." };
  }
  return { action: "WATCH", detail: `Trigger crossed, but ${input.confirmations.remaining.length} confirmation(s) still pending.` };
}
