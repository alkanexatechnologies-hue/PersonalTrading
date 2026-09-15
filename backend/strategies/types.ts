// ============================ Trader Specific Strategies — types ============================
// A read-only "strategy lens" layer that sits AFTER the existing engines. It never
// computes trade math of its own: every field it reasons over is already produced
// by the Master Trade Selector / OI / Liquidity Status / Momentum engines and is
// assembled into a ConditionSnapshot by the route. The layer's only job is to pick,
// each day, which named strategy the CURRENT market condition best matches — and to
// say WAIT when none has a sufficient edge. "Best" = best-supported for today's
// condition, never a profit guarantee.

import { MarketRegime } from "../paper/ext/types";
import { BurstState } from "../types";
import { MoveStage } from "../liquidityStatus/types";

export type StrategyId =
  | "trend_continuation"
  | "squeeze_breakout"
  | "opening_range_breakout"
  | "wall_rejection"
  | "wall_breakout"
  | "pullback_continuation";

export type Bias = "Bullish" | "Bearish" | "Neutral";

// Everything the strategy layer reads about "today's market", all sourced from the
// engines that already ran. Nulls are normal (feed gaps / market closed); the layer
// degrades to WAIT rather than inventing a condition.
export interface ConditionSnapshot {
  symbol: string;
  istDate: string;                 // YYYY-MM-DD (IST)
  regime: MarketRegime | null;     // Trending / Compressed / Transitioning
  regimeDir: "up" | "down" | "flat" | null;
  burstState: BurstState | null;   // Squeeze / Fired Up|Down / Expanding Up|Down / Quiet / Normal
  moveStage: MoveStage | null;     // Liquidity Status move stage
  directionBias: Bias | null;      // liquidity/directional bias
  openingBias: Bias | null;        // first-30-min opening bias (null outside window)
  withinFirst30: boolean;
  sentimentState: "Bullish" | "Bearish" | "Neutral" | "Conflicted" | null;
  wallReactionState: "REJECT" | "BREAK" | "UNCLEAR" | null;
  atWall: boolean;
  liquidityState: "Normal" | "Thin" | null;
  spot: number | null;
  expectedMovePts: number | null;
  wallSupport: number | null;
  wallResistance: number | null;
  masterVerdict: string | null;    // GO / WAIT / CONFLICT from the Master Trade Selector arbiter
  dataStale: boolean;
}

export type StrategyQuality = "HIGH" | "MEDIUM" | "LOW";
export type StrategyTier = "PREFERRED" | "ALTERNATIVE" | "NOT_SUITABLE";

// How well today's condition matches a strategy's fingerprint (0..100), plus whether
// the strategy's hard prerequisites are even present today.
export interface StrategyMatch {
  match: number;      // 0..100
  eligible: boolean;  // prerequisites present (else it can never be today's pick)
  why: string[];      // trader-facing reasons (shown under WHY IT MATCHES)
}

// Measurable historical edge for a strategy IN SIMILAR CONDITIONS. edgeWeight is a
// multiplier on the condition-match; it is 1.0 (neutral) until enough validated
// history exists, so a cold install ranks on condition-match alone — clearly labelled.
export interface StrategyEvidence {
  sufficientHistory: boolean;
  sampleSize: number;
  hitRate: number | null;   // resolved-correct / resolved, in similar conditions
  edgeWeight: number;       // ~0.6..1.4; 1.0 when insufficient history
  note: string;
}

export interface RankedStrategy {
  id: StrategyId;
  name: string;             // trader-facing
  blurb: string;
  match: number;            // 0..100 condition-match
  eligible: boolean;
  why: string[];
  requiredConfirmation: string;
  trigger: string;
  invalidation: string;
  evidence: StrategyEvidence;
  score: number;            // match * edgeWeight, clamped 0..100
  quality: StrategyQuality;
  tier: StrategyTier;
}

export interface DailySelection {
  symbol: string;
  istDate: string;
  condition: { label: string; regime: MarketRegime | null; detail: string };
  preferred: RankedStrategy | null;   // null => NO SUITABLE STRATEGY TODAY
  ranking: RankedStrategy[];          // desc by score
  gate: { threshold: number; passed: boolean };
  historySufficient: boolean;
  expectedMove: { points: number | null; label: string };
  masterAction: string;               // reflects the Master Trade Selector verdict (never overrides it)
  locked: boolean;                    // the day's preferred strategy is locked for the session
  generatedAt: number;
  note: string;
}

// Injected into the pure selector so it never reads files itself (keeps it testable).
export type EvidenceLookup = (id: StrategyId, snap: ConditionSnapshot) => StrategyEvidence;
