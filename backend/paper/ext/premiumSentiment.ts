// ---- Step 5: premiumSentiment.ts ----
// Fires PER CANDIDATE entry. This is the ONLY module in the whole extension
// allowed to use an EMA, and it is applied to the OPTION PREMIUM series, never to
// the underlying.
//
//   rangePos    = (LTP − dayLow) / (dayHigh − dayLow) for the specific strike
//   underlyingBias = the existing directional call (reused, not recomputed)
//   premiumEMA9 = 9-period EMA on the premium's OWN LTP series, SLOPE only
//                 (rising / flat / falling)
//
// Classification:
//   low rangePos  + bias agrees + EMA flat/rising  -> Favorable
//   high rangePos + bias agrees + EMA flat/rising  -> Extended
//   low rangePos  + EMA falling                    -> Decaying
//   else                                           -> Neutral
//
// `Decaying` is a HARD SUPPRESS handled in tradeScore.ts as an explicit
// early-return veto (never a scoring penalty), so no other boost can outweigh it.

import { ema, last } from "../../indicators";
import { PremiumState, UnderlyingBias, clamp } from "./types";
import { CONFIG } from "../../config/arbitration";

export interface PremiumSentimentInputs {
  ltp: number;
  dayHigh: number | null;
  dayLow: number | null;
  underlyingBias: UnderlyingBias; // the existing directional call
  optionType: "CE" | "PE";
  premiumSeries: number[]; // the option's own recent premium LTP history, newest last
}

export interface PremiumSentimentResult {
  premiumState: PremiumState;
  rangePos: number | null; // 0..1 or null when the day range is unknown
  emaSlope: "rising" | "flat" | "falling";
  note: string;
}

const LOW_RANGE = 0.35;   // "low" in the day's premium range
const HIGH_RANGE = 0.65;  // "high" in the day's premium range
const SLOPE_BAND = 0.01;  // EMA change within ±1% counts as flat

function emaSlopeOf(series: number[]): "rising" | "flat" | "falling" {
  const period = CONFIG.premiumSentiment.emaPeriod;
  if (!series || series.length < period + 1) return "flat"; // not enough history -> treat as flat
  const e = ema(series, period);
  const cur = last(e);
  // find the value ~3 steps before the last non-null
  let prev: number | null = null;
  let seen = 0;
  for (let i = e.length - 1; i >= 0; i--) {
    if (e[i] != null) { seen++; if (seen === 4) { prev = e[i]!; break; } }
  }
  if (cur == null || prev == null || !(Math.abs(prev) > 1e-9)) return "flat";
  const chg = (cur - prev) / Math.abs(prev);
  if (chg > SLOPE_BAND) return "rising";
  if (chg < -SLOPE_BAND) return "falling";
  return "flat";
}

export function computePremiumSentiment(inp: PremiumSentimentInputs): PremiumSentimentResult {
  let rangePos: number | null = null;
  if (inp.dayHigh != null && inp.dayLow != null && inp.dayHigh > inp.dayLow) {
    rangePos = clamp((inp.ltp - inp.dayLow) / (inp.dayHigh - inp.dayLow), 0, 1);
  }
  const emaSlope = emaSlopeOf(inp.premiumSeries);

  // Does the directional call support this option's direction?
  const biasAgrees =
    (inp.optionType === "CE" && inp.underlyingBias === "Bullish") ||
    (inp.optionType === "PE" && inp.underlyingBias === "Bearish");

  const emaOk = emaSlope === "rising" || emaSlope === "flat";
  const lowPos = rangePos != null && rangePos <= LOW_RANGE;
  const highPos = rangePos != null && rangePos >= HIGH_RANGE;

  let premiumState: PremiumState = "Neutral";
  if (lowPos && emaSlope === "falling") {
    premiumState = "Decaying"; // hard-suppress condition (checked first is fine; falling dominates)
  } else if (lowPos && biasAgrees && emaOk) {
    premiumState = "Favorable";
  } else if (highPos && biasAgrees && emaOk) {
    premiumState = "Extended";
  } else {
    premiumState = "Neutral";
  }

  const note = `rangePos ${rangePos == null ? "n/a" : rangePos.toFixed(2)} · premEMA9 ${emaSlope} · bias ${biasAgrees ? "agrees" : "n/a"}`;
  return { premiumState, rangePos, emaSlope, note };
}
