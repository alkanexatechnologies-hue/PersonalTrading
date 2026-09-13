import { Candle } from "../types";
import {
  SuggestionRecord, ObservationWindow, DirResult, TradeOutcome, WaitEval, WallOutcome,
} from "./suggestionLog";

// ============================ Outcome resolver ============================
// Measures what the market ACTUALLY DID after a suggestion. Every number here
// comes from real candles; nothing is derived from the engine's own score.
//
// Four things are kept strictly separate, because conflating them is how a
// system convinces itself it is working:
//
//   DIRECTION  - did spot move the way the suggestion implied?
//   PREMIUM    - did the option's own price move, and by how much?
//   OUTCOME    - would the target or stop have been reached?
//   WAIT EVAL  - when the system held back, was holding back right?
//
// A correct direction with a losing premium is a real and common case (IV decay,
// theta, spread), so direction is never treated as profit.

/**
 * Neutral band: a move smaller than this is NEUTRAL rather than CORRECT/WRONG.
 * Derived from the instrument's own scale instead of a flat point value, so it
 * means the same thing on NIFTY and BANKNIFTY. 0.05% of spot ~= 12 pts on a
 * 24,000 NIFTY and ~27 pts on a 54,000 BANKNIFTY.
 *
 * This is a MEASUREMENT threshold for reporting only. It is not a trading gate
 * and it does not touch the strategy.
 */
export const NEUTRAL_BAND_PCT = 0.0005;

export function neutralBandPts(spot: number): number {
  return Math.abs(spot) * NEUTRAL_BAND_PCT;
}

/** Expected spot direction implied by the suggestion. null = non-directional. */
export function expectedDirection(suggestion: string): "UP" | "DOWN" | null {
  if (suggestion === "BUY CE") return "UP";
  if (suggestion === "BUY PE") return "DOWN";
  return null;
}

/** Classifies a spot move against the expected direction. */
export function classifyDirection(
  expected: "UP" | "DOWN" | null,
  movePts: number | null,
  bandPts: number,
): DirResult {
  if (expected == null || movePts == null) return "UNRESOLVED";
  if (Math.abs(movePts) < bandPts) return "NEUTRAL";
  const actual = movePts > 0 ? "UP" : "DOWN";
  return actual === expected ? "CORRECT" : "WRONG";
}

/** 5-minute bars, in seconds. Candle.time is the bar's START. */
const BAR_SEC = 300;

/**
 * The last bar that CLOSES at or before `cutoff`.
 *
 * Bar-end semantics matter here: a bar stamped T+300 covers T+300..T+600, so it
 * closes at T+600 and must NOT be used to measure a 5-minute window from T.
 * Selecting by start time reads a bar from the future and overstates the move.
 */
function candleClosingAtOrBefore(candles: Candle[], from: number, cutoff: number, barSec = BAR_SEC): Candle | null {
  let best: Candle | null = null;
  for (const c of candles) {
    if (c.time < from) continue;
    if (c.time + barSec <= cutoff) best = c;
    else break;
  }
  return best;
}

export interface ResolveInput {
  /** 5m spot candles covering the signal time onward. */
  spotCandles: Candle[];
  /** 5m option-premium candles, when the option symbol could be resolved. */
  optionCandles?: Candle[] | null;
  /** Wall-clock now, epoch seconds - a window is only judged once it has elapsed. */
  now: number;
}

/** Fills the observation windows from real candles. */
export function resolveWindows(rec: SuggestionRecord, inp: ResolveInput): ObservationWindow[] {
  const spot0 = rec.spotAtSignal;
  const expected = expectedDirection(rec.suggestion);
  const band = spot0 != null ? neutralBandPts(spot0) : 0;

  return rec.windows.map((w) => {
    const cutoff = rec.at + w.minutes * 60;
    // Not enough wall-clock time has passed - stays UNRESOLVED rather than 0.
    if (inp.now < cutoff) {
      return { ...w, dirResult: "UNRESOLVED" as DirResult };
    }
    const sc = candleClosingAtOrBefore(inp.spotCandles, rec.at, cutoff);
    const spotAfter = sc ? sc.close : null;
    const spotMovePts = spotAfter != null && spot0 != null ? round2(spotAfter - spot0) : null;

    const oc = inp.optionCandles ? candleClosingAtOrBefore(inp.optionCandles, rec.at, cutoff) : null;
    const premiumAfter = oc ? oc.close : null;
    const premiumMovePct =
      premiumAfter != null && rec.entryPremium != null && rec.entryPremium > 0
        ? round2(((premiumAfter - rec.entryPremium) / rec.entryPremium) * 100)
        : null;

    return {
      minutes: w.minutes,
      spotAfter,
      spotMovePts,
      dirResult: classifyDirection(expected, spotMovePts, band),
      premiumAfter,
      premiumMovePct,
    };
  });
}

/**
 * Trade outcome on the OPTION PREMIUM, using the engine's own target/stop. Same
 * conservative convention as the existing hourly resolver: if both the stop and
 * the target are touched inside one bar, the stop is assumed first.
 */
