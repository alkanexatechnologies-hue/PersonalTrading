// ---- Sentiment / Liquidity / Risk extension — shared types ----
// ADDITIVE ONLY. These types back the modules that layer on top of the existing
// paper engine's DIRECTIONAL option entries (OI TAKE + 1h bulletin baseTrigger).
// Nothing here touches Setup (entryRules.ts), the exit stack, or the capital-guard
// MATH — only how guards are ENFORCED (advisory, see riskComment.ts).

import { Candle, OiAnalysis, BurstState } from "../../types";

export type MarketRegime = "Trending" | "Compressed" | "Transitioning";
export type LiquidityState = "Normal" | "Thin";
export type SentimentState = "Bullish" | "Bearish" | "Neutral" | "Conflicted";
export type OpeningBiasState = "Bullish" | "Bearish" | "Neutral";
export type PremiumState = "Favorable" | "Extended" | "Decaying" | "Neutral";
export type WallReactionState = "REJECT" | "BREAK" | "UNCLEAR";

// Directional call reused across modules (the underlying's existing directional
// verdict — NOT recomputed by any extension module).
export type UnderlyingBias = "Bullish" | "Bearish" | "Neutral";

// Everything the extension pipeline needs for ONE candidate directional option
// idea. Assembled in api.ts (the only place with live-feed access) and injected
// into the engine via the optional TickDeps.getExtInputs closure, so the engine
// stays network-free and the modules stay pure/testable.
export interface ExtInputs {
  // --- shared underlying context ---
  candles5m: Candle[];
  candles15m: Candle[];
  daily: Candle[];
  oi: OiAnalysis | null;
  burstState: BurstState;
  squeezeOn: boolean; // Bollinger inside Keltner right now (coiling)

  // --- level / Setup outputs (READ-ONLY reuse of entryRules.levelContext) ---
  pdh: number | null;
  pdl: number | null;
  pdc: number | null;
  dayOpen: number | null;
  atrDaily: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  wallSupport: number | null;    // Setup's OI-wall support (majorSupport)
  wallResistance: number | null; // Setup's OI-wall resistance (majorResistance)

  // --- the candidate idea's own facts ---
  spot: number;
  direction: UnderlyingBias;     // the existing directional call (reused)
  optionType: "CE" | "PE";
  strike: number;
  premium: number;               // current option LTP
  premiumSeries: number[];       // recent option-premium LTP history (for EMA9 slope)

  // --- liquidity inputs (see liquidityGuard.ts; all optional, feed-dependent) ---
  liquidityInputs?: {
    spreadSeries?: number[];
    volumeByTod?: { current: number; sameTodAvg: number };
    chainOi?: { current: number; recentAvg: number };
  };

  // --- sentiment inputs (directional only) ---
  newsBias?: UnderlyingBias;     // getMarketNews().summary.bias
  pcrSeries?: number[];          // recent PCR values (rate-of-change), newest last
  ivSkewSeries?: { callIv: number; putIv: number }[]; // recent call/put IV pairs, newest last

  // --- wall-reaction inputs ---
  atWall: boolean;               // spot is within touch-band of a Setup wall
  wallRef: number | null;        // the wall strike/level being touched
  oiVelocity?: number;           // recent OI change at the touched strike (+rising / -falling)
  approachVolume?: number;       // relative approach-candle volume/speed (1 = average)
  touchCount: number;            // times this wall was tested this session

  // --- session/time context ---
  minutesIST: number;
  withinFirst30: boolean;        // within first 30 min post-open (openingBias window)

  // NOTE: the capital-guard snapshot (open risk, equity, peak, daily realised) is
  // computed INSIDE the engine from PaperState — the guard MATH stays where it is;
  // riskComment.ts only formats it into an advisory attached to the trade.
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export { clamp };
