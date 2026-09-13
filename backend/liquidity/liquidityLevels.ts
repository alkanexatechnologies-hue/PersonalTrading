import { Candle, OiAnalysis } from "../types";
import { istDateOfSec, istMinuteOfDay } from "../util/istTime";
import { LIQUIDITY_CONFIG, NOT_DEFINED } from "./liquidityConfig";

// ============================ Liquidity levels ============================
// Stores the liquidity locations listed in the specification. Nothing is added
// beyond that list, and any listed level whose definition was not supplied is
// recorded as NOT_DEFINED rather than guessed.
//
// Reuses the application's existing data wherever one exists:
//   PDH / PDL / 5m swing high / 5m swing low -> paper/entryRules.ts levelContext()
//   Max OI Call / Put strike                 -> OiAnalysis.resistance / .support
// This module computes only what has no existing canonical source: the
// 09:15-09:20 opening range and the previous-week high/low.

export type LevelType =
  | "PDH" | "PDL"
  | "OR_HIGH" | "OR_LOW"
  | "EQUAL_HIGH" | "EQUAL_LOW"
  | "ROUND_NUMBER"
  | "PREV_WEEK_HIGH" | "PREV_WEEK_LOW"
  | "SWING_HIGH_5M" | "SWING_LOW_5M"
  | "TRENDLINE_TOUCH"
  | "MAX_OI_CALL_STRIKE" | "MAX_OI_PUT_STRIKE";

export interface LiquidityLevel {
  type: LevelType;
  /** null when the level is unavailable or its definition was not supplied. */
  price: number | null;
  /** Set when price is null, explaining which of the two applies. */
  note?: string;
  /** Where the number came from, so the audit trail is traceable. */
  source: string;
}

export interface OpeningRange {
  high: number | null;
  low: number | null;
  /** Candles that formed the range. */
  barCount: number;
  window: string;
  /** True once the window has fully elapsed for the session being measured. */
  established: boolean;
}

/**
 * Opening range over the configured window (09:15-09:20 by operator decision).
 * Uses whatever interval the caller supplies; with 5m candles this is the single
 * first candle, with 1m candles it is the first five.
 */
export function openingRange(candles: Candle[], nowEpoch?: number): OpeningRange {
  const { startMinIST, endMinIST, label } = LIQUIDITY_CONFIG.openingRange;
  if (!candles.length) return { high: null, low: null, barCount: 0, window: label, established: false };

  const todayIso = istDateOfSec(candles[candles.length - 1].time);
  const bars = candles.filter((c) => {
    if (istDateOfSec(c.time) !== todayIso) return false;
    const m = istMinuteOfDay(c.time);
    return m >= startMinIST && m < endMinIST;
  });
  if (!bars.length) return { high: null, low: null, barCount: 0, window: label, established: false };

  // Established once wall-clock (or the latest candle) has passed the window end.
  const refMin = nowEpoch != null ? istMinuteOfDay(nowEpoch) : istMinuteOfDay(candles[candles.length - 1].time);
  return {
    high: Math.max(...bars.map((c) => c.high)),
    low: Math.min(...bars.map((c) => c.low)),
    barCount: bars.length,
    window: label,
    established: refMin >= endMinIST,
  };
}

/**
 * Previous calendar week's high/low from daily candles. A week runs Monday to
 * Sunday; "previous week" is the most recent week strictly before the week that
 * contains the latest daily bar.
 */
export function previousWeekRange(daily: Candle[]): { high: number | null; low: number | null } {
  if (!daily.length) return { high: null, low: null };
  const weekKey = (epochSec: number): string => {
    // Monday-anchored ISO-style week key, computed in IST.
    const d = new Date((epochSec + 19800) * 1000);
    const dow = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
    const monday = new Date(d.getTime() - dow * 86400000);
    return monday.toISOString().slice(0, 10);
  };
  const latestWeek = weekKey(daily[daily.length - 1].time);
  const priorWeeks = [...new Set(daily.map((c) => weekKey(c.time)))].filter((w) => w < latestWeek).sort();
  if (!priorWeeks.length) return { high: null, low: null };
  const target = priorWeeks[priorWeeks.length - 1];
  const bars = daily.filter((c) => weekKey(c.time) === target);
  if (!bars.length) return { high: null, low: null };
  return { high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)) };
}

export interface BuildLevelsInput {
  /** Detection-timeframe candles (1m) for the opening range. */
  intraday: Candle[];
  /** Daily candles, for the previous week's range. */
  daily: Candle[];
  /** Reused from levelContext() — not recomputed here. */
  pdh: number | null;
  pdl: number | null;
  swingHigh5m: number | null;
  swingLow5m: number | null;
  /** Reused from the existing OI analysis. */
  oi: OiAnalysis | null;
  nowEpoch?: number;
}

export interface LiquidityLevelSet {
  openingRange: OpeningRange;
  levels: LiquidityLevel[];
}

export function buildLiquidityLevels(i: BuildLevelsInput): LiquidityLevelSet {
  const or = openingRange(i.intraday, i.nowEpoch);
  const pw = previousWeekRange(i.daily);

  const levels: LiquidityLevel[] = [
    { type: "PDH", price: i.pdh, source: "entryRules.levelContext()" },
    { type: "PDL", price: i.pdl, source: "entryRules.levelContext()" },
    { type: "OR_HIGH", price: or.high, source: `liquidityLevels.openingRange(${or.window})` },
    { type: "OR_LOW", price: or.low, source: `liquidityLevels.openingRange(${or.window})` },
    { type: "PREV_WEEK_HIGH", price: pw.high, source: "liquidityLevels.previousWeekRange(daily)" },
    { type: "PREV_WEEK_LOW", price: pw.low, source: "liquidityLevels.previousWeekRange(daily)" },
    { type: "SWING_HIGH_5M", price: i.swingHigh5m, source: "entryRules.levelContext()" },
    { type: "SWING_LOW_5M", price: i.swingLow5m, source: "entryRules.levelContext()" },
    { type: "MAX_OI_CALL_STRIKE", price: i.oi?.resistance ?? null, source: "OiAnalysis.resistance (max CALL OI strike)" },
    { type: "MAX_OI_PUT_STRIKE", price: i.oi?.support ?? null, source: "OiAnalysis.support (max PUT OI strike)" },
    // Listed in the specification but never defined / no data source. Recorded,
    // not invented - see liquidityConfig.NOT_DEFINED.
    { type: "EQUAL_HIGH", price: null, note: NOT_DEFINED.equalHighs, source: "—" },
    { type: "EQUAL_LOW", price: null, note: NOT_DEFINED.equalLows, source: "—" },
    { type: "ROUND_NUMBER", price: null, note: NOT_DEFINED.roundNumbers, source: "—" },
    { type: "TRENDLINE_TOUCH", price: null, note: NOT_DEFINED.trendlineTouchPoints, source: "—" },
  ];

  return { openingRange: or, levels };
}

/** The liquidity level nearest to a price, ignoring unavailable ones. */
export function nearestLevel(levels: LiquidityLevel[], price: number): LiquidityLevel | null {
  let best: LiquidityLevel | null = null;
  let bestDist = Infinity;
  for (const l of levels) {
    if (l.price == null) continue;
    const d = Math.abs(l.price - price);
    if (d < bestDist) { bestDist = d; best = l; }
  }
  return best;
}
