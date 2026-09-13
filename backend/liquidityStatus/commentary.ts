// ============================ Section 1 & 23 — System View, Trader Preparation, safe language ============================
// Reuses the SAME banned-phrase safety net already built and tested for Option
// Top Pick rather than a second, independently-maintained list.

export { BANNED_PHRASES, violatesSafeLanguage } from "../optionTopPick/commentary";
import { Direction, EvidenceRow, Invalidation, KeyLevel, MoveStage, MoveTrigger, VwapStatus } from "./types";

export interface SystemViewInput {
  name: string;
  direction: Direction | "Neutral" | "Conflict";
  evidenceSummary: string;
  vwapStatus: VwapStatus;
  moveStage: MoveStage;
  resistance: KeyLevel;
  support: KeyLevel;
}

export function buildSystemView(input: SystemViewInput): string {
  const { direction, evidenceSummary, vwapStatus, moveStage } = input;
  if (direction === "Conflict") return `${evidenceSummary} Price action and OI structure disagree right now — the view is unclear until they align.`;
  if (direction === "Neutral") return `${evidenceSummary} No clean directional lean yet — market structure is balanced.`;
  const bull = direction === "Bullish";
  const vwapText = bull ? (vwapStatus.startsWith("Above") ? "Spot is above VWAP" : "Spot has not confirmed above VWAP yet") : (vwapStatus.startsWith("Below") ? "Spot is below VWAP" : "Spot has not confirmed below VWAP yet");
  const stageText = moveStage === "STRONG_MOVE" || moveStage === "DEVELOPING"
    ? `momentum is ${moveStage === "STRONG_MOVE" ? "expanding" : "building"}`
    : `movement stage: ${moveStage.replace(/_/g, " ").toLowerCase()}`;
  return `${evidenceSummary} ${vwapText} and ${stageText}. The market is preparing for a possible ${bull ? "upside" : "downside"} continuation.`;
}

export function buildTraderPreparation(direction: Direction | "Neutral" | "Conflict", trigger: MoveTrigger | null, invalidation: Invalidation | null): string {
  if (direction === "Neutral" || direction === "Conflict" || !trigger || !invalidation) {
    return "No clear setup to prepare for right now — wait for confirmation before committing to a side.";
  }
  const bull = direction === "Bullish";
  const zone = trigger.potentialMoveZone;
  return [
    `Watch ${trigger.level} ${bull ? "breakout" : "breakdown"}.`,
    `${bull ? "Above" : "Below"} ${trigger.level} with volume + option confirmation → ${bull ? "upside" : "downside"} continuation setup${zone ? ` (potential move zone ${zone[0]} → ${zone[1]})` : ""}.`,
    `${bull ? "Failure below" : "Reclaim above"} ${invalidation.level} → ${bull ? "bullish" : "bearish"} view weakens.`,
  ].join(" ");
}
