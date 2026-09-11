// ---- Step 7: tradeScore.ts ----
// The composite scorer. Order of operations is EXACT and must not be reordered:
//
//   baseTrigger = OI TAKE verdict AND 1h bulletin agreement   (hard gate)
//   if !baseTrigger            -> no trade
//   if premiumState==Decaying  -> no trade   (hard suppress, explicit early-return)
//   score  = baseConfidence    (existing 52–62% calibrated win-prob; source unchanged)
//   score += regime-vs-wallReaction match bonus
//   score += sentiment agreement bonus (0 if Conflicted/opposed; if opposed also
//            tighten required reward:risk to 1.5)
//   score += premiumState==Favorable bonus
//   score -= liquidity==Thin penalty
//   score += openingBias agreement bonus (only within first 30 min)
//   finalScore = clamp(score, 52, 62)   (ceiling/floor unchanged; boosts cannot pass 62)
//
// setupQuality (0–100) is a SEPARATE clarity score: regime clarity + liquidity
// state + wallReaction clarity (not UNCLEAR) + sentiment agreement/conflict.

import {
  MarketRegime, LiquidityState, SentimentState, PremiumState, WallReactionState, OpeningBiasState, UnderlyingBias, clamp,
} from "./types";
import { CONFIG } from "../../config/arbitration";

export interface TradeScoreInputs {
  baseTrigger: boolean;
  baseConfidence: number; // calibrated win-probability (52..62)
  direction: UnderlyingBias;

  premiumState: PremiumState;
  regime: MarketRegime;
  wallReaction: WallReactionState;

  sentimentState: SentimentState;
  liquidityState: LiquidityState;

  openingBias?: OpeningBiasState;
  withinFirst30?: boolean;
}

export interface TradeScoreResult {
  finalScore: number;   // clamped 52..62
  setupQuality: number; // 0..100
  vetoed: boolean;      // premiumState==Decaying
  baseTriggerPassed: boolean;
  rrFloorOverride: number | null; // 1.5 when sentiment is opposed, else null
  reasons: string[];
}

// Bonus/penalty sizes are deliberately small: the 52–62 clamp is the real
// governor, so no stack of boosts can inflate a weak edge past the ceiling.
const B_REGIME_WALL = 4;
const B_SENTIMENT = 3;
const B_PREMIUM_FAV = 3;
const P_LIQ_THIN = 4;
const B_OPENING = 2; // reduced weight — openingBias is untrusted until backtested

const FLOOR = CONFIG.tradeScore.floor;
const CEIL = CONFIG.tradeScore.ceiling;

function sentimentAgrees(state: SentimentState, dir: UnderlyingBias): boolean {
  return (state === "Bullish" && dir === "Bullish") || (state === "Bearish" && dir === "Bearish");
}
function sentimentOpposed(state: SentimentState, dir: UnderlyingBias): boolean {
  return (state === "Bullish" && dir === "Bearish") || (state === "Bearish" && dir === "Bullish");
}

export function computeTradeScore(inp: TradeScoreInputs): TradeScoreResult {
  const reasons: string[] = [];

  // Hard gate 1: baseTrigger (OI TAKE + 1h bulletin).
  if (!inp.baseTrigger) {
    return { finalScore: 0, setupQuality: 0, vetoed: false, baseTriggerPassed: false, rrFloorOverride: null, reasons: ["no baseTrigger (OI TAKE + 1h)"] };
  }

  // Hard gate 2: Decaying premium is an outright veto (early-return, not a penalty).
  if (inp.premiumState === "Decaying") {
    return { finalScore: 0, setupQuality: 0, vetoed: true, baseTriggerPassed: true, rrFloorOverride: null, reasons: ["VETO premiumState=Decaying"] };
  }

  let score = inp.baseConfidence;

  // regime <-> wallReaction match.
  const regimeWallMatch =
    (inp.regime === "Trending" && inp.wallReaction === "BREAK") ||
    (inp.regime === "Compressed" && inp.wallReaction === "REJECT");
  if (regimeWallMatch) { score += B_REGIME_WALL; reasons.push(`+${B_REGIME_WALL} regime/${inp.wallReaction} match`); }

  // sentiment agreement (withheld, not penalised, on Conflicted/opposed).
  const opposed = sentimentOpposed(inp.sentimentState, inp.direction);
  if (sentimentAgrees(inp.sentimentState, inp.direction)) { score += B_SENTIMENT; reasons.push(`+${B_SENTIMENT} sentiment agrees`); }
  else if (opposed) reasons.push("sentiment opposed (bonus withheld · RR floor -> 1.5)");
  else if (inp.sentimentState === "Conflicted") reasons.push("sentiment conflicted (bonus withheld)");

  // premium favorable.
  if (inp.premiumState === "Favorable") { score += B_PREMIUM_FAV; reasons.push(`+${B_PREMIUM_FAV} premium Favorable`); }

  // liquidity thin penalty.
  if (inp.liquidityState === "Thin") { score -= P_LIQ_THIN; reasons.push(`-${P_LIQ_THIN} liquidity Thin`); }

  // opening bias agreement (only within first 30 min).
  if (inp.withinFirst30 && inp.openingBias && inp.openingBias !== "Neutral") {
    if (inp.openingBias === inp.direction) { score += B_OPENING; reasons.push(`+${B_OPENING} openingBias agrees`); }
  }

  const finalScore = clamp(Math.round(score), FLOOR, CEIL);

  // ---- setupQuality (clarity, independent of finalScore) ----
  let sq = 0;
  sq += inp.regime === "Trending" || inp.regime === "Compressed" ? 30 : 15; // regime clarity
  sq += inp.liquidityState === "Normal" ? 25 : 5;                            // liquidity state
  sq += inp.wallReaction !== "UNCLEAR" ? 25 : 5;                             // wallReaction clarity
  if (sentimentAgrees(inp.sentimentState, inp.direction)) sq += 20;          // sentiment agreement/conflict
  else if (inp.sentimentState === "Neutral") sq += 10;
  else sq += 0; // Conflicted or opposed
  const setupQuality = clamp(Math.round(sq), 0, 100);

  return {
    finalScore,
    setupQuality,
    vetoed: false,
    baseTriggerPassed: true,
    rrFloorOverride: opposed ? 1.5 : null,
    reasons,
  };
}
