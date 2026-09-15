// ============================ Gated Trending path (ADDITIVE, feature-flagged) ============================
// PURPOSE (and ONLY purpose): restore eligibility of Trend Continuation and Pullback
// Continuation on GENUINE trend conditions. Validation (90 sessions × NIFTY+BANKNIFTY,
// strict no-look-ahead) showed the existing fractal/ATR Trending detector had 0% recall
// on real trend days, so those two strategies never became eligible.
//
// SCOPE — read carefully:
//   * This path is consumed ONLY by the Trader Specific Strategies selector (it augments
//     the regime in that layer's ConditionSnapshot). It does NOT modify computeMarketRegime,
//     which the Master Trade Selector / Option Engine / Risk path continue to use unchanged.
//     That keeps requirements #3–#6 (no change to MTS/Option/Risk/execution) intact while
//     still adding a second, additive route to "Trending" for the strategy layer.
//   * It is purely ADDITIVE: the existing regime read wins whenever it already says Trending;
//     this only fires when the existing path did NOT already classify Trending.
//
// FROZEN LOGIC — do not retune here. These are exactly the thresholds validated in the
// approved A/B (VWAP-side + stacked EMA + magnitude >= 0.6*ATR + ATR expansion):
//   1) sustained VWAP side: the last 6 (5-minute) closes all on one side of VWAP
//   2) stacked EMAs: EMA9 > EMA21 > EMA50 (up) / EMA9 < EMA21 < EMA50 (down)
//   3) EMA9 slope over the last 6 bars in the trend direction
//   4) magnitude gate: |spot - session open| >= 0.6 * daily ATR  (a real move, not drift)
//   5) volatility expanding: current 14-bar ATR > 1.1 * its own 20-bar average
//
// REVERSIBLE: set env GATED_TREND=off to disable instantly (falls back to the existing
// detector only). Default ON so the approved change is active for paper validation.

import { Candle } from "../types";
import { ema, vwap, atr, last } from "../indicators";

export const GATED_TREND_ENABLED = process.env.GATED_TREND !== "off";

export interface GatedTrendResult {
  trend: boolean;
  dir: "up" | "down" | null;
  note: string;
}

// Session open = the open of the first candle of the current IST day within the
// provided 5-minute series (getCandlesCached returns a rolling multi-day window).
export function sessionOpenFrom(c5: Candle[]): number | null {
  if (!c5 || !c5.length) return null;
  const istDate = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
  const today = istDate(c5[c5.length - 1].time);
  const first = c5.find((b) => istDate(b.time) === today);
  return first ? first.open : null;
}

export function gatedTrend(c5: Candle[], dailyATR: number | null, dayOpen: number | null): GatedTrendResult {
  if (!GATED_TREND_ENABLED) return { trend: false, dir: null, note: "gated path disabled" };
  const n = c5 ? c5.length : 0;
  if (n < 11 || dailyATR == null || dailyATR <= 0 || dayOpen == null) return { trend: false, dir: null, note: "insufficient data" };
  const closes = c5.map((x) => x.close);
  const spot = closes[n - 1];
  const vwS = vwap(c5);
  const e9s = ema(closes, 9);
  const e9 = last(e9s), e21 = last(ema(closes, 21)), e50 = last(ema(closes, 50)), e9prev = e9s[e9s.length - 7];
  if (e9 == null || e21 == null || e50 == null || e9prev == null) return { trend: false, dir: null, note: "indicators unavailable" };
  const l6 = c5.slice(-6), v6 = vwS.slice(-6);
  const above = l6.every((b, k) => v6[k] != null && b.close > (v6[k] as number));
  const below = l6.every((b, k) => v6[k] != null && b.close < (v6[k] as number));
  const moveOk = Math.abs(spot - dayOpen) >= 0.6 * dailyATR;
  const aSeries = atr(c5, 14).filter((x): x is number => x != null);
  const aNow = aSeries.length ? aSeries[aSeries.length - 1] : null;
  const aAvg = aSeries.length >= 20 ? aSeries.slice(-20).reduce((x, y) => x + y, 0) / 20 : null;
  const expanding = aNow != null && aAvg != null && aNow > 1.1 * aAvg;
  if (!moveOk) return { trend: false, dir: null, note: "move < 0.6x ATR (drift, not trend)" };
  if (!expanding) return { trend: false, dir: null, note: "ATR not expanding" };
  if (above && e9 > e21 && e21 > e50 && e9 > e9prev && spot > dayOpen)
    return { trend: true, dir: "up", note: "gated Trending UP: sustained above VWAP + stacked EMAs + move>=0.6ATR + expanding" };
  if (below && e9 < e21 && e21 < e50 && e9 < e9prev && spot < dayOpen)
    return { trend: true, dir: "down", note: "gated Trending DOWN: sustained below VWAP + stacked EMAs + move>=0.6ATR + expanding" };
  return { trend: false, dir: null, note: "VWAP/EMA not aligned" };
}
