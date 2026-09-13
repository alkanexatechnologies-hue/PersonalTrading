// ============================ Liquidity Status — shared types ============================
// Trader-first liquidity + market-move intelligence. Distinct from (and does not
// duplicate) two other things already called "liquidity" in this app:
//   - backend/optionTopPick/liquidityDirectionalScore.ts — a stock-OPTION-pick
//     scoring track, not a level/sweep engine.
//   - backend/paper/ext/liquidityGuard.ts — order-book "thinness" sizing input.
// This module answers "what is the market doing and where" for ANY symbol
// (index or stock), independent of picking a tradeable option. Advisory only.

import { Direction, EmaStructure, VwapStatus } from "../optionTopPick/types";
import { LiquidityLevel, OpeningRange } from "../liquidity/liquidityLevels";
import { DetectionResult } from "../liquidity/sweepDetector";

export { Direction, EmaStructure, VwapStatus };

/** Section 4/5 — one canonical movement-stage machine covering both sections'
 * vocabulary (Section 5's CONTINUATION is represented as DEVELOPING/STRONG_MOVE
 * plus `continuationLikely: true`; BREAKOUT/BREAKDOWN WATCH is the separate
 * `trigger` object in Section 10, not a stage of its own — avoids encoding the
 * same "approaching a level" idea in two places at once). */
export type MoveStage =
  | "PRE_MOVE" | "EARLY_MOVE" | "DEVELOPING" | "STRONG_MOVE"
  | "EXTENDED" | "EXHAUSTION" | "REVERSAL_WATCH" | "PULLBACK";

export type LiquidityShiftState = "Neutral" | "Bullish" | "Bearish" | "Strong Bullish" | "Strong Bearish" | "Conflict";

/** Section 25 signal-quality bucket — never presented as a probability. */
export type SignalQuality = "VERY STRONG" | "STRONG" | "MODERATE" | "WEAK" | "CONFLICT" | "NO SIGNAL";

export type TraderAction =
  | "PREPARE FOR BUY" | "PREPARE FOR SELL" | "WAIT FOR BREAKOUT" | "WAIT FOR BREAKDOWN"
  | "WAIT FOR PULLBACK" | "WATCH" | "NO TRADE" | "AVOID CHASING" | "REDUCE RISK" | "HOLD EXISTING POSITION";

/** Section 2/18 — one leg's evidence row. Interpretation is a LABEL derived from
 * a formula, never a claim of having observed an actual institutional order. */
export type EvidenceInterpretation =
  | "PUT WRITING / SUPPORT BUILDING" | "PUT UNWINDING" | "CALL WRITING / RESISTANCE BUILDING" | "CALL UNWINDING"
  | "ACCUMULATION HINT" | "ABSORPTION HINT" | "POSITIONING CHANGE" | "NO CLEAR EVIDENCE";

export interface EvidenceRow {
  side: "PUT" | "CALL";
  strike: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
  premiumChangePct: number | null;
  volumeMultiple: number | null; // vs this leg's own recent average, when available
  interpretation: EvidenceInterpretation;
}

export interface KeyLevel {
  label: "KEY SUPPORT" | "SECOND SUPPORT" | "KEY RESISTANCE" | "SECOND RESISTANCE";
  price: number | null;
  oi: number | null;
  oiChange: number | null;
  strength: "STRONG" | "MODERATE" | "WEAKENING" | "UNKNOWN";
  distancePts: number | null; // signed distance FROM spot TO this level
}

export interface LiquidityFlowScoreBreakdown {
  label: string; weightPct: number; contribution: number;
}
export interface LiquidityFlowScore { score: number; breakdown: LiquidityFlowScoreBreakdown[] }

export interface DirectionalConfidence {
  direction: Direction | "Neutral" | "Conflict";
  score: number; // 0..100 — signal AGREEMENT, never a probability of profit
  quality: SignalQuality;
}

export interface ConfirmationItem { label: string; confirmed: boolean }
export interface ConfirmationChecklist { confirmed: ConfirmationItem[]; remaining: ConfirmationItem[] }

export interface EarlyWarning { text: string; severity: "info" | "warn" }

export interface MoveTrigger {
  direction: "UP" | "DOWN";
  level: number | null;
  requiredConfirmation: string[];
  potentialMoveZone: [number, number] | null; // explicitly NOT a guaranteed target
}

export interface Invalidation { level: number | null; warning: string }

export interface LiquidityShiftEvent {
  timestamp: number;
  previous: LiquidityShiftState;
  current: LiquidityShiftState;
  reason: string;
}

export interface TimeSeriesPoint { time: string; state: LiquidityShiftState }

export interface DataFreshness {
  priceAgeSec: number;
  optionAgeSec: number | null;
  oiAgeSec: number | null;
  oiStale: boolean; // > 90s, same threshold as /oi-command
  liveFeedStale: boolean; // > 30s, same threshold as growwSignalsAllowed()
}

export interface LiquidityConflict { conflict: boolean; reason: string | null }

export interface LiquidityStatusResult {
  symbol: string;
  name: string;
  spot: number;
  atmStrike: number | null;

  liquidityShift: LiquidityShiftState;
  moveStage: MoveStage;
  continuationLikely: boolean;
  directionBias: Direction | "Neutral" | "Conflict";
  moveStrength: number; // 0..100, same scale as LiquidityFlowScore.score
  systemView: string;
  traderPreparation: string;

  evidence: EvidenceRow[];
  keyLevels: KeyLevel[];
  distanceToSupportPts: number | null;
  distanceToResistancePts: number | null;

  liquidityFlowScore: LiquidityFlowScore;
  directionalConfidence: DirectionalConfidence;
  confirmations: ConfirmationChecklist;
  battlefield: { support: KeyLevel; spot: number; resistance: KeyLevel };

  trigger: MoveTrigger | null;
  invalidation: Invalidation | null;
  traderAction: TraderAction;
  traderActionDetail: string;

  earlyWarnings: EarlyWarning[];
  shiftHistory: TimeSeriesPoint[];
  lastShiftEvent: LiquidityShiftEvent | null;
  conflict: LiquidityConflict;

  structure: { ema9: number | null; ema21: number | null; ema50: number | null; emaStructure: EmaStructure; vwapStatus: VwapStatus; vwapValue: number | null };
  detection: DetectionResult;
  openingRange: OpeningRange;
  levels: LiquidityLevel[];

  freshness: DataFreshness;
  generatedAt: number;
  disclaimer: string;
}

export interface StockLiquiditySummary {
  symbol: string; name: string;
  liquidityFlow: SignalQuality;
  direction: Direction | "Neutral" | "Conflict";
  moveStage: MoveStage;
  score: number;
}

export interface LiquidityStatusScanResult {
  topMovers: StockLiquiditySummary[];
  scannedCount: number;
  eligibleCount: number;
  generatedAt: number;
  disclaimer: string;
}

export interface LiquidityStatusDeps {
  getCandles(symbol: string, interval: "1m" | "5m" | "15m" | "1d"): Promise<import("../types").Candle[]>;
  getOi(symbol: string): Promise<import("../types").OiAnalysis | null>;
  listEligibleStocks(): import("../config").SymbolDef[];
  nowEpochSec(): number;
}
