// ---- Sentiment/Liquidity/Risk extension — PURE scoring pipeline ----
// Steps 1–7 of the extension, composed as a single pure function with NO side
// effects (no dedup arming, no logging, no riskComment). Used by BOTH:
//   - engine.ts runExtPipeline (which adds openingBias logging + display
//     threshold + dedup + riskComment on top), and
//   - the OI Command route (read-only display of what the modules say about the
//     current directional recommendation).
// Keeping this pure means the cockpit can show the exact same numbers the engine
// scores with, with zero risk of a divergent second implementation.

import { computeMarketRegime, RegimeResult } from "./marketRegime";
import { computeLiquidityGuard, LiquidityResult } from "./liquidityGuard";
import { computeSentiment4L, Sentiment4LResult } from "./sentiment4L";
import { computeOpeningBias, OpeningBiasResult } from "./openingBias";
import { computePremiumSentiment, PremiumSentimentResult } from "./premiumSentiment";
import { computeWallReaction, WallReactionResult } from "./wallReaction";
import { computeTradeScore, TradeScoreResult } from "./tradeScore";
import { ExtInputs, WallReactionState } from "./types";

export interface ExtScore {
  regime: RegimeResult;
  liquidity: LiquidityResult;
  sentiment: Sentiment4LResult;
  premium: PremiumSentimentResult;
  wall: WallReactionResult;
  openingBias?: OpeningBiasResult;
  score: TradeScoreResult;
}

// idea: the directional candidate (strike/optionType/confidence/strikeReason are read).
// baseConfidence: the existing calibrated win-probability source (52..62), passed
// in so this stays pure (the engine computes it via calibratedWinProb; the route
// computes it the same way).
export function scoreExtension(
  inp: ExtInputs,
  idea: { direction: "Bullish" | "Bearish"; optionType: "CE" | "PE" },
  baseConfidence: number,
  opts: { excludeSentiment?: boolean } = {},
): ExtScore {
  // 1) market regime
  const regime = computeMarketRegime(inp.candles15m, inp.daily, inp.oi, inp.burstState);
  // 2) liquidity
  const liquidity = computeLiquidityGuard(inp.liquidityInputs || {});
  // 3) sentiment (directional-only)
  const sentiment = computeSentiment4L({ newsBias: inp.newsBias, pcrSeries: inp.pcrSeries, ivSkewSeries: inp.ivSkewSeries });
  // 4) opening bias (computed only within the first 30 min; caller does any logging)
  let openingBias: OpeningBiasResult | undefined;
  if (inp.withinFirst30) {
    openingBias = computeOpeningBias({
      open: inp.dayOpen ?? inp.spot, pdc: inp.pdc, pdh: inp.pdh, pdl: inp.pdl,
      atr: inp.atrDaily, wallSupport: inp.wallSupport, wallResistance: inp.wallResistance,
    });
  }
  // 5) premium sentiment (per candidate; ONLY EMA in the extension)
  const premium = computePremiumSentiment({
    ltp: inp.premium, dayHigh: inp.dayHigh, dayLow: inp.dayLow,
    underlyingBias: inp.direction, optionType: inp.optionType, premiumSeries: inp.premiumSeries,
  });
  // 6) wall reaction (regime + liquidity are shared context)
  const wall: WallReactionResult = inp.atWall
    ? computeWallReaction({
        oiVelocity: inp.oiVelocity, burstState: inp.burstState, approachVolume: inp.approachVolume,
        touchCount: inp.touchCount, regime: regime.marketRegime, liquidity: liquidity.liquidityState, priorSqueeze: inp.squeezeOn,
      })
    : { wallReactionState: "UNCLEAR" as WallReactionState, lean: 0, note: "not at a Setup wall" };
  // 7) composite score. For Scalp candidates (opts.excludeSentiment) sentiment and
  // opening-bias are withheld entirely — they must never influence Scalp. Regime
  // and liquidity still apply (shared context, allowed by the arbiter constraint).
  const score = computeTradeScore({
    baseTrigger: true, // OI TAKE + 1h / 5m+15m already gated upstream
    baseConfidence,
    direction: inp.direction,
    premiumState: premium.premiumState,
    regime: regime.marketRegime,
    wallReaction: wall.wallReactionState,
    sentimentState: opts.excludeSentiment ? "Neutral" : sentiment.sentimentState,
    liquidityState: liquidity.liquidityState,
    openingBias: opts.excludeSentiment ? undefined : openingBias?.openingBias,
    withinFirst30: opts.excludeSentiment ? false : inp.withinFirst30,
  });

  return { regime, liquidity, sentiment, premium, wall, openingBias, score };
}
