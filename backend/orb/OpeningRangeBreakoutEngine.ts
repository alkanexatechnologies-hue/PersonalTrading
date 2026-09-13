// ============================ Opening Range Breakout Engine ============================
// Continuous module. Pure computation + explicit position-state helpers — no I/O,
// no direct reads of paper/engine.ts's PaperState (mirrors paper/ext/marketRegime.ts
// and paper/ext/tradeArbiter.ts: callers pass in exactly the numbers this module
// needs, so it stays independently unit-testable and has no hidden global state).
//
// Strategy (classic ORB, options-buying variant):
//   1. Entry path   — mark the High/Low of the 09:15-09:30 IST opening range from
//                      1-minute candles. The first 1-minute candle to CLOSE outside
//                      that range triggers an ATM CE (break up) / PE (break down).
//   2. Confluence   — the breakout candle's volume must be >= 1.5x its own trailing
//                      20-period volume SMA (computed from bars BEFORE the breakout
//                      bar, so the confirmation never leaks the breakout bar into
//                      its own baseline).
//   3. Vetoes       — hard-blocked after 14:30 IST (no fresh ORB entries into the
//                      overnight-decay window), and hard-blocked by the centralized
//                      6% portfolio heat cap (config/arbitration.ts CONFIG.heatCap) —
//                      this module always enforces heat cap as a HARD block, with no
//                      advisory-only exception, regardless of what path an idea takes
//                      elsewhere in the app.
//   4. Exit         — a fixed 20% hard stop on the option's OWN premium (set once at
//                      entry, never loosened), plus a trailing TARGET (not a trailing
//                      stop) that ratchets outward every time the underlying advances
//                      another 10 points in the trade's favor: each ratchet re-bases
//                      the target on the premium gain actually realized over that
//                      10-point step (self-calibrating to the option's live delta,
//                      rather than assuming a fixed delta up front), then extends the
//                      target one more step ahead. Net effect: the position only
//                      exits on a pullback to the last-locked ratchet level or on the
//                      hard stop — never on a fixed, possibly-too-close, static target.

import { Candle } from "../types";
import { sma, last } from "../indicators";
import { istMinuteOfDay, istDateOfSec } from "../util/istTime";
import { CONFIG } from "../config/arbitration";
import type { OptionIdea } from "../paper/engine";

// ---- Tunables (named, not inlined — matches config/arbitration.ts's convention
// of one discoverable place per threshold; these are ORB-specific so they live
// here rather than in the shared arbitration config). ----
const OR_START_MIN = 9 * 60 + 15;      // 09:15 IST
const OR_END_MIN = 9 * 60 + 30;        // 09:30 IST (range is built from bars in [09:15, 09:30))
const LATE_ENTRY_VETO_MIN = 14 * 60 + 30; // 14:30 IST — no fresh ORB entries after this
const VOLUME_SMA_PERIOD = 20;
const VOLUME_CONFIRM_MULT = 1.5;
const STOP_LOSS_PCT = 0.20;            // 20% hard stop on premium, fixed at entry
const TRAIL_STEP_POINTS = 10;          // underlying move (points) per target ratchet
const MIN_STEP_PREMIUM_GAIN = 0.05;    // floor so a ratchet never goes backwards/flat
const INITIAL_TARGET_PCT = 0.15;       // seed target before the first ratchet fires

const round2 = (n: number) => Math.round(n * 100) / 100;

// ------------------------------- Opening range -------------------------------

export interface OrbRange {
  high: number;
  low: number;
  /** True once the 09:15-09:30 window has fully closed for this session. */
  formed: boolean;
  barsSeen: number;
}

/**
 * Builds the opening range from 1-minute candles. Pass the full day's 1m candles
 * (or at least everything from market open onward) for the session being checked.
 */
export function computeOpeningRange(candles1m: Candle[]): OrbRange | null {
  if (!candles1m || !candles1m.length) return null;
  const last1m = candles1m[candles1m.length - 1];
  const session = istDateOfSec(last1m.time);
  const orBars = candles1m.filter(
    (c) => istDateOfSec(c.time) === session && istMinuteOfDay(c.time) >= OR_START_MIN && istMinuteOfDay(c.time) < OR_END_MIN,
  );
  if (!orBars.length) return null;
  const formed = istMinuteOfDay(last1m.time) >= OR_END_MIN || orBars.length >= OR_END_MIN - OR_START_MIN;
  return {
    high: Math.max(...orBars.map((c) => c.high)),
    low: Math.min(...orBars.map((c) => c.low)),
    formed,
    barsSeen: orBars.length,
  };
}

// ------------------------------- Breakout detection -------------------------------

export interface OrbBreakoutSignal {
  optionType: "CE" | "PE";
  breakoutClose: number;
  breakoutEpochSec: number;
  rangeHigh: number;
  rangeLow: number;
  breakoutVolume: number;
  volumeSma20: number;
  volumeConfirmed: boolean;
  note: string;
}

