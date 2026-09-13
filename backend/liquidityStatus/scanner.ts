// ============================ Section 19 — Stock-level liquidity scanner ============================
import { DISCLAIMER } from "../config";
import { LS_CONFIG } from "./config";
import { evaluateLiquidityStatus } from "./engine";
import { LiquidityStatusDeps, LiquidityStatusScanResult, StockLiquiditySummary } from "./types";

export async function scanLiquidityStatus(deps: LiquidityStatusDeps): Promise<LiquidityStatusScanResult> {
  const universe = deps.listEligibleStocks().slice(0, LS_CONFIG.scan.maxCandidates);
  const summaries: StockLiquiditySummary[] = [];
  let scannedCount = 0;

  for (let i = 0; i < universe.length; i += LS_CONFIG.scan.oiConcurrency) {
    const chunk = universe.slice(i, i + LS_CONFIG.scan.oiConcurrency);
    const results = await Promise.all(chunk.map(async (def) => {
      try {
        const r = await evaluateLiquidityStatus(def.symbol, deps);
        return { symbol: def.symbol, name: def.name, liquidityFlow: r.directionalConfidence.quality, direction: r.directionBias, moveStage: r.moveStage, score: r.liquidityFlowScore.score } as StockLiquiditySummary;
      } catch { return null; }
    }));
    for (const r of results) { if (r) { scannedCount++; summaries.push(r); } }
  }

  const topMovers = summaries
    .filter((s) => s.liquidityFlow !== "NO SIGNAL")
    .sort((a, b) => b.score - a.score)
    .slice(0, LS_CONFIG.scan.topN);

  return { topMovers, scannedCount, eligibleCount: universe.length, generatedAt: deps.nowEpochSec(), disclaimer: DISCLAIMER };
}
