// ============================ Trader Specific Strategies — registry ============================
// The curated strategy set and each strategy's CONDITION FINGERPRINT. Every fingerprint
// reasons ONLY over ConditionSnapshot fields (already produced by the existing engines),
// so this file adds no trade math — it maps "today's condition" to a match score and
// the trader-facing confirmation / trigger / invalidation copy.
//
// Reasoning behind the set (my own, not supplied logic): these are the six distinct,
// mutually-recognisable market postures this app can actually detect today. Each one
// is only *eligible* when its defining condition is present, so the layer stays
// selective — it does not trade every condition.

import { ConditionSnapshot, StrategyId, StrategyMatch, Bias } from "./types";

export interface StrategyDef {
  id: StrategyId;
  name: string;
  blurb: string;
  match: (s: ConditionSnapshot) => StrategyMatch;
  requiredConfirmation: (s: ConditionSnapshot) => string;
  trigger: (s: ConditionSnapshot) => string;
  invalidation: (s: ConditionSnapshot) => string;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const dirWord = (s: ConditionSnapshot): "up" | "down" =>
  s.regimeDir === "down" || s.directionBias === "Bearish" ? "down" : "up";
const biasAligns = (bias: Bias | null, dir: "up" | "down" | "flat" | null): boolean =>
  (bias === "Bullish" && dir === "up") || (bias === "Bearish" && dir === "down");
const lateStage = (s: ConditionSnapshot) =>
  s.moveStage === "EXTENDED" || s.moveStage === "EXHAUSTION" || s.moveStage === "REVERSAL_WATCH";
const supRes = (s: ConditionSnapshot, dir: "up" | "down") =>
  dir === "up" ? (s.wallResistance != null ? `₹${s.wallResistance}` : "the resistance wall")
               : (s.wallSupport != null ? `₹${s.wallSupport}` : "the support wall");

export const STRATEGIES: StrategyDef[] = [
  {
    id: "trend_continuation",
    name: "Trend Continuation",
    blurb: "Ride an established, healthy trend in its own direction.",
    match: (s) => {
      const why: string[] = [];
      const eligible = s.regime === "Trending";
      if (!eligible) return { match: 0, eligible, why: ["Market is not trending today."] };
      let m = 60; why.push(`Market is trending ${s.regimeDir === "down" ? "down" : "up"}.`);
      if (s.moveStage === "STRONG_MOVE" || s.moveStage === "DEVELOPING") { m += 20; why.push("Move is developing/strong, not yet stretched."); }
      if (biasAligns(s.directionBias, s.regimeDir)) { m += 10; why.push("Directional bias agrees with the trend."); }
      if (s.burstState === "Expanding Up" || s.burstState === "Expanding Down") { m += 8; why.push("Momentum is expanding with the trend."); }
      if (lateStage(s)) { m -= 35; why.push("Trend looks extended/exhausted — continuation risk is higher."); }
      return { match: clamp(m), eligible, why };
    },
    requiredConfirmation: () => "Price holding on the trend side of its rising/falling EMAs; pullbacks being bought/sold.",
    trigger: (s) => `Break of the last swing ${dirWord(s) === "up" ? "high" : "low"} in the trend direction.`,
    invalidation: (s) => `A close back beyond the most recent ${dirWord(s) === "up" ? "higher-low" : "lower-high"} (trend structure broken).`,
  },
  {
    id: "squeeze_breakout",
    name: "Squeeze Breakout",
    blurb: "Volatility is coiled; trade the expansion when it releases.",
    match: (s) => {
      const why: string[] = [];
      const firing = s.burstState === "Fired Up" || s.burstState === "Fired Down";
      const eligible = firing || s.burstState === "Squeeze" || s.regime === "Compressed" || s.regime === "Transitioning";
      if (!eligible) return { match: 0, eligible, why: ["No volatility squeeze or release detected."] };
      let m = 50;
      if (firing) { m += 30; why.push(`Squeeze just released (${s.burstState}).`); }
      else if (s.burstState === "Squeeze" || s.regime === "Compressed") { m += 18; why.push("Volatility is compressed / coiling."); }
      else { m += 8; why.push("Market is transitioning between states."); }
      if (s.withinFirst30) { m += 6; why.push("Early session — expansion has room to run."); }
      if (s.liquidityState === "Thin") { m -= 12; why.push("Thin liquidity — breakouts can be unreliable."); }
      return { match: clamp(m), eligible, why };
    },
    requiredConfirmation: () => "A clear volatility squeeze followed by a wide expansion candle with above-average volume.",
    trigger: () => "The first expansion candle that closes out of the squeeze range, in the release direction.",
    invalidation: () => "Price falling back inside the squeeze range (failed breakout).",
  },
  {
    id: "opening_range_breakout",
    name: "Opening Range Breakout",
    blurb: "Trade a clean break of the first 15–30 minute range.",
    match: (s) => {
      const why: string[] = [];
      const eligible = s.withinFirst30;
      if (!eligible) return { match: 0, eligible, why: ["Outside the opening-range window."] };
      let m = 55; why.push("Inside the opening-range window.");
      if (s.openingBias === "Bullish" || s.openingBias === "Bearish") { m += 25; why.push(`Opening drive is ${s.openingBias!.toLowerCase()}.`); }
      if (biasAligns(s.openingBias, s.regimeDir)) { m += 8; why.push("Opening drive agrees with the day's direction."); }
      if (s.liquidityState === "Thin") { m -= 12; why.push("Thin liquidity — opening break can whipsaw."); }
      return { match: clamp(m), eligible, why };
    },
    requiredConfirmation: () => "A decisive break and hold of the opening range (not a wick).",
    trigger: () => "Break of the opening-range high/low with follow-through.",
    invalidation: () => "Price re-entering the opening range after the break.",
  },
  {
    id: "wall_rejection",
    name: "Wall Rejection",
    blurb: "Fade a strong OI wall that price is rejecting.",
    match: (s) => {
      const why: string[] = [];
      const eligible = s.atWall && s.wallReactionState === "REJECT";
      if (!eligible) return { match: 0, eligible, why: ["Price is not rejecting an OI wall."] };
      let m = 55; why.push("Price is rejecting a defended OI wall.");
      if (s.regime === "Compressed" || s.regime === "Transitioning") { m += 12; why.push("Range/compressed regime favours mean-reversion off the wall."); }
      if (s.liquidityState === "Normal") { m += 8; why.push("Liquidity is normal."); }
      if (s.regime === "Trending") { m -= 20; why.push("Strong trend can plough through walls — caution."); }
      return { match: clamp(m), eligible, why };
    },
    requiredConfirmation: () => "A rejection candle at the OI wall with option OI defending that strike.",
    trigger: () => "A reversal candle off the wall, away from it.",
    invalidation: (s) => `A sustained close beyond the wall (${supRes(s, dirWord(s))}).`,
  },
  {
    id: "wall_breakout",
    name: "Wall Breakout",
    blurb: "Trade a decisive break through an OI wall.",
    match: (s) => {
      const why: string[] = [];
      const eligible = s.atWall && s.wallReactionState === "BREAK";
      if (!eligible) return { match: 0, eligible, why: ["No confirmed break through an OI wall."] };
      let m = 55; why.push("Price is breaking through an OI wall.");
      if (s.regime === "Trending" && biasAligns(s.directionBias, s.regimeDir)) { m += 12; why.push("Break aligns with the prevailing trend."); }
      if (s.burstState === "Fired Up" || s.burstState === "Fired Down" || s.burstState === "Expanding Up" || s.burstState === "Expanding Down") { m += 10; why.push("Momentum is expanding through the level."); }
      if (s.liquidityState === "Thin") { m -= 10; why.push("Thin liquidity — break can fail."); }
      return { match: clamp(m), eligible, why };
    },
    requiredConfirmation: () => "A decisive close beyond the wall with OI unwinding at that strike.",
    trigger: () => "A close beyond the wall on above-average volume.",
    invalidation: () => "Price falling back inside the wall (break rejected).",
  },
  {
    id: "pullback_continuation",
    name: "Pullback Continuation",
    blurb: "Enter a trend on a shallow pullback, not at the extreme.",
    match: (s) => {
      const why: string[] = [];
      const eligible = s.regime === "Trending" && s.moveStage === "PULLBACK";
      if (!eligible) return { match: 0, eligible, why: ["No trend-pullback setup right now."] };
      let m = 60; why.push("Trend is pulling back — a lower-risk entry than chasing.");
      if (biasAligns(s.directionBias, s.regimeDir)) { m += 12; why.push("Bias still agrees with the trend."); }
      if (!lateStage(s)) { m += 8; why.push("Trend is not exhausted."); }
      else { m -= 20; why.push("Trend looks late — pullback may become a reversal."); }
      return { match: clamp(m), eligible, why };
    },
    requiredConfirmation: () => "A shallow pullback to trend support/resistance, then a resumption candle.",
    trigger: (s) => `A resumption candle in the trend direction after the pullback (${dirWord(s)}).`,
    invalidation: () => "The pullback deepening past the prior swing (trend likely over).",
  },
];

export function strategyById(id: StrategyId): StrategyDef | undefined {
  return STRATEGIES.find((x) => x.id === id);
}
