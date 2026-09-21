// Morning 9:30 option-buying placement (advisory).
// Uses the existing OpeningRangeBreakoutEngine: mark 09:15–09:30 IST high/low
// on 1-minute bars, then TAKE only after a CLOSE outside that range.
// Does not change Market Regime, Strategy Selector, MTS, or paper execution.

import { Candle, OiAnalysis } from "../types";
import { SymbolDef, nearestStrike } from "../config";
import { istMinuteOfDay } from "../util/istTime";
import { computeOpeningRange, detectOrbBreakout, buildOrbEntry, OrbBreakoutSignal } from "./OpeningRangeBreakoutEngine";

const PLACE_MIN = 9 * 60 + 30; // 09:30 IST — range must be complete before a TAKE

export type Morning930Action = "WAIT" | "TAKE";

export interface Morning930Idea {
  optionType: "CE" | "PE";
  strike: number;
  premium: number;
  premiumStop: number;
  premiumTarget: number;
  spot: number;
  spotStop: number;
  lotSize: number;
  direction: "Bullish" | "Bearish";
  strikeReason: string;
}

export interface Morning930Read {
  symbol: string;
  name: string;
  action: Morning930Action;
  reason: string;
  rangeFormed: boolean;
  rangeHigh: number | null;
  rangeLow: number | null;
  barsSeen: number;
  optionType: "CE" | "PE" | null;
  volumeConfirmed: boolean | null;
  idea: Morning930Idea | null;
}

export interface Morning930Inputs {
  def: SymbolDef;
  candles1m: Candle[];
  oi: OiAnalysis | null;
  nowEpochSec: number;
  openRisk: number;
  startCapital: number;
}

function atmLtp(oi: OiAnalysis | null, strike: number, side: "CE" | "PE"): number {
  const row = oi?.topStrikes?.reduce((best, s) => {
    if (best == null || Math.abs(s.strike - strike) < Math.abs(best.strike - strike)) return s;
    return best;
  }, null as (typeof oi.topStrikes)[number] | null);
  const px = side === "CE" ? row?.ceLtp : row?.peLtp;
  return px != null && px > 0 ? px : 0;
}

/** Index 1m bars often have no volume — same as /api/orb: treat as volume-neutral, not a veto. */
function withIndexVolumeNeutral(def: SymbolDef, signal: OrbBreakoutSignal): OrbBreakoutSignal {
  if (def.type !== "index") return signal;
  if (signal.volumeConfirmed) return signal;
  if (signal.volumeSma20 > 0) return signal;
  return {
    ...signal,
    volumeConfirmed: true,
    note: `${signal.note} · index volume n/a (treated as confirmed)`,
  };
}

export function evaluateMorning930(inp: Morning930Inputs): Morning930Read {
  const { def, candles1m, oi, nowEpochSec, openRisk, startCapital } = inp;
  const base = (): Morning930Read => ({
    symbol: def.symbol,
    name: def.name,
    action: "WAIT",
    reason: "",
    rangeFormed: false,
    rangeHigh: null,
    rangeLow: null,
    barsSeen: 0,
    optionType: null,
    volumeConfirmed: null,
    idea: null,
  });

  const clockMin = istMinuteOfDay(nowEpochSec);
  const range = computeOpeningRange(candles1m || []);
  const out = base();
  if (range) {
    out.rangeFormed = range.formed;
    out.rangeHigh = Math.round(range.high * 100) / 100;
    out.rangeLow = Math.round(range.low * 100) / 100;
    out.barsSeen = range.barsSeen;
  }

  if (clockMin < PLACE_MIN) {
    out.reason = "WAIT — 09:15–09:30 opening range still building. Place only after 9:30 IST.";
    return out;
  }
  if (!range) {
    out.reason = "WAIT — no 09:15–09:30 1-minute bars yet.";
    return out;
  }
  if (!range.formed) {
    out.reason = `WAIT — opening range not complete (${range.barsSeen} bars).`;
    return out;
  }

  const raw = detectOrbBreakout(candles1m, range);
  if (!raw) {
    out.reason = `WAIT — price still inside ${out.rangeLow}–${out.rangeHigh}. Need a 1m CLOSE outside the range.`;
    return out;
  }

  const signal = withIndexVolumeNeutral(def, raw);
  out.optionType = signal.optionType;
  out.volumeConfirmed = signal.volumeConfirmed;

  const last = candles1m[candles1m.length - 1];
  const spot = (oi?.underlying && oi.underlying > 0 ? oi.underlying : last?.close) || 0;
  const strike = nearestStrike(spot, def);
  const ltp = atmLtp(oi, strike, signal.optionType);
  const built = buildOrbEntry(signal, {
    symbol: def.symbol,
    name: def.name,
    atmStrike: strike,
    lotSize: def.lotSize || 1,
    ltp,
    spot,
    nowEpochSec,
    openRisk,
    startCapital,
  });

  if (typeof built === "string") {
    out.reason = `WAIT — ${built}`;
    return out;
  }

  out.action = "TAKE";
  out.reason = built.strikeReason || signal.note;
  out.idea = {
    optionType: built.optionType,
    strike: built.strike,
    premium: built.premium,
    premiumStop: built.premiumStop,
    premiumTarget: built.premiumTarget,
    spot: built.spot,
    spotStop: built.spotStop,
    lotSize: built.lotSize,
    direction: built.direction,
    strikeReason: built.strikeReason,
  };
  return out;
}
