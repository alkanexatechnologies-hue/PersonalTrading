// ============================ Commentary + safety language (Part 16 & 25) ============================
// Explains the decision in plain trader language, built entirely from the already-
// computed facts. This is a decision-support engine, not a promise — the banned-
// phrase list is enforced by a test so no future edit can quietly reintroduce a
// "guaranteed"/"sure-shot" style claim.

import { Direction, EmaStructure, FinalDecision, LiquidityFlowLabel, MovementStage, StrategyTrack, VwapStatus } from "./types";

export const BANNED_PHRASES: RegExp[] = [
  /guarantee/i, /sure[- ]?shot/i, /\bdefinitely\b/i, /\bwill (definitely|surely) (go|move|rise|fall)/i,
  /\d+\s*%\s*accuracy/i, /smart money (is |definitely )?buying/i, /risk[- ]?free/i, /100\s*%\s*(win|profit|accuracy)/i,
];

export function violatesSafeLanguage(text: string): string | null {
  for (const re of BANNED_PHRASES) if (re.test(text)) return re.source;
  return null;
}

export interface CommentaryInput {
  name: string;
  track: StrategyTrack;
  direction: Direction | null;
  decision: FinalDecision;
  movementStage: MovementStage;
  vwapStatus: VwapStatus;
  emaStructure: EmaStructure;
  liquidityLabel: LiquidityFlowLabel | null;
  qualityScore: number;
  reasons: string[];
}

export function buildCommentary(input: CommentaryInput): string {
  const { name, track, direction, decision, movementStage, vwapStatus, emaStructure, liquidityLabel, qualityScore, reasons } = input;

  if (decision === "NO EDGE") {
    return `${name}: no real edge either way right now (${reasons[0] ?? "signals are mixed or too weak"}). System bias: neutral. No trade preferred over a low-quality one.`;
  }
  if (decision === "AVOID") {
    return `${name}: ${reasons.join("; ") || "signals conflict with each other"}. System bias: unclear — avoiding a low-confidence entry.`;
  }
  if (decision === "EXTENDED — DO NOT CHASE") {
    return `${name} has already made a large move and is extended (${movementStage}). Move already extended — avoid chasing.`;
  }
  if (decision === "WAIT FOR PULLBACK") {
    return `${name}'s structure remains ${direction?.toLowerCase() ?? "directional"}, but the option premium is already extended since this signal formed. Pullback opportunity — waiting for confirmation.`;
  }
  if (decision === "WATCH") {
    return `${name} is ${track === "LIQUIDITY_DIRECTIONAL" ? "showing an early liquidity/flow lean" : "developing a technical setup"} (${direction ?? "no clear side yet"}), but confirmation isn't complete — worth watching, not yet a Top Pick. Signal strength: ${qualityScore}/100.`;
  }

  // TOP PICK
  const bull = direction === "Bullish";
  const sentences: string[] = [];
  if (track === "LIQUIDITY_DIRECTIONAL") {
    sentences.push(`${name} is showing ${liquidityLabel ?? "a liquidity/flow signal"} with price ${bull ? "above" : "below"} VWAP and ${bull ? "bullish" : "bearish"} EMA alignment.`);
    sentences.push(movementStage === "STRONG MOVE" || movementStage === "BREAKOUT"
      ? "The stock is already moving, but structure and liquidity confirm continuation potential."
      : `Movement stage: ${movementStage}.`);
  } else {
    sentences.push(`${name} has a ${emaStructure.toLowerCase()} EMA structure with price ${bull ? "above" : "below"} VWAP — a regular technical Stock Setup.`);
    sentences.push("Liquidity/OI confirmation is not required for this track, and is not being claimed here.");
  }
  sentences.push(`Signal strength / confidence score: ${qualityScore}/100 — how well the signals line up right now, not a promise of what happens next.`);
  sentences.push(`System therefore prefers ${bull ? "CE" : "PE"}.`);
  return sentences.join(" ");
}
