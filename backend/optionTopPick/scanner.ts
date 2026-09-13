// ============================ Option Top Pick — stock scanner (orchestrator) ============================
// Scans the F&O equity universe and produces TWO separate, never-merged ranked
// lists (Part 5): Liquidity Directional and Stock Setup. Reuses computeSignal
// (indicators), computeOiChange (OI), levelContext (S/R) — no indicator math or OI
// classification is reimplemented here. Advisory only: never places or simulates
// an order.

import { findSymbolDef, nearestStrike, DISCLAIMER, SymbolDef } from "../config";
import { atr, last, rsi } from "../indicators";
import { computeOiChange } from "../oi/oiChange";
import { levelContext } from "../paper/entryRules";
import { computeSignal } from "../signals/engine";
import { OiChangeResult } from "../oi/oiChange";
import { Candle, OiAnalysis, OiStrike, SignalResult } from "../types";
import { OTP_CONFIG } from "./config";
import { computeDirectionScore } from "./directionScore";
import { evaluateLiquidityDirectional } from "./liquidityDirectionalScore";
import { classifyMovementStage, isNoChaseStage } from "./movementStage";
import { atmPremiumChangePct, emptyOiInterpretation, interpretOi } from "./oiInterpretation";
import { computeQualityScore } from "./qualityScore";
import { computeLevels } from "./levels";
import { computeRoom } from "./room";
import { evaluateStockSetup } from "./stockSetupScore";
import { buildStructureFacts } from "./structureChecks";
import { buildCommentary } from "./commentary";
import { logOptionTopPick } from "./auditLog";
import {
  DataFreshness, Direction, FinalDecision, GateResult, OiInterpretation, OptionSide, OptionTopPickDeps,
  OptionTopPickScanResult, QualityScoreResult, RoomResult, SelectedOption, StockCandidate, StructureFacts,
} from "./types";