/**
 * Scans the bars AFTER the opening range for the first 1-minute candle whose
 * CLOSE is outside the range. Pass `sinceEpochSec` (the last breakout you already
 * acted on, if any) so a tick loop calling this every minute doesn't re-fire on
 * the same bar — returns null once nothing new has happened.
 */
export function detectOrbBreakout(candles1m: Candle[], range: OrbRange, sinceEpochSec?: number): OrbBreakoutSignal | null {
  if (!range.formed) return null;
  const postRangeBars = candles1m.filter(
    (c) => istMinuteOfDay(c.time) >= OR_END_MIN && (sinceEpochSec == null || c.time > sinceEpochSec),
  );
  for (let i = 0; i < postRangeBars.length; i++) {
    const bar = postRangeBars[i];
    const isUpBreak = bar.close > range.high;
    const isDownBreak = bar.close < range.low;
    if (!isUpBreak && !isDownBreak) continue;

    // 20-period volume SMA computed from bars strictly BEFORE this breakout bar
    // (the confirmation must never include the bar it is confirming).
    const priorVols = candles1m.filter((c) => c.time < bar.time).map((c) => c.volume || 0);
    const volSma = priorVols.length >= VOLUME_SMA_PERIOD ? last(sma(priorVols, VOLUME_SMA_PERIOD)) ?? 0 : 0;
    const breakoutVolume = bar.volume || 0;
    const volumeConfirmed = volSma > 0 && breakoutVolume >= volSma * VOLUME_CONFIRM_MULT;

    return {
      optionType: isUpBreak ? "CE" : "PE",
      breakoutClose: round2(bar.close),
      breakoutEpochSec: bar.time,
      rangeHigh: round2(range.high),
      rangeLow: round2(range.low),
      breakoutVolume: round2(breakoutVolume),
      volumeSma20: round2(volSma),
      volumeConfirmed,
      note: volumeConfirmed
        ? `${isUpBreak ? "Up" : "Down"}-break of the 09:15-09:30 range on ${round2(breakoutVolume)} vol (>= ${VOLUME_CONFIRM_MULT}x the ${VOLUME_SMA_PERIOD}-bar SMA of ${round2(volSma)})`
        : `${isUpBreak ? "Up" : "Down"}-break seen but volume ${round2(breakoutVolume)} < ${VOLUME_CONFIRM_MULT}x SMA(${round2(volSma)}) — confluence not met`,
    };
  }
  return null;
}

// ------------------------------- Safety vetoes -------------------------------

export interface OrbEntryInputs {
  symbol: string;
  name: string;
  atmStrike: number;
  lotSize: number;
  /** Live LTP of the ATM CE/PE matching signal.optionType. */
  ltp: number;
  spot: number;
  nowEpochSec: number;
  /** Capital-guard snapshot — same numbers paper/engine.ts's openRisk()/totalStart() expose. */
  openRisk: number;
  startCapital: number;
}

/**
 * Builds the ORB entry idea, or returns a veto reason string (mirrors
 * tryOpenOption()'s own `Promise<string>` convention: "OPENED" vs. a Hindi/plain
 * skip reason) so this slots into the same tick-loop pattern as the rest of the
 * paper engine's idea builders.
 */
export function buildOrbEntry(signal: OrbBreakoutSignal, inputs: OrbEntryInputs): OptionIdea | string {
  // ---- Vetoes (checked before anything else — no capital at risk yet) ----
  if (istMinuteOfDay(inputs.nowEpochSec) >= LATE_ENTRY_VETO_MIN) {
    return `ORB veto: 14:30 IST cutoff passed — no fresh entry (overnight-decay risk)`;
  }
  if (!signal.volumeConfirmed) {
    return `ORB veto: volume confluence not met — ${signal.breakoutVolume} < ${VOLUME_CONFIRM_MULT}x SMA(${signal.volumeSma20})`;
  }
  if (inputs.ltp <= 0) {
    return `ORB veto: no live premium for ${inputs.symbol} ${signal.optionType} ${inputs.atmStrike}`;
  }

  const stopPremium = round2(inputs.ltp * (1 - STOP_LOSS_PCT));
  const lossPerLot = round2((inputs.ltp - stopPremium) * inputs.lotSize);

  // Centralized 6% heat cap — HARD block, always (see module header: this
  // engine does not carry the advisory-inside-extension exception documented
  // for the main directional path in config/arbitration.ts's heatCap entry).
  const heatCapAbs = inputs.startCapital * (CONFIG.heatCap.pct / 100);
  if (inputs.openRisk + lossPerLot > heatCapAbs) {
    return `ORB veto: portfolio heat cap (${CONFIG.heatCap.pct}%) — open risk ₹${round2(inputs.openRisk)} + this trade's ₹${lossPerLot} > cap ₹${round2(heatCapAbs)}`;
  }

  const targetPremium = round2(inputs.ltp * (1 + INITIAL_TARGET_PCT));

  return {
    symbol: inputs.symbol,
    name: `${inputs.name} (ORB)`,
    direction: signal.optionType === "CE" ? "Bullish" : "Bearish",
    optionType: signal.optionType,
    strike: inputs.atmStrike,
    premium: inputs.ltp,
    premiumTarget: targetPremium,   // seed only — updateOrbExit() ratchets this live
    premiumStop: stopPremium,       // fixed for the life of the trade
    spot: inputs.spot,
    spotTarget: signal.optionType === "CE" ? inputs.spot + TRAIL_STEP_POINTS : inputs.spot - TRAIL_STEP_POINTS,
    spotStop: signal.optionType === "CE" ? signal.rangeLow : signal.rangeHigh,
    lotSize: inputs.lotSize,
    expectedMovePct: round2(((targetPremium - inputs.ltp) / inputs.ltp) * 100),
    confidence: 68, // fixed: this strategy is binary (all four rules pass, or no trade) — no soft scoring
    thetaPctPerDay: 0,
    dte: null,
    strikeReason: `ORB · ${signal.note}`,
    timeframe: "1m",
    horizon: "Opening-range breakout (09:15-09:30)",
  } satisfies OptionIdea;
}

