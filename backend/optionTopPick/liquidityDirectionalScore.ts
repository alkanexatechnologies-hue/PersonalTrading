// ============================ Part 4A — Liquidity Directional trade ============================
// "Liquidity/market-flow evidence suggests a meaningful directional move" — built
// from OI change + price + volume + VWAP, exactly like the per-stock CE/PE lean
// (directionScore.ts, reused as-is) plus relative-volume and option-premium
// confirmation. Never claims to detect literal order flow or "smart money" — see
// LiquidityFlowLabel's wording and commentary.ts's banned-phrase list.

import { OTP_CONFIG } from "./config";
import { pickWinningSide } from "./directionScore";
import { DirectionScoreResult, Direction, GateCheck, GateResult, LiquidityFlowLabel, OiInterpretation, VwapStatus } from "./types";

export interface LiquidityDirectionalEval {
  direction: Direction | null;
  label: LiquidityFlowLabel;
  gates: GateResult;
  stockDirectionFrac: number;
  liquidityFlowFrac: number;
  momentumFrac: number;
}

export function evaluateLiquidityDirectional(
  direction: DirectionScoreResult,
  oi: OiInterpretation,
  rvol: number | null,
  premiumChangePct: number | null,
  vwapStatus: VwapStatus,
): LiquidityDirectionalEval {
  const side = pickWinningSide(direction.ceScore, direction.peScore);
  const dir: Direction | null = side === "CE" ? "Bullish" : side === "PE" ? "Bearish" : null;
  const { liquidity: L } = OTP_CONFIG;

  const checks: GateCheck[] = [];
  checks.push({ name: "Directional lean confirmed", pass: dir != null, detail: `CE ${direction.ceScore} vs PE ${direction.peScore} (max ${direction.maxScore})` });

  const oiOpposes = dir != null && ((dir === "Bullish" && oi.oiVerdict === "Bearish") || (dir === "Bearish" && oi.oiVerdict === "Bullish") || oi.oiVerdict === "TWO_SIDED");
  checks.push({ name: "OI supports the direction", pass: dir == null || !oiOpposes, detail: `OI verdict: ${oi.oiVerdict}` });
  checks.push({ name: "Sufficient OI confidence", pass: oi.oiConfidence >= OTP_CONFIG.gates.minOiConfidenceLiquidity, detail: `OI confidence ${oi.oiConfidence}` });

  const rvolOk = rvol != null && rvol >= L.minRvol;
  checks.push({ name: "Relative volume expansion", pass: rvolOk, detail: rvol != null ? `RVOL ${rvol.toFixed(2)}x (need >= ${L.minRvol}x)` : "volume data unavailable" });

  const premiumConfirms = dir != null && premiumChangePct != null &&
    (dir === "Bullish" ? premiumChangePct >= L.minPremiumChangePct : premiumChangePct <= -L.minPremiumChangePct);
  checks.push({ name: "Option premium confirming", pass: premiumConfirms, detail: premiumChangePct != null ? `premium change ${premiumChangePct.toFixed(1)}%` : "premium change unavailable" });

  const vwapOpposes = dir != null && ((dir === "Bullish" && vwapStatus.startsWith("Below")) || (dir === "Bearish" && vwapStatus.startsWith("Above")));
  checks.push({ name: "VWAP not opposing", pass: !vwapOpposes, detail: `VWAP status: ${vwapStatus}` });

  const failedNames = checks.filter((c) => !c.pass).map((c) => c.name);
  const gates: GateResult = { allPass: failedNames.length === 0, checks, failedNames };

  let label: LiquidityFlowLabel = "No Liquidity Signal";
  if (dir != null) {
    const strong = oi.oiConfidence >= 60 && rvol != null && rvol >= L.strongRvol && premiumConfirms;
    const expanding = rvolOk && (oi.oiConfidence >= OTP_CONFIG.gates.minOiConfidenceLiquidity || premiumConfirms);
    label = strong ? "Liquidity Flow Strong" : expanding ? "Liquidity Expansion" : "Directional Flow Bias";
  }

  const edge = Math.abs(direction.ceScore - direction.peScore);
  return {
    direction: dir,
    label,
    gates,
    stockDirectionFrac: dir != null ? Math.min(1, edge / direction.maxScore) : 0,
    liquidityFlowFrac: Math.min(1, (oi.oiConfidence / 100) * 0.6 + (rvolOk ? 0.25 : 0) + (premiumConfirms ? 0.15 : 0)),
    momentumFrac: rvol != null ? Math.min(1, rvol / (L.strongRvol * 1.5)) : 0.3,
  };
}