function avgFor(strikes: OiStrike[], side: OptionSide, field: "oi" | "vol"): number {
  const vals = strikes
    .map((s) => (side === "CE" ? (field === "oi" ? s.ceOi : s.ceVol) : (field === "oi" ? s.peOi : s.peVol)))
    .filter((v): v is number => v != null && v > 0);
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function relativeScore(value: number | null, avg: number): number {
  if (value == null || avg <= 0) return 0.3;
  return Math.max(0, Math.min(1, value / (avg * 2)));
}

function rvolOf(candles: Candle[]): number | null {
  if (candles.length < 20) return null;
  const base = candles.slice(-20, -3).reduce((a, c) => a + c.volume, 0) / 17;
  if (base <= 0) return null;
  const recent = candles.slice(-3).reduce((a, c) => a + c.volume, 0) / 3;
  return Math.round((recent / base) * 100) / 100;
}

function justCrossed(candles: Candle[], level: number | null, direction: "up" | "down", lookback = 3): boolean {
  if (level == null || candles.length < lookback + 1) return false;
  const recent = candles.slice(-lookback - 1);
  const before = recent[0].close;
  const now = recent[recent.length - 1].close;
  return direction === "up" ? before <= level && now > level : before >= level && now < level;
}

function momentumDiverging(closes: number[], bullish: boolean): boolean {
  if (closes.length < 15) return false;
  const rsiSeries = rsi(closes, 14);
  const rsiNow = rsiSeries[rsiSeries.length - 1];
  const rsiPast = rsiSeries[rsiSeries.length - 11];
  if (rsiNow == null || rsiPast == null) return false;
  const priceNow = closes[closes.length - 1];
  const pricePast = closes[closes.length - 11];
  return bullish ? priceNow > pricePast && rsiNow < rsiPast - 5 : priceNow < pricePast && rsiNow > rsiPast + 5;
}

interface SharedFacts {
  def: SymbolDef;
  spot: number;
  dataTimestamp: number;
  dataAgeSec: number;
  oiTimestamp: number | null;
  oiAgeSec: number | null;
  oiStale: boolean;
  atmStrike: number;
  oi: OiAnalysis;
  oc: OiChangeResult | null;
  oiInterp: OiInterpretation;
  signal: SignalResult;
  structure: StructureFacts;
  movePct: number;
  atrPct: number;
  rvol: number | null;
  c5: Candle[];
  daily: Candle[];
  majorSupport: number | null;
  majorResistance: number | null;
  expectedMovePts: number;
}

async function buildSharedFacts(def: SymbolDef, deps: OptionTopPickDeps): Promise<SharedFacts | null> {
  const nowEpoch = deps.nowEpochSec();
  const [c5, daily, oiRaw] = await Promise.all([
    deps.getCandles(def.symbol, "5m"),
    deps.getCandles(def.symbol, "1d"),
    deps.getOi(def.symbol).catch(() => null),
  ]);
  if (c5.length < 30) return null;

  const lastCandle = c5[c5.length - 1];
  const oi = oiRaw ?? { available: false, symbol: def.symbol, nseSymbol: def.nseSymbol || def.symbol, underlying: lastCandle.close, expiry: null, pcr: null, pcrState: "neutral" as const, totalCeOi: 0, totalPeOi: 0, support: null, resistance: null, maxPain: null, ceBuildup: "mixed" as const, peBuildup: "mixed" as const, verdict: { bias: "Neutral" as const, reasons: [] }, topStrikes: [], asOf: nowEpoch, disclaimer: DISCLAIMER };
  const spot = oi.underlying ?? lastCandle.close;
  const dataTimestamp = lastCandle.time;
  const dataAgeSec = Math.max(0, nowEpoch - dataTimestamp);
  const oiTimestamp = oiRaw ? oi.asOf : null;
  const oiAgeSec = oiTimestamp != null ? Math.max(0, nowEpoch - oiTimestamp) : null;
  const oiStale = oiAgeSec != null && oiAgeSec > OTP_CONFIG.freshness.oiStaleSec;

  const atmStrike = nearestStrike(spot, def);
  const ocRaw = oiRaw && !oiStale ? computeOiChange(def.symbol, def.name, "equity", oi) : null;
  const oiInterp = oiRaw ? interpretOi(ocRaw, oi, atmStrike) : emptyOiInterpretation();

  const structure = buildStructureFacts(c5, null);
  const lv = levelContext(c5, daily, oiRaw);
  const atrDaily = daily.length >= 15 ? last(atr(daily, 14)) : null;
  const dayOpen = lv.dayOpen ?? c5[0]?.open ?? spot;
  const movePct = dayOpen ? ((spot - dayOpen) / dayOpen) * 100 : 0;
  const atrPct = atrDaily != null && spot > 0 ? (atrDaily / spot) * 100 : 1;
  const signal = computeSignal(def.symbol, c5);

  return {
    def, spot, dataTimestamp, dataAgeSec, oiTimestamp, oiAgeSec, oiStale, atmStrike,
    oi, oc: ocRaw, oiInterp, signal, structure, movePct, atrPct, rvol: rvolOf(c5), c5, daily,
    majorSupport: lv.majorSupport, majorResistance: lv.majorResistance,
    expectedMovePts: atrDaily ?? spot * 0.01,
  };
}

function selectOption(facts: SharedFacts, side: OptionSide): SelectedOption | null {
  const row = facts.oi.topStrikes.find((s) => s.strike === facts.atmStrike);
  if (!row) return null;
  return {
    side, strike: facts.atmStrike, expiry: facts.oi.expiry,
    ltp: side === "CE" ? row.ceLtp ?? null : row.peLtp ?? null,
    oi: side === "CE" ? row.ceOi ?? null : row.peOi ?? null,
    volume: side === "CE" ? row.ceVol ?? null : row.peVol ?? null,
  };
}

function freshnessOf(facts: SharedFacts): DataFreshness {
  return { dataTimestamp: facts.dataTimestamp, oiTimestamp: facts.oiTimestamp, dataAgeSec: facts.dataAgeSec, oiAgeSec: facts.oiAgeSec, oiStale: facts.oiStale };
}

/** Part 15/24 decision assembly, shared by both tracks: movement-stage no-chase
 * override first (mandatory), then gates, then the quality-score bar. */
function decideFrom(gates: GateResult, quality: QualityScoreResult, stageIsNoChase: boolean, direction: Direction | null): { decision: FinalDecision; reasons: string[] } {
  const reasons: string[] = [];
  if (direction == null) return { decision: "NO EDGE", reasons: ["No confirmed direction on this track"] };
  if (stageIsNoChase) return { decision: "EXTENDED — DO NOT CHASE", reasons: ["Movement stage indicates the move is already extended"] };
  if (!gates.allPass) {
    reasons.push(...gates.failedNames);
    const onlyPremiumExtended = gates.failedNames.length === 1 && gates.failedNames[0] === "Premium not already excessively extended";
    return { decision: onlyPremiumExtended ? "WAIT FOR PULLBACK" : "AVOID", reasons };
  }
  if (quality.score >= OTP_CONFIG.gates.minQualityScoreTopPick) return { decision: "TOP PICK", reasons };
  if (quality.score >= OTP_CONFIG.gates.minQualityScoreWatch) { reasons.push(`Quality score ${quality.score} below Top Pick threshold`); return { decision: "WATCH", reasons }; }
  reasons.push(`Quality score ${quality.score} too low`);
  return { decision: "NO_EDGE" as FinalDecision, reasons }; // normalized to "NO EDGE" below
}

async function evaluateStockSetupCandidate(facts: SharedFacts, deps: OptionTopPickDeps): Promise<StockCandidate | null> {
  const evalR = evaluateStockSetup(facts.structure, facts.signal, computeRoom(
    facts.structure.emaStructure === "Strong Bullish" ? "CE" : "PE", facts.spot, facts.majorSupport, facts.majorResistance, facts.expectedMovePts,
  ));
  if (evalR.direction == null) {
    const stage = classifyMovementStage({ movePct: facts.movePct, atrPct: facts.atrPct, justCrossedResistance: false, justCrossedSupport: false, retracedFromExtremePct: 0, momentumDiverging: false }).stage;
    return buildCandidate(facts, "STOCK_SETUP", null, evalR.gates, { score: 0, breakdown: [] }, stage, null, "no direction", deps);
  }
  const side: OptionSide = evalR.direction === "Bullish" ? "CE" : "PE";
  const room = computeRoom(side, facts.spot, facts.majorSupport, facts.majorResistance, facts.expectedMovePts);
  const selected = selectOption(facts, side);
  const oiDepthScore = relativeScore(selected?.oi ?? null, avgFor(facts.oi.topStrikes, side, "oi"));
  const volScore = relativeScore(selected?.volume ?? null, avgFor(facts.oi.topStrikes, side, "vol"));
  const quality = computeQualityScore({
    stockDirectionFrac: evalR.stockDirectionFrac, stockSetupFrac: evalR.stockSetupFrac,
    liquidityFlowFrac: 0.5, momentumFrac: evalR.momentumFrac,
    optionLiquidityFrac: oiDepthScore, volumeFrac: volScore, spreadFrac: oiDepthScore,
    roomFrac: room.ok && room.distancePts != null ? Math.min(1, room.distancePts / (room.minRequiredPts * 1.5)) : 0,
  });
  const diverging = momentumDiverging(facts.c5.map((c) => c.close), evalR.direction === "Bullish");
  const stageInfo = classifyMovementStage({
    movePct: facts.movePct, atrPct: facts.atrPct,
    justCrossedResistance: justCrossed(facts.c5, facts.majorResistance, "up"),
    justCrossedSupport: justCrossed(facts.c5, facts.majorSupport, "down"),
    retracedFromExtremePct: 0, momentumDiverging: diverging,
  });
  const gatesWithRoom: GateResult = { ...evalR.gates, allPass: evalR.gates.allPass && room.ok, failedNames: room.ok ? evalR.gates.failedNames : [...evalR.gates.failedNames, "Sufficient room to opposing level"] };
  return buildCandidate(facts, "STOCK_SETUP", evalR.direction, gatesWithRoom, quality, stageInfo.stage, { selected, room }, null, deps);
}

async function evaluateLiquidityDirectionalCandidate(facts: SharedFacts, deps: OptionTopPickDeps): Promise<StockCandidate> {
  const direction = computeDirectionScore({ signalVotes: facts.signal.votes, oiVerdict: facts.oiInterp.oiVerdict, pcrState: facts.oiInterp.pcrState });
  const sideGuess: OptionSide = direction.ceScore >= direction.peScore ? "CE" : "PE";
  const premiumChangePct = atmPremiumChangePct(facts.oc, facts.atmStrike, sideGuess);
  const evalR = evaluateLiquidityDirectional(direction, facts.oiInterp, facts.rvol, premiumChangePct, facts.structure.vwapStatus);

  if (evalR.direction == null) {
    const stage = classifyMovementStage({ movePct: facts.movePct, atrPct: facts.atrPct, justCrossedResistance: false, justCrossedSupport: false, retracedFromExtremePct: 0, momentumDiverging: false }).stage;
    return buildCandidate(facts, "LIQUIDITY_DIRECTIONAL", null, evalR.gates, { score: 0, breakdown: [] }, stage, null, evalR.label, deps);
  }
  const side: OptionSide = evalR.direction === "Bullish" ? "CE" : "PE";
  const room = computeRoom(side, facts.spot, facts.majorSupport, facts.majorResistance, facts.expectedMovePts);
  const selected = selectOption(facts, side);
  const oiDepthScore = relativeScore(selected?.oi ?? null, avgFor(facts.oi.topStrikes, side, "oi"));
  const volScore = relativeScore(selected?.volume ?? null, avgFor(facts.oi.topStrikes, side, "vol"));
  const quality = computeQualityScore({
    stockDirectionFrac: evalR.stockDirectionFrac, stockSetupFrac: facts.structure.emaStructure === "Mixed" ? 0.3 : 1,
    liquidityFlowFrac: evalR.liquidityFlowFrac, momentumFrac: evalR.momentumFrac,
    optionLiquidityFrac: oiDepthScore, volumeFrac: volScore, spreadFrac: oiDepthScore,
    roomFrac: room.ok && room.distancePts != null ? Math.min(1, room.distancePts / (room.minRequiredPts * 1.5)) : 0,
  });
  const diverging = momentumDiverging(facts.c5.map((c) => c.close), evalR.direction === "Bullish");
  const stageInfo = classifyMovementStage({
    movePct: facts.movePct, atrPct: facts.atrPct,
    justCrossedResistance: justCrossed(facts.c5, facts.majorResistance, "up"),
    justCrossedSupport: justCrossed(facts.c5, facts.majorSupport, "down"),
    retracedFromExtremePct: 0, momentumDiverging: diverging,
  });
  const gatesWithRoom: GateResult = { ...evalR.gates, allPass: evalR.gates.allPass && room.ok, failedNames: room.ok ? evalR.gates.failedNames : [...evalR.gates.failedNames, "Sufficient room to opposing wall"] };
  return buildCandidate(facts, "LIQUIDITY_DIRECTIONAL", evalR.direction, gatesWithRoom, quality, stageInfo.stage, { selected, room }, evalR.label, deps);
}

function buildCandidate(
  facts: SharedFacts, track: "LIQUIDITY_DIRECTIONAL" | "STOCK_SETUP", direction: Direction | null,
  gates: GateResult, quality: QualityScoreResult, stage: ReturnType<typeof classifyMovementStage>["stage"],
  optionAndRoom: { selected: SelectedOption | null; room: RoomResult } | null, liquidityLabel: string | null, deps: OptionTopPickDeps,
): StockCandidate {
  const { decision: rawDecision, reasons } = decideFrom(gates, quality, isNoChaseStage(stage), direction);
  const decision: FinalDecision = (rawDecision as string) === "NO_EDGE" ? "NO EDGE" : rawDecision;
  const levels = decision === "TOP PICK" && optionAndRoom?.selected?.ltp != null ? computeLevels(optionAndRoom.selected.ltp) : null;
  const commentary = buildCommentary({
    name: facts.def.name, track, direction, decision, movementStage: stage,
    vwapStatus: facts.structure.vwapStatus, emaStructure: facts.structure.emaStructure,
    liquidityLabel: liquidityLabel as any, qualityScore: quality.score, reasons,
  });
  const candidate: StockCandidate = {
    symbol: facts.def.symbol, name: facts.def.name, sector: facts.def.sector,
    track, direction, spot: facts.spot, movePct: Math.round(facts.movePct * 100) / 100,
    movementStage: stage, decision, qualityScore: quality,
    selectedOption: optionAndRoom?.selected ?? null, levels, room: optionAndRoom?.room ?? null,
    structure: facts.structure, oi: facts.oiInterp,
    liquidityFlow: track === "LIQUIDITY_DIRECTIONAL"
      ? { label: (liquidityLabel as any) ?? "No Liquidity Signal", rvol: facts.rvol, premiumChangePct: direction ? atmPremiumChangePct(facts.oc, facts.atmStrike, direction === "Bullish" ? "CE" : "PE") : null }
      : null,
    gates, reasons, commentary, freshness: freshnessOf(facts),
  };

  logOptionTopPick({
    timestamp: deps.nowEpochSec(), symbol: facts.def.symbol, track, spot: facts.spot,
    movePct: candidate.movePct, movementStage: stage, direction: direction, qualityScore: quality.score,
    selectedOption: candidate.selectedOption ? `${facts.def.name} ${candidate.selectedOption.strike} ${candidate.selectedOption.side}` : null,
    optionLtp: candidate.selectedOption?.ltp ?? null,
    entry: levels?.entry ?? null, target1: levels?.target1 ?? null, target2: levels?.target2 ?? null, stop: levels?.stop ?? null,
    roomPts: candidate.room?.distancePts ?? null, decision, reason: commentary,
    dataTimestamp: facts.dataTimestamp, oiTimestamp: facts.oiTimestamp, dataAgeSec: facts.dataAgeSec,
  });

  return candidate;
}

export async function evaluateStockBothTracks(symbol: string, deps: OptionTopPickDeps): Promise<{ liquidityDirectional: StockCandidate | null; stockSetup: StockCandidate | null }> {
  const def = findSymbolDef(symbol);
  if (!def) throw new Error(`Option Top Pick: unknown symbol "${symbol}"`);
  const facts = await buildSharedFacts(def, deps);
  if (!facts) return { liquidityDirectional: null, stockSetup: null };
  const [ld, ss] = await Promise.all([evaluateLiquidityDirectionalCandidate(facts, deps), evaluateStockSetupCandidate(facts, deps)]);
  return { liquidityDirectional: ld, stockSetup: ss };
}

export async function scanOptionTopPick(deps: OptionTopPickDeps): Promise<OptionTopPickScanResult> {
  const universe = deps.listEligibleStocks().slice(0, OTP_CONFIG.scan.maxCandidates);
  const liquidityDirectional: StockCandidate[] = [];
  const stockSetup: StockCandidate[] = [];
  let scannedCount = 0;

  for (let i = 0; i < universe.length; i += OTP_CONFIG.scan.oiConcurrency) {
    const chunk = universe.slice(i, i + OTP_CONFIG.scan.oiConcurrency);
    const results = await Promise.all(chunk.map(async (def) => {
      try {
        const facts = await buildSharedFacts(def, deps);
        if (!facts) return null;
        const [ld, ss] = await Promise.all([evaluateLiquidityDirectionalCandidate(facts, deps), evaluateStockSetupCandidate(facts, deps)]);
        return { ld, ss };
      } catch { return null; }
    }));
    for (const r of results) {
      if (!r) continue;
      scannedCount++;
      if (r.ld) liquidityDirectional.push(r.ld);
      if (r.ss) stockSetup.push(r.ss);
    }
  }

  const rank = (list: StockCandidate[]) => list
    .filter((c) => c.decision !== "NO EDGE")
    .sort((a, b) => b.qualityScore.score - a.qualityScore.score)
    .slice(0, OTP_CONFIG.scan.topN);

  return {
    liquidityDirectional: rank(liquidityDirectional),
    stockSetup: rank(stockSetup),
    scannedCount,
    eligibleCount: universe.length,
    generatedAt: deps.nowEpochSec(),
    disclaimer: DISCLAIMER,
  };
}