// ------------------------------- Position / exit management -------------------------------

export interface OrbPosition {
  symbol: string;
  optionType: "CE" | "PE";
  entryPremium: number;
  entrySpot: number;
  stopPremium: number;         // fixed at entry — never modified
  targetPremium: number;       // ratchets outward over the life of the trade
  /** Spot level the current ratchet step is measured from. */
  favorableSpotAnchor: number;
  /** Premium reading at favorableSpotAnchor — used to size the next ratchet step. */
  anchorPremium: number;
  entryEpochSec: number;
}

export function openOrbPosition(idea: OptionIdea, nowEpochSec: number): OrbPosition {
  return {
    symbol: idea.symbol,
    optionType: idea.optionType,
    entryPremium: idea.premium,
    entrySpot: idea.spot,
    stopPremium: idea.premiumStop,
    targetPremium: idea.premiumTarget,
    favorableSpotAnchor: idea.spot,
    anchorPremium: idea.premium,
    entryEpochSec: nowEpochSec,
  };
}

export interface OrbExitCheck {
  exit: boolean;
  exitPrice?: number;
  reason?: "stop" | "target";
  /** When set, the caller should persist these onto the open position (ratchet, no exit yet). */
  ratchet?: { targetPremium: number; favorableSpotAnchor: number; anchorPremium: number };
  note: string;
}

/**
 * Call on every tick for an open ORB position. Implements:
 *  - the fixed 20% hard stop (never re-checked or loosened once set at entry)
 *  - the 10-point trailing TARGET: every time the underlying advances another
 *    TRAIL_STEP_POINTS in the trade's favor, the target is re-based on the
 *    premium gain actually realized over that step (self-calibrating to the
 *    option's live delta) and pushed one more step further out. The position
 *    only closes on a pullback to the last-locked target or on the hard stop —
 *    it is deliberately never taken at a fixed, possibly-too-close level.
 */
export function updateOrbExit(pos: OrbPosition, liveSpot: number, livePremium: number): OrbExitCheck {
  if (livePremium <= pos.stopPremium) {
    return { exit: true, exitPrice: pos.stopPremium, reason: "stop", note: `Hard stop hit — premium ${livePremium} <= ${pos.stopPremium} (${STOP_LOSS_PCT * 100}% of entry ${pos.entryPremium})` };
  }

  const favorableMove = pos.optionType === "CE" ? liveSpot - pos.favorableSpotAnchor : pos.favorableSpotAnchor - liveSpot;
  if (favorableMove >= TRAIL_STEP_POINTS) {
    const realizedStepGain = Math.max(MIN_STEP_PREMIUM_GAIN, round2(livePremium - pos.anchorPremium));
    const newTarget = round2(livePremium + realizedStepGain);
    return {
      exit: false,
      ratchet: { targetPremium: newTarget, favorableSpotAnchor: liveSpot, anchorPremium: livePremium },
      note: `Underlying moved ${round2(favorableMove)}pts in favor — target ratcheted ${pos.targetPremium} -> ${newTarget} (realized step gain ${realizedStepGain})`,
    };
  }

  if (livePremium >= pos.targetPremium) {
    return { exit: true, exitPrice: pos.targetPremium, reason: "target", note: `Target hit at ${pos.targetPremium} (pullback from the last ratchet level)` };
  }

  return { exit: false, note: "No change — inside stop/target band" };
}
