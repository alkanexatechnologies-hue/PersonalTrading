import { Candle } from "../types";
import { atr, last } from "../indicators";
import { istDateOfSec, istMinuteOfDay } from "../util/istTime";
import { LIQUIDITY_CONFIG, sweepBufferFor } from "./liquidityConfig";

// ============================ Sweep / real-break detector ============================
// Implements EXACTLY the supplied conditions. No extra indicator, threshold,
// filter or confirmation is applied, and no condition is relaxed.
//
// UPSIDE SWEEP (§4)
//   high > rangeHigh + buffer
//   AND a candle closes back below rangeHigh within 1-2 candles
//   AND upper wick >= 60% of that candle's total range
//
// REAL UPSIDE BREAK (§5)
//   close > rangeHigh + 0.1 x ATR(14)
//   AND body >= 60% of candle range
//   AND the next 2 candles do not close back inside the range
//
// TRAP (§6)
//   both the high side and the low side are swept inside the trap window
//
// Downside is the mirror of each. ATR(14) comes from the application's existing
// indicators/index.ts atr() - no second ATR implementation is introduced.

export type LiquidityEventType = "NONE" | "SWEEP" | "REAL_BREAK" | "TRAP";
export type SweepDirection = "UP" | "DOWN" | "BOTH" | "NONE";

export interface CandleGeometry {
  range: number;
  body: number;
  upperWick: number;
  lowerWick: number;
  upperWickPct: number;
  lowerWickPct: number;
  bodyPct: number;
}

/** Wick/body proportions of one candle, as percentages of its total range. */
export function geometry(c: Candle): CandleGeometry {
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);
  const bodyHigh = Math.max(c.open, c.close);
  const bodyLow = Math.min(c.open, c.close);
  const upperWick = c.high - bodyHigh;
  const lowerWick = bodyLow - c.low;
  const pct = (v: number) => (range > 0 ? (v / range) * 100 : 0);
  return {
    range, body, upperWick, lowerWick,
    upperWickPct: pct(upperWick),
    lowerWickPct: pct(lowerWick),
    bodyPct: pct(body),
  };
}

export interface SweepHit {
  direction: "UP" | "DOWN";
  /** Index of the candle that breached the range edge. */
  breachIndex: number;
  /** Index of the candle that closed back inside. */
  reclaimIndex: number;
  breachTime: number;
  reclaimTime: number;
  /** Extreme reached on the breach candle (high for UP, low for DOWN). */
  sweepPrice: number;
  /** Close of the reclaim candle. */
  reclaimPrice: number;
  /** Wick percentage that satisfied the >= 60% condition. */
  wickPct: number;
  bodyPct: number;
  bufferUsed: number;
}

export interface RealBreakHit {
  direction: "UP" | "DOWN";
  index: number;
  time: number;
  closePrice: number;
  /** The 0.1 x ATR(14) distance the close had to exceed. */
  requiredDistance: number;
  actualDistance: number;
  bodyPct: number;
  atr14: number;
}

export interface DetectionInput {
  symbol: string;
  /** Detection-timeframe candles (1m), ascending by time. */
  candles: Candle[];
  rangeHigh: number | null;
  rangeLow: number | null;
  /** ATR(14) on the detection timeframe. Supplied by the caller so it is computed once. */
  atr14: number | null;
}

export interface DetectionResult {
  eventType: LiquidityEventType;
  direction: SweepDirection;
  /** Most recent sweep, if any. */
  sweep: SweepHit | null;
  /** Most recent real break, if any. */
  realBreak: RealBreakHit | null;
  /** True when both sides were swept inside the trap window. */
  trapFlag: boolean;
  /** Every sweep found in the session, used for the trap test and for study. */
  allSweeps: SweepHit[];
  reclaimed: boolean;
  atr14: number | null;
  bufferUsed: number;
  /** Set when detection could not run. */
  skipReason: string | null;
}

/** ATR(14) on the supplied candles, using the application's existing atr(). */
export function atr14Of(candles: Candle[]): number | null {
  if (candles.length < 15) return null;
  return last(atr(candles, 14));
}

