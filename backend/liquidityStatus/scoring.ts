// ============================ Sections 6-7 — Liquidity Flow Score & Directional Confidence ============================
// Every factor is named and independently visible in the breakdown — no black-box
// number. Directional Confidence measures SIGNAL AGREEMENT across independent
// dimensions, never presented as a probability of profit (Section 7/25).

import { LS_CONFIG } from "./config";
import { Direction, DirectionalConfidence, LiquidityFlowScore, SignalQuality } from "./types";

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

export interface FlowScoreInput {
  oiConfidence: number; // 0..100 (from computeOiChange's oiConfidence)
  oiChangeMagnitudeFrac: number; // 0..1
  priceOiAgreeFrac: number; // 0..1 (1 agree, 0.5 unknown, 0 conflict)
  rvol: number | null;
  premiumConfirmFrac: number; // 0..1
  vwapAlignmentFrac: number; // 0..1
  emaAlignmentFrac: number; // 0..1
  momentumFrac: number; // 0..1
}

export function computeLiquidityFlowScore(input: FlowScoreInput): LiquidityFlowScore {
  const s = LS_CONFIG.score;
  const rvolFrac = input.rvol != null ? clamp01(input.rvol / LS_CONFIG.rvol.strongExpansion) : 0.3;
  const parts: { label: string; weightPct: number; frac: number }[] = [
    { label: "OI Positioning", weightPct: s.oiPositioningPct, frac: clamp01(input.oiConfidence / 100) },
    { label: "OI Change", weightPct: s.oiChangePct, frac: clamp01(input.oiChangeMagnitudeFrac) },
    { label: "Price + OI confirmation", weightPct: s.priceOiConfirmationPct, frac: clamp01(input.priceOiAgreeFrac) },
    { label: "Relative Volume", weightPct: s.rvolPct, frac: rvolFrac },
    { label: "Option Premium Confirmation", weightPct: s.optionPremiumPct, frac: clamp01(input.premiumConfirmFrac) },
    { label: "VWAP", weightPct: s.vwapPct, frac: clamp01(input.vwapAlignmentFrac) },
    { label: "Market Structure", weightPct: s.marketStructurePct, frac: clamp01(input.emaAlignmentFrac) },
    { label: "Momentum", weightPct: s.momentumPct, frac: clamp01(input.momentumFrac) },
  ];
  const breakdown = parts.map((p) => ({ label: p.label, weightPct: p.weightPct, contribution: Math.round(p.weightPct * p.frac * 10) / 10 }));
  const score = Math.max(0, Math.min(100, Math.round(breakdown.reduce((a, b) => a + b.contribution, 0))));
  return { score, breakdown };
}

function qualityFor(score: number, conflict: boolean): SignalQuality {
  if (conflict) return "CONFLICT";
  const c = LS_CONFIG.confidence;
  if (score >= c.veryStrong) return "VERY STRONG";
  if (score >= c.strong) return "STRONG";
  if (score >= c.moderate) return "MODERATE";
  if (score >= c.weak) return "WEAK";
  return "NO SIGNAL";
}

/** Section 24 — strong logic requires agreement across multiple INDEPENDENT
 * dimensions; a single dimension (just OI, or just volume, or just price) must
 * never alone produce a strong reading. `dimensions` should list every
 * independent check performed (OI, price, VWAP, EMA, momentum, volume, premium). */
export function computeDirectionalConfidence(dimensions: { bullish: boolean; bearish: boolean }[]): DirectionalConfidence {
  const bullishCount = dimensions.filter((d) => d.bullish).length;
  const bearishCount = dimensions.filter((d) => d.bearish).length;
  const total = dimensions.length || 1;
  const conflict = bullishCount >= 2 && bearishCount >= 2;
  const agreement = Math.abs(bullishCount - bearishCount) / total;
  const score = Math.round(agreement * 100);

  let direction: Direction | "Neutral" | "Conflict";
  if (conflict) direction = "Conflict";
  else if (bullishCount > bearishCount) direction = "Bullish";
  else if (bearishCount > bullishCount) direction = "Bearish";
  else direction = "Neutral";

  return { direction, score, quality: qualityFor(score, conflict) };
}
