// ============================ Option Top Pick — shared types ============================
// Option Top Pick = BEST STOCK OPTION PICK: scans the F&O equity universe for the
// strongest stock-option opportunities, split into two never-merged strategies
// (Liquidity Directional vs Stock Setup — see liquidityDirectionalScore.ts /
// stockSetupScore.ts). Advisory only (AI_MODE=ADVISORY_ONLY, LIVE_ORDER_EXECUTION=
// false stay enforced app-wide) — never places or simulates an order.

import { Candle, OiAnalysis } from "../types";
import { MarketRegime } from "../paper/ext/types";
import { SymbolDef } from "../config";

export type OptionSide = "CE" | "PE";
export type Direction = "Bullish" | "Bearish";

/** One weighted, explainable factor contributing to a score. */
export interface Vote {
  name: string;
  bias: "bullish" | "bearish" | "neutral";
  weight: number;
  reason: string;
}

export interface DirectionScoreResult {
  ceScore: number;
  peScore: number;
  maxScore: number;
  ceVotes: Vote[];
  peVotes: Vote[];
}

export type OiLegAction = "Call writing" | "Call unwinding" | "Put writing" | "Put unwinding" | "Unclear";

export interface WallInfo {
  strike: number | null;
  oiChg: number | null;
  veryHigh: boolean;
  label: string;
}

export interface OiInterpretation {
  callResistanceWall: WallInfo | null;
  putSupportWall: WallInfo | null;
  atmAction: { ce: OiLegAction; pe: OiLegAction };
  oiVerdict: "Bullish" | "Bearish" | "Neutral" | "TWO_SIDED";
  oiConfidence: number; // 0..100
  oiReasons: string[];
  pcr: number | null;
  pcrState: "bullish" | "bearish" | "neutral";
  hasBaseline: boolean;
}

/** Section 4A wording — never "smart money"; a formula-based liquidity/flow read. */
export type LiquidityFlowLabel = "Liquidity Flow Strong" | "Liquidity Expansion" | "Directional Flow Bias" | "No Liquidity Signal";

export type EmaStructure = "Strong Bullish" | "Strong Bearish" | "Mixed";
export type VwapStatus = "Above+Rising" | "Below+Falling" | "Above+Flat" | "Below+Flat" | "Choppy";

export interface StructureFacts {
  emaStructure: EmaStructure;
  ema9: number | null; ema21: number | null; ema50: number | null;
  vwapStatus: VwapStatus;
  vwapValue: number | null;
  regime: MarketRegime | null;
  regimeDir: -1 | 0 | 1;
}

export type MovementStage =
  | "EARLY MOVE" | "MOVING" | "STRONG MOVE" | "EXTENDED"
  | "PULLBACK" | "BREAKOUT" | "BREAKDOWN" | "REVERSAL WATCH";

export interface GateCheck { name: string; pass: boolean; detail: string }
export interface GateResult { allPass: boolean; checks: GateCheck[]; failedNames: string[] }

export interface RoomResult {
  side: OptionSide;
  distancePts: number | null;
  minRequiredPts: number;
  ok: boolean;
  wallStrike: number | null;
}

export interface LevelsResult {
  entry: number;
  target1: number;
  target2: number;
  stop: number;
  riskReward: number | null; // e.g. 3 for "1:3"
}

export type StrategyTrack = "LIQUIDITY_DIRECTIONAL" | "STOCK_SETUP";
export type FinalDecision = "TOP PICK" | "WATCH" | "WAIT FOR PULLBACK" | "EXTENDED — DO NOT CHASE" | "NO EDGE" | "AVOID";

export interface SelectedOption {
  side: OptionSide;
  strike: number;
  expiry: string | null;
  ltp: number | null;
  oi: number | null;
  volume: number | null;
}

export interface DataFreshness {
  dataTimestamp: number;
  oiTimestamp: number | null;
  dataAgeSec: number;
  oiAgeSec: number | null;
  oiStale: boolean;
}

export interface QualityScoreResult {
  score: number; // 0..100
  breakdown: { label: string; weightPct: number; contribution: number }[];
}

/** One ranked candidate on ONE track. A stock can appear on both tracks as two
 * separate candidates — they are never merged into a single score (Part 5). */
export interface StockCandidate {
  symbol: string;
  name: string;
  sector?: string;
  track: StrategyTrack;
  direction: Direction | null;
  spot: number;
  movePct: number; // % move from today's open
  movementStage: MovementStage;
  decision: FinalDecision;
  qualityScore: QualityScoreResult;
  selectedOption: SelectedOption | null;
  levels: LevelsResult | null;
  room: RoomResult | null;
  structure: StructureFacts;
  oi: OiInterpretation;
  liquidityFlow: { label: LiquidityFlowLabel; rvol: number | null; premiumChangePct: number | null } | null; // only on the Liquidity Directional track
  gates: GateResult;
  reasons: string[];
  commentary: string;
  freshness: DataFreshness;
}

export interface OptionTopPickScanResult {
  liquidityDirectional: StockCandidate[];
  stockSetup: StockCandidate[];
  scannedCount: number;
  eligibleCount: number;
  generatedAt: number;
  disclaimer: string;
}

/** Everything the scanner needs from the rest of the app, injected by the caller
 * (routes/api.ts) so this module never imports upward from routes/ (circular). */
export interface OptionTopPickDeps {
  listEligibleStocks(): SymbolDef[];
  getCandles(symbol: string, interval: "5m" | "15m" | "1d"): Promise<Candle[]>;
  /** Returns null (not throws) when the chain is genuinely unavailable for this stock. */
  getOi(symbol: string): Promise<OiAnalysis | null>;
  nowEpochSec(): number;
}