export function resolveTradeOutcome(rec: SuggestionRecord, optionCandles: Candle[] | null | undefined, horizonEnd: number): TradeOutcome {
  if (!optionCandles || !optionCandles.length) return "UNRESOLVED";
  if (rec.entryPremium == null) return "UNRESOLVED";
  const tgt = rec.targetPremium;
  const stp = rec.stopPremium;
  const bars = optionCandles.filter((c) => c.time >= rec.at && c.time <= horizonEnd);
  if (!bars.length) return "UNRESOLVED";

  for (const c of bars) {
    const targetHit = tgt != null && c.high >= tgt;
    const stopHit = stp != null && c.low <= stp;
    if (stopHit && targetHit) return "STOP_HIT"; // conservative
    if (targetHit) return "TARGET_HIT";
    if (stopHit) return "STOP_HIT";
  }
  // Neither level reached inside the horizon - grade by where the premium ended.
  const last = bars[bars.length - 1].close;
  const movePct = ((last - rec.entryPremium) / rec.entryPremium) * 100;
  if (movePct > 2) return "PARTIAL";
  if (movePct < -2) return "LOSS";
  return "FLAT";
}

/**
 * Was a WAIT justified? Measured against the direction the system declined to
 * take, using the widest resolved window available.
 *
 * A WAIT is a MISSED_OPPORTUNITY only when the market moved meaningfully in the
 * direction that was blocked. A move the other way, or a move inside the neutral
 * band, is a CORRECT_WAIT. This is the measurement that will eventually say
 * whether the wall threshold is too strict - it deliberately does not change it.
 */
export function resolveWaitEval(rec: SuggestionRecord, windows: ObservationWindow[]): WaitEval {
  if (rec.masterVerdict === "GO") return "UNRESOLVED"; // not a WAIT
  const resolved = windows.filter((w) => w.spotMovePts != null);
  if (!resolved.length) return "UNRESOLVED";
  const widest = resolved[resolved.length - 1];
  const move = widest.spotMovePts as number;
  const spot0 = rec.spotAtSignal;
  if (spot0 == null) return "UNRESOLVED";
  const band = neutralBandPts(spot0);
  if (Math.abs(move) < band) return "CORRECT_WAIT";

  // Which way did the blocked setup point? Prefer the wall side that was in play;
  // fall back to the candidate leg's option type.
  const blockedDir: "UP" | "DOWN" | null =
    rec.wall.wallSide === "resistance" ? "UP"
    : rec.wall.wallSide === "support" ? "DOWN"
    : rec.optionType === "CE" ? "UP"
    : rec.optionType === "PE" ? "DOWN"
    : null;
  if (blockedDir == null) return "NEUTRAL";

  const actual = move > 0 ? "UP" : "DOWN";
  return actual === blockedDir ? "MISSED_OPPORTUNITY" : "CORRECT_WAIT";
}

/**
 * Did the wall hold, break with confirmation, or produce a false breakout?
 * Breakout confirmation uses a COMPLETED candle close beyond the wall, and a
 * false breakout is a wick through the wall that closed back inside.
 */
export function resolveWallOutcome(rec: SuggestionRecord, spotCandles: Candle[], horizonEnd: number): WallOutcome {
  const side = rec.wall.wallSide;
  const wall = side === "resistance" ? rec.wall.resistance : side === "support" ? rec.wall.support : null;
  if (side == null || wall == null) {
    return { wallHeld: null, breakoutConfirmed: null, falseBreakout: null };
  }
  // Only COMPLETED bars may confirm - a forming bar can still reverse.
  const bars = spotCandles.filter((c) => c.time >= rec.at && c.time + 300 <= horizonEnd);
  if (!bars.length) return { wallHeld: null, breakoutConfirmed: null, falseBreakout: null };

  const up = side === "resistance";
  let confirmed = false;
  let pierced = false;
  for (const c of bars) {
    if (up) {
      if (c.high > wall) pierced = true;
      if (c.close > wall) { confirmed = true; break; }
    } else {
      if (c.low < wall) pierced = true;
      if (c.close < wall) { confirmed = true; break; }
    }
  }
  return {
    wallHeld: !confirmed,
    breakoutConfirmed: confirmed,
    falseBreakout: pierced && !confirmed,
  };
}

/** Resolves one record in place and returns a new record. */
export function resolveRecord(rec: SuggestionRecord, inp: ResolveInput): SuggestionRecord {
  const maxWindow = Math.max(...rec.windows.map((w) => w.minutes));
  const horizonEnd = rec.at + maxWindow * 60;

  if (!inp.spotCandles.length) {
    return { ...rec, unresolvedReason: "no spot candles available for this window" };
  }

  const windows = resolveWindows(rec, inp);
  const allWindowsElapsed = inp.now >= horizonEnd;
  const everyWindowGraded = windows.every((w) => w.dirResult !== "UNRESOLVED");

  const tradeOutcome = rec.suggestion.startsWith("BUY")
    ? resolveTradeOutcome(rec, inp.optionCandles, horizonEnd)
    : "UNRESOLVED";
  const waitEval = resolveWaitEval({ ...rec, windows }, windows);
  const wallOutcome = resolveWallOutcome(rec, inp.spotCandles, horizonEnd);

  const missingOption = rec.suggestion.startsWith("BUY") && !inp.optionCandles?.length;

  return {
    ...rec,
    windows,
    tradeOutcome,
    waitEval,
    wallOutcome,
    resolved: allWindowsElapsed && everyWindowGraded,
    resolvedAt: allWindowsElapsed ? inp.now : null,
    unresolvedReason: !allWindowsElapsed
      ? "observation window has not elapsed yet"
      : missingOption
        ? "option premium history unavailable - direction measured, premium ABSTAINED"
        : null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
