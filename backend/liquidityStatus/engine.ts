// ============================ Liquidity Status — orchestrator ============================
// Reuses backend/liquidity/* (opening range, key levels, sweep/real-break/trap
// detection), backend/oi/oiChange.ts (OI), backend/paper/entryRules.ts
// (support/resistance/VWAP/swings) and backend/optionTopPick/structureChecks.ts
// (EMA/VWAP structure) — no indicator math or OI/level classification is
// reimplemented here. Advisory only.

import { findSymbolDef, nearestStrike, DISCLAIMER, SymbolDef } from "../config";
import { atr, last, rsi } from "../indicators";
import { computeOiChange } from "../oi/oiChange";
import { levelContext } from "../paper/entryRules";
import { buildStructureFacts, computeEmaStructure, computeVwapStatus } from "../optionTopPick/structureChecks";
import { openingRange, buildLiquidityLevels } from "../liquidity/liquidityLevels";
import { atr14Of, detectLiquidity } from "../liquidity/sweepDetector";
import { Candle, OiAnalysis } from "../types";
import { LS_CONFIG } from "./config";
import { buildEvidence, summarizeEvidence } from "./evidence";
import { buildKeyLevels } from "./levels";
import { classifyMoveStage } from "./moveStage";
import { computeDirectionalConfidence, computeLiquidityFlowScore } from "./scoring";
import { buildConfirmationChecklist, buildEarlyWarnings, detectConflict } from "./checklist";
import { buildTrigger, buildInvalidation } from "./triggerInvalidation";
import { decideTraderAction } from "./traderAction";
import { buildSystemView, buildTraderPreparation } from "./commentary";
import { recordShift } from "./shiftTracker";
import { logLiquidityStatus } from "./auditLog";
import { Direction, LiquidityShiftState, LiquidityStatusDeps, LiquidityStatusResult } from "./types";

/** Mirrors backend/optionTopPick/scanner.ts's rvolOf() exactly (not exported
 * there) — a 17-bar trailing baseline that excludes the measured tail-3, per
 * the audit's recommendation over routes/api.ts's self-diluting relVolNow(). */
function rvolOf(candles: Candle[]): number | null {
  if (candles.length < 20) return null;
  const base = candles.slice(-20, -3).reduce((a, c) => a + c.volume, 0) / 17;
  if (base <= 0) return null;
  const recent = candles.slice(-3).reduce((a, c) => a + c.volume, 0) / 3;
  return Math.round((recent / base) * 100) / 100;
}