/**
 * All sweeps of the range edges. A sweep needs the breach, the reclaim within
 * 1-2 candles, AND the 60% wick on the breach candle - all three, per §4.
 */
export function findSweeps(i: DetectionInput): SweepHit[] {
  const { candles, rangeHigh, rangeLow } = i;
  if (rangeHigh == null || rangeLow == null) return [];
  const buffer = sweepBufferFor(i.symbol);
  const within = LIQUIDITY_CONFIG.reclaimWithinCandles;
  const wickMin = LIQUIDITY_CONFIG.sweepWickMinPct;
  const out: SweepHit[] = [];

  for (let n = 0; n < candles.length; n++) {
    const c = candles[n];
    const g = geometry(c);

    // --- upside sweep ---
    if (c.high > rangeHigh + buffer && g.upperWickPct >= wickMin) {
      for (let k = n; k <= Math.min(n + within, candles.length - 1); k++) {
        if (candles[k].close < rangeHigh) {
          out.push({
            direction: "UP", breachIndex: n, reclaimIndex: k,
            breachTime: c.time, reclaimTime: candles[k].time,
            sweepPrice: c.high, reclaimPrice: candles[k].close,
            wickPct: round2(g.upperWickPct), bodyPct: round2(g.bodyPct), bufferUsed: buffer,
          });
          break;
        }
      }
    }

    // --- downside sweep (mirror) ---
    if (c.low < rangeLow - buffer && g.lowerWickPct >= wickMin) {
      for (let k = n; k <= Math.min(n + within, candles.length - 1); k++) {
        if (candles[k].close > rangeLow) {
          out.push({
            direction: "DOWN", breachIndex: n, reclaimIndex: k,
            breachTime: c.time, reclaimTime: candles[k].time,
            sweepPrice: c.low, reclaimPrice: candles[k].close,
            wickPct: round2(g.lowerWickPct), bodyPct: round2(g.bodyPct), bufferUsed: buffer,
          });
          break;
        }
      }
    }
  }
  return out;
}

/**
 * All real breaks of the range edges, per §5. Requires the ATR-scaled close
 * distance, the 60% body, AND that the next 2 candles do not close back inside.
 */
export function findRealBreaks(i: DetectionInput): RealBreakHit[] {
  const { candles, rangeHigh, rangeLow, atr14 } = i;
  if (rangeHigh == null || rangeLow == null || atr14 == null) return [];
  const need = LIQUIDITY_CONFIG.realBreakAtrMultiple * atr14;
  const bodyMin = LIQUIDITY_CONFIG.realBreakBodyMinPct;
  const hold = LIQUIDITY_CONFIG.realBreakHoldCandles;
  const out: RealBreakHit[] = [];

  for (let n = 0; n < candles.length; n++) {
    const c = candles[n];
    const g = geometry(c);
    if (g.bodyPct < bodyMin) continue;

    // The following `hold` candles must all exist and must not close back inside.
    const followers = candles.slice(n + 1, n + 1 + hold);
    if (followers.length < hold) continue;

    if (c.close > rangeHigh + need && followers.every((f) => f.close > rangeHigh)) {
      out.push({
        direction: "UP", index: n, time: c.time, closePrice: c.close,
        requiredDistance: round2(need), actualDistance: round2(c.close - rangeHigh),
        bodyPct: round2(g.bodyPct), atr14: round2(atr14),
      });
    }
    if (c.close < rangeLow - need && followers.every((f) => f.close < rangeLow)) {
      out.push({
        direction: "DOWN", index: n, time: c.time, closePrice: c.close,
        requiredDistance: round2(need), actualDistance: round2(rangeLow - c.close),
        bodyPct: round2(g.bodyPct), atr14: round2(atr14),
      });
    }
  }
  return out;
}

/** Candles inside the configured TRAP window (full session, by operator decision). */
function inTrapWindow(c: Candle): boolean {
  const m = istMinuteOfDay(c.time);
  return m >= LIQUIDITY_CONFIG.trapWindow.startMinIST && m < LIQUIDITY_CONFIG.trapWindow.endMinIST;
}

