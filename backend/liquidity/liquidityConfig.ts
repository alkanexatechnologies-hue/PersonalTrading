// ============================ Liquidity detection config ============================
// Deliberately a SEPARATE file from config/arbitration.ts.
//
// arbitration.ts is a strategy file under the integrity baseline
// (backend/qa/strategyIntegrity.ts). Putting liquidity values there would change
// the strategy hash and report the Master Strategy as MODIFIED, which would be
// false: liquidity detection is an observation-only feature and is NOT connected
// to any entry gate. Keeping it here leaves the strategy hash untouched.
//
// Every value below was supplied or explicitly decided by the operator. Nothing
// here was chosen by inference.

export const LIQUIDITY_CONFIG = {
  // Opening range window, IST minutes-of-day. OPERATOR DECISION: 9:15-9:20,
  // i.e. the first 5-minute candle. This is intentionally NOT the application's
  // existing 9:15-9:45 orHigh/orLow (paper/entryRules.ts levelContext) - that
  // remains untouched and is still used for its own purposes.
  openingRange: {
    startMinIST: 9 * 60 + 15, // 09:15
    endMinIST: 9 * 60 + 20,   // 09:20 (exclusive)
    label: "09:15-09:20",
  },

  // Sweep buffer in index POINTS. OPERATOR DECISION: 5 points for both NIFTY and
  // BANK NIFTY. Held per-symbol rather than as one shared literal so §9's "do not
  // hardcode NIFTY-specific behaviour into shared logic" is satisfied structurally,
  // even though both values are currently the same.
  sweepBufferPts: {
    default: 5,
    bySymbol: {} as Record<string, number>,
  },

  // Sweep reclaim must happen within this many candles after the breach candle.
  // Supplied as "1-2 candles" -> at most 2.
  reclaimWithinCandles: 2,

  // Wick share of the candle's total range required for a sweep. Supplied: >= 60%.
  sweepWickMinPct: 60,

  // Real break: close must exceed the range edge by more than this multiple of
  // ATR(14). Supplied: 0.1 x ATR(14).
  realBreakAtrMultiple: 0.1,

  // Real break: body share of the candle's total range. Supplied: >= 60%.
  realBreakBodyMinPct: 60,

  // Real break: this many following candles must not close back inside the range.
  // Supplied: next 2 candles.
  realBreakHoldCandles: 2,

  // TRAP window. OPERATOR DECISION: full session.
  trapWindow: {
    startMinIST: 9 * 60 + 15,  // 09:15
    endMinIST: 15 * 60 + 30,   // 15:30
    label: "09:15-15:30 (full session)",
  },

  // Timeframe used for sweep/break detection. "3m" is NOT a supported Interval in
  // this application (backend/types.ts Interval = 1m|5m|15m|30m|60m|1d), so the
  // supplied "1-minute or 3-minute" resolves to 1m.
  detectionInterval: "1m" as const,

  // Stop-loss CONCEPT ONLY, recorded for later study. Supplied as "3-5 points
  // beyond sweep wick". NOT connected to order execution or to the application's
  // existing SL, per §7.
  slBeyondWickPtsConcept: { min: 3, max: 5, connected: false },
};

/** Sweep buffer for a symbol, in points. */
export function sweepBufferFor(symbol: string): number {
  const v = LIQUIDITY_CONFIG.sweepBufferPts.bySymbol[symbol];
  return typeof v === "number" ? v : LIQUIDITY_CONFIG.sweepBufferPts.default;
}

/**
 * Items the supplied specification references but does not define, and which this
 * application has no data source for. OPERATOR DECISION: skip for now and record
 * them explicitly rather than invent a value.
 */
export const NOT_DEFINED = {
  equalHighs: "NOT_DEFINED — no equality tolerance (points or %) or lookback was specified",
  equalLows: "NOT_DEFINED — no equality tolerance (points or %) or lookback was specified",
  roundNumbers: "NOT_DEFINED — no round-number interval was specified (50/100/500/1000?)",
  trendlineTouchPoints: "NOT_DEFINED — no trendline construction (pivots, timeframe, touch count, tolerance) was specified",
  indiaVix: "UNAVAILABLE — India VIX does not exist anywhere in this application: no symbol, no feed, no stored series",
} as const;
