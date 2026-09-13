import "./aiConfig"; // safety guard runs first
import { MarketSnapshotRecord, OptionChainRecord, StrategySnapshotRecord } from "../data/tradingDataTypes";

// ============================ ML feature-row schema (FROZEN) ============================
// This is the feature-row shape the whole ML pipeline agrees on. It is built
// PURELY from records already written by liveSnapshotRecorder.ts for a SINGLE
// timestamp — no lookahead is possible here because this function is never
// given anything from a later timestamp to begin with (see labelBuilder.ts
// and dataValidator.ts's leakage tests for where that guarantee is enforced
// end-to-end).
//
// OI features are a plain aggregation (sum/ratio) of already-recorded raw
// option_chain fields — not a new trading signal, not used by any live
// decision, purely for ML feature organization.

export interface TechnicalFeatures {
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  vwap: number | null;
  rsi: number | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  supertrend: number | null;
  supertrendDirection: number | null;
}

export interface OiFeatures {
  totalCallOi: number | null;
  totalPutOi: number | null;
  putCallRatio: number | null; // totalPutOi / totalCallOi, null if totalCallOi is 0/unavailable
  totalOiChange: number | null; // sum of oiChange across all recorded strikes at this timestamp
  strikesRecorded: number; // how many strikes had BOTH CE and PE rows at this timestamp
}

export interface FeatureRow {
  timestamp: number;
  symbol: string;
  spot: number | null;
  technicalFeatures: TechnicalFeatures;
  oiFeatures: OiFeatures;
  marketStructure: string | null;
  regime: string | null;
  strategyScore: number | null; // strategySnapshot.finalScore — the one score the live system exposes
  masterDecision: string | null;
  oiBias: string | null;
}

export function buildOiFeatures(chainRowsAtTimestamp: OptionChainRecord[]): OiFeatures {
  const byStrike = new Map<number, { ce?: OptionChainRecord; pe?: OptionChainRecord }>();
  for (const r of chainRowsAtTimestamp) {
    const entry = byStrike.get(r.strike) || {};
    if (r.optionType === "CE") entry.ce = r; else entry.pe = r;
    byStrike.set(r.strike, entry);
  }
  let totalCallOi = 0, totalPutOi = 0, totalOiChange = 0, strikesRecorded = 0;
  let sawAny = false;
  for (const { ce, pe } of byStrike.values()) {
    if (ce?.openInterest != null) { totalCallOi += ce.openInterest; sawAny = true; }
    if (pe?.openInterest != null) { totalPutOi += pe.openInterest; sawAny = true; }
    if (ce?.oiChange != null) totalOiChange += ce.oiChange;
    if (pe?.oiChange != null) totalOiChange += pe.oiChange;
    if (ce && pe) strikesRecorded++;
  }
  return {
    totalCallOi: sawAny ? totalCallOi : null,
    totalPutOi: sawAny ? totalPutOi : null,
    putCallRatio: sawAny && totalCallOi > 0 ? Math.round((totalPutOi / totalCallOi) * 10000) / 10000 : null,
    totalOiChange: sawAny ? totalOiChange : null,
    strikesRecorded,
  };
}

export function buildFeatureRow(
  market: MarketSnapshotRecord,
  chainRowsAtTimestamp: OptionChainRecord[],
  strategy: StrategySnapshotRecord | null
): FeatureRow {
  return {
    timestamp: market.timestamp,
    symbol: market.symbol,
    spot: market.spot,
    technicalFeatures: { ...market.technicals },
    oiFeatures: buildOiFeatures(chainRowsAtTimestamp),
    marketStructure: market.marketStructure,
    regime: market.regime,
    strategyScore: strategy?.finalScore ?? null,
    masterDecision: strategy?.masterDecision ?? null,
    oiBias: strategy?.oiBias ?? null,
  };
}