/**
 * Runs the full detection for one symbol. Observation only: the result is
 * returned and logged, and is NOT consulted by any entry or exit path.
 */
export function detectLiquidity(i: DetectionInput): DetectionResult {
  const buffer = sweepBufferFor(i.symbol);
  const base: DetectionResult = {
    eventType: "NONE", direction: "NONE", sweep: null, realBreak: null,
    trapFlag: false, allSweeps: [], reclaimed: false,
    atr14: i.atr14, bufferUsed: buffer, skipReason: null,
  };

  if (!i.candles.length) return { ...base, skipReason: "no candles on the detection timeframe" };
  if (i.rangeHigh == null || i.rangeLow == null) {
    return { ...base, skipReason: `opening range (${LIQUIDITY_CONFIG.openingRange.label}) not established yet` };
  }

  // Restrict to the session of the latest candle so a sweep from a previous day
  // can never be reported as today's event.
  const todayIso = istDateOfSec(i.candles[i.candles.length - 1].time);
  const session = i.candles.filter((c) => istDateOfSec(c.time) === todayIso);
  const scoped: DetectionInput = { ...i, candles: session };

  const sweeps = findSweeps(scoped);
  const breaks = findRealBreaks(scoped);

  // TRAP: both sides swept inside the trap window.
  const windowSweeps = sweeps.filter((s) => {
    const c = session[s.breachIndex];
    return c ? inTrapWindow(c) : false;
  });
  const sweptUp = windowSweeps.some((s) => s.direction === "UP");
  const sweptDown = windowSweeps.some((s) => s.direction === "DOWN");
  const trapFlag = sweptUp && sweptDown;

  const lastSweep = sweeps.length ? sweeps[sweeps.length - 1] : null;
  const lastBreak = breaks.length ? breaks[breaks.length - 1] : null;

  // Event precedence: TRAP describes the whole session, so it is reported first.
  // Otherwise the most recent of the two event kinds is reported.
  let eventType: LiquidityEventType = "NONE";
  let direction: SweepDirection = "NONE";
  if (trapFlag) {
    eventType = "TRAP";
    direction = "BOTH";
  } else if (lastSweep && lastBreak) {
    if (lastBreak.time >= lastSweep.reclaimTime) { eventType = "REAL_BREAK"; direction = lastBreak.direction; }
    else { eventType = "SWEEP"; direction = lastSweep.direction; }
  } else if (lastSweep) {
    eventType = "SWEEP"; direction = lastSweep.direction;
  } else if (lastBreak) {
    eventType = "REAL_BREAK"; direction = lastBreak.direction;
  }

  return {
    eventType, direction,
    sweep: lastSweep, realBreak: lastBreak,
    trapFlag, allSweeps: sweeps,
    reclaimed: !!lastSweep,
    atr14: i.atr14, bufferUsed: buffer, skipReason: null,
  };
}

/**
 * The entry DIRECTION the supplied concept implies after a sweep (§7).
 * Reported for study only - it is not wired to order execution, and the
 * application's own SL is untouched.
 */
export function entryAfterSweepConcept(sweep: SweepHit | null): { direction: "BULLISH" | "BEARISH" | "NONE"; slConcept: string } {
  if (!sweep) return { direction: "NONE", slConcept: "—" };
  const { min, max } = LIQUIDITY_CONFIG.slBeyondWickPtsConcept;
  // Upside sweep -> reclaim below rangeHigh -> bearish; downside sweep -> bullish.
  const direction = sweep.direction === "UP" ? "BEARISH" : "BULLISH";
  const beyond = sweep.direction === "UP" ? sweep.sweepPrice + min : sweep.sweepPrice - min;
  return {
    direction,
    slConcept: `${min}-${max} pts beyond sweep wick ${round2(sweep.sweepPrice)} (e.g. ${round2(beyond)}) — CONCEPT ONLY, not connected`,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
