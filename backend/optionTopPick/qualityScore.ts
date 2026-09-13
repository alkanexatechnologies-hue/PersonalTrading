// ============================ Part 10 — Option Quality Score ============================
// ONE shared weight table for both tracks so the two scores stay comparable in
// scale, even though what feeds "Liquidity/Flow" is deliberately neutral (not
// penalized, not rewarded) for the Stock Setup track, which by definition does
// not require liquidity confirmation (Part 4B).

import { OTP_CONFIG } from "./config";
import { QualityScoreResult } from "./types";

export interface QualityScoreInput {
  stockDirectionFrac: number; // 0..1
  stockSetupFrac: number; // 0..1
  liquidityFlowFrac: number; // 0..1 — pass 0.5 (neutral) when the track doesn't use this signal
  momentumFrac: number; // 0..1
  optionLiquidityFrac: number; // 0..1
  volumeFrac: number; // 0..1
  spreadFrac: number; // 0..1 — OI-depth proxy (no bid/ask in this app's data feed)
  roomFrac: number; // 0..1
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

export function computeQualityScore(input: QualityScoreInput): QualityScoreResult {
  const q = OTP_CONFIG.quality;
  const parts: { label: string; weightPct: number; frac: number }[] = [
    { label: "Stock Direction", weightPct: q.stockDirectionPct, frac: clamp01(input.stockDirectionFrac) },
    { label: "Stock Setup", weightPct: q.stockSetupPct, frac: clamp01(input.stockSetupFrac) },
    { label: "Liquidity/Flow", weightPct: q.liquidityFlowPct, frac: clamp01(input.liquidityFlowFrac) },
    { label: "Momentum", weightPct: q.momentumPct, frac: clamp01(input.momentumFrac) },
    { label: "Option Liquidity", weightPct: q.optionLiquidityPct, frac: clamp01(input.optionLiquidityFrac) },
    { label: "Volume", weightPct: q.volumePct, frac: clamp01(input.volumeFrac) },
    { label: "Spread (OI-depth proxy)", weightPct: q.spreadPct, frac: clamp01(input.spreadFrac) },
    { label: "Room/Reward", weightPct: q.roomRewardPct, frac: clamp01(input.roomFrac) },
  ];
  const breakdown = parts.map((p) => ({ label: p.label, weightPct: p.weightPct, contribution: Math.round(p.weightPct * p.frac * 10) / 10 }));
  const score = Math.max(0, Math.min(100, Math.round(breakdown.reduce((s, b) => s + b.contribution, 0))));
  return { score, breakdown };
}