function momentumDivergingOf(closes: number[], bullish: boolean): boolean {
  if (closes.length < 15) return false;
  const series = rsi(closes, 14);
  const rsiNow = series[series.length - 1];
  const rsiPast = series[series.length - 11];
  if (rsiNow == null || rsiPast == null) return false;
  const priceNow = closes[closes.length - 1];
  const pricePast = closes[closes.length - 11];
  return bullish ? priceNow > pricePast && rsiNow < rsiPast - 5 : priceNow < pricePast && rsiNow > rsiPast + 5;
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

function shiftStateFor(direction: Direction | "Neutral" | "Conflict", quality: string): LiquidityShiftState {
  if (direction === "Conflict") return "Conflict";
  if (direction === "Neutral") return "Neutral";
  const strong = quality === "VERY STRONG" || quality === "STRONG";
  if (direction === "Bullish") return strong ? "Strong Bullish" : "Bullish";
  return strong ? "Strong Bearish" : "Bearish";
}

export async function evaluateLiquidityStatus(symbol: string, deps: LiquidityStatusDeps): Promise<LiquidityStatusResult> {
  const def = findSymbolDef(symbol);
  if (!def) throw new Error(`Liquidity Status: unknown symbol "${symbol}"`);

  const nowEpoch = deps.nowEpochSec();
  const [c1, c5, daily, oiRaw] = await Promise.all([
    deps.getCandles(symbol, "1m"),
    deps.getCandles(symbol, "5m"),
    deps.getCandles(symbol, "1d"),
    deps.getOi(symbol).catch(() => null),
  ]);
  if (c5.length < 30) throw new Error(`Liquidity Status: not enough candle history for ${symbol}`);

  const lastCandle = c5[c5.length - 1];
  const oi: OiAnalysis = oiRaw ?? {
    available: false, symbol: def.symbol, nseSymbol: def.nseSymbol || def.symbol, underlying: lastCandle.close,
    expiry: null, pcr: null, pcrState: "neutral", totalCeOi: 0, totalPeOi: 0, support: null, resistance: null,
    maxPain: null, ceBuildup: "mixed", peBuildup: "mixed", verdict: { bias: "Neutral", reasons: [] },
    topStrikes: [], asOf: nowEpoch, disclaimer: DISCLAIMER,
  };
  const spot = oi.underlying ?? lastCandle.close;
  const dataTimestamp = lastCandle.time;
  const dataAgeSec = Math.max(0, nowEpoch - dataTimestamp);
  const oiTimestamp = oiRaw ? oi.asOf : null;
  const oiAgeSec = oiTimestamp != null ? Math.max(0, nowEpoch - oiTimestamp) : null;
  const oiStale = oiAgeSec != null && oiAgeSec > LS_CONFIG.freshness.oiStaleSec;
  const liveFeedStale = dataAgeSec > LS_CONFIG.freshness.liveFeedStaleSec;

  const atmStrike = oi.available ? nearestStrike(spot, def) : null;
  const ocRaw = oiRaw && !oiStale ? computeOiChange(def.symbol, def.name, def.type === "index" ? "index" : "equity", oi) : null;
  const evidence = buildEvidence(ocRaw);
  const evidenceSummary = summarizeEvidence(evidence);

  const structure = buildStructureFacts(c5, null);
  const lv = levelContext(c5, daily, oiRaw);
  const atrDaily = daily.length >= 15 ? last(atr(daily, 14)) : null;
  const dayOpen = lv.dayOpen ?? c5[0]?.open ?? spot;
  const movePct = dayOpen ? ((spot - dayOpen) / dayOpen) * 100 : 0;
  const atrPct = atrDaily != null && spot > 0 ? (atrDaily / spot) * 100 : 1;
  const atrPts = atrDaily ?? spot * 0.01;
  const rvol = rvolOf(c5);

  const or = openingRange(c1, nowEpoch);
  const levelSet = buildLiquidityLevels({ intraday: c5, daily, pdh: lv.pdh, pdl: lv.pdl, swingHigh5m: lv.swingHigh, swingLow5m: lv.swingLow, oi: oiRaw, nowEpoch });
  const atr14 = atr14Of(c1);
  const detection = detectLiquidity({ symbol, candles: c1, rangeHigh: or.high ?? lv.pdh ?? spot, rangeLow: or.low ?? lv.pdl ?? spot, atr14 });

  const keyLevels = buildKeyLevels(oi, ocRaw, spot, lv.pdl, lv.pdh);
  const keySupport = keyLevels[0], keyResistance = keyLevels[2];

  const priceDirection: "up" | "down" | "flat" = movePct > 0.05 ? "up" : movePct < -0.05 ? "down" : "flat";
  const conflict = detectConflict(priceDirection, ocRaw);

  const rsiNow = last(rsi(c5.map((c) => c.close), 14));
  const dims = [
    { bullish: ocRaw?.oiVerdict === "Bullish", bearish: ocRaw?.oiVerdict === "Bearish" },
    { bullish: priceDirection === "up", bearish: priceDirection === "down" },
    { bullish: structure.vwapStatus.startsWith("Above"), bearish: structure.vwapStatus.startsWith("Below") },
    { bullish: structure.emaStructure === "Strong Bullish", bearish: structure.emaStructure === "Strong Bearish" },
    { bullish: rsiNow != null && rsiNow >= 55, bearish: rsiNow != null && rsiNow <= 45 },
  ];
  const confidence = computeDirectionalConfidence(dims);
  const direction = confidence.direction;
  const liquidityShift = shiftStateFor(direction, confidence.quality);
  const shiftRecord = recordShift(symbol, liquidityShift, nowEpoch);

  const bullDir: Direction | null = direction === "Bullish" ? "Bullish" : direction === "Bearish" ? "Bearish" : null;
  const diverging = bullDir ? momentumDivergingOf(c5.map((c) => c.close), bullDir === "Bullish") : false;
  const premiumConfirming = bullDir
    ? evidence.some((e) => bullDir === "Bullish" ? e.interpretation === "CALL UNWINDING" || e.interpretation === "PUT WRITING / SUPPORT BUILDING" : e.interpretation === "PUT UNWINDING" || e.interpretation === "CALL WRITING / RESISTANCE BUILDING")
    : false;
  const oiConfirming = bullDir ? (bullDir === "Bullish" ? ocRaw?.oiVerdict === "Bullish" : ocRaw?.oiVerdict === "Bearish") : false;

  const moveStageResult = classifyMoveStage({
    movePct, atrPct, rvol, oiConfirming: !!oiConfirming, premiumConfirming,
    retracedFromExtremePct: 0, momentumDiverging: diverging,
  });

  const trigger = buildTrigger(bullDir, keyResistance, keySupport, atrPts);
  const invalidation = buildInvalidation(bullDir, keyResistance, keySupport);
  const triggerAlreadyCrossed = !!(trigger?.level != null && (trigger.direction === "UP" ? spot >= trigger.level : spot <= trigger.level));

  const confirmations = buildConfirmationChecklist({
    direction: bullDir, vwapStatus: structure.vwapStatus, emaStructure: structure.emaStructure,
    ema9: structure.ema9, ema21: structure.ema21, ema50: structure.ema50, evidence,
    rvol, rvolExpansion: LS_CONFIG.rvol.expansion, premiumConfirming,
    triggerLabel: trigger ? `${trigger.direction === "UP" ? "Breakout above" : "Breakdown below"} ${trigger.level} required` : null,
  });

  const traderActionResult = decideTraderAction({ direction, moveStage: moveStageResult.stage, conflict, confirmations, triggerAlreadyCrossed });

  const earlyWarnings = buildEarlyWarnings({
    evidence, distanceToResistancePts: keyResistance.distancePts, distanceToSupportPts: keySupport.distancePts,
    rvol, rvolStrong: LS_CONFIG.rvol.strongExpansion, vwapStatus: structure.vwapStatus,
  });

  const netChgMag = ocRaw ? Math.max(Math.abs(ocRaw.netCeChg ?? 0), Math.abs(ocRaw.netPeChg ?? 0)) : 0;
  const flowScore = computeLiquidityFlowScore({
    oiConfidence: ocRaw?.oiConfidence ?? 0,
    oiChangeMagnitudeFrac: clamp01(netChgMag / 200000),
    priceOiAgreeFrac: !ocRaw ? 0.5 : conflict.conflict ? 0 : 1,
    rvol, premiumConfirmFrac: premiumConfirming ? 1 : 0.3,
    vwapAlignmentFrac: bullDir ? (bullDir === "Bullish" ? (structure.vwapStatus === "Above+Rising" ? 1 : structure.vwapStatus.startsWith("Above") ? 0.6 : 0) : (structure.vwapStatus === "Below+Falling" ? 1 : structure.vwapStatus.startsWith("Below") ? 0.6 : 0)) : 0.3,
    emaAlignmentFrac: structure.emaStructure === "Mixed" ? 0.3 : (bullDir === "Bullish" ? (structure.emaStructure === "Strong Bullish" ? 1 : 0) : bullDir === "Bearish" ? (structure.emaStructure === "Strong Bearish" ? 1 : 0) : 0.3),
    momentumFrac: rsiNow != null ? clamp01(Math.abs(rsiNow - 50) / 50) : 0.3,
  });

  const systemView = buildSystemView({ name: def.name, direction, evidenceSummary, vwapStatus: structure.vwapStatus, moveStage: moveStageResult.stage, resistance: keyResistance, support: keySupport });
  const traderPreparation = buildTraderPreparation(direction === "Bullish" || direction === "Bearish" ? direction : direction, trigger, invalidation);

  logLiquidityStatus({
    timestamp: nowEpoch, symbol, spot, atmStrike, support: keySupport.price, resistance: keyResistance.price,
    oi: atmStrike != null ? (oi.topStrikes.find((s) => s.strike === atmStrike)?.ceOi ?? null) : null,
    oiChange: evidence[0]?.oiChange ?? null, premiumChange: evidence[0]?.premiumChangePct ?? null,
    volume: null, rvol, vwap: structure.vwapValue, ema9: structure.ema9, ema21: structure.ema21, ema50: structure.ema50,
    momentum: rsiNow, liquidityScore: flowScore.score, direction, movementStage: moveStageResult.stage,
    liquidityShift, trigger: trigger?.level ?? null, invalidation: invalidation?.level ?? null,
    dataAgeSec, oiAgeSec, finalAction: traderActionResult.action, commentary: systemView,
  });

  return {
    symbol, name: def.name, spot, atmStrike,
    liquidityShift, moveStage: moveStageResult.stage, continuationLikely: moveStageResult.continuationLikely,
    directionBias: direction, moveStrength: flowScore.score, systemView, traderPreparation,
    evidence, keyLevels, distanceToSupportPts: keySupport.distancePts, distanceToResistancePts: keyResistance.distancePts,
    liquidityFlowScore: flowScore, directionalConfidence: confidence, confirmations,
    battlefield: { support: keySupport, spot, resistance: keyResistance },
    trigger, invalidation, traderAction: traderActionResult.action, traderActionDetail: traderActionResult.detail,
    earlyWarnings, shiftHistory: shiftRecord.history, lastShiftEvent: shiftRecord.lastEvent, conflict,
    structure: { ema9: structure.ema9, ema21: structure.ema21, ema50: structure.ema50, emaStructure: structure.emaStructure, vwapStatus: structure.vwapStatus, vwapValue: structure.vwapValue, rsi: rsiNow },
    rvol,
    detection, openingRange: or, levels: levelSet.levels,
    freshness: { priceAgeSec: dataAgeSec, optionAgeSec: oiAgeSec, oiAgeSec, oiStale, liveFeedStale },
    generatedAt: nowEpoch, disclaimer: DISCLAIMER,
  };
}
