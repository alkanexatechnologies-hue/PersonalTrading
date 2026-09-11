import { Candle, MomentumBurst } from "../types";
import { atr, bollinger, ema, last, macd } from "../indicators";

const KC_MULT = 1.5; // Keltner channel ATR multiplier
const SQUEEZE_LOOKBACK = 6; // bars to look back for a recent squeeze release

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Momentum-burst / scalp detector.
 *
 * Core idea (TTM-squeeze style): when Bollinger Bands contract INSIDE the Keltner
 * Channels, the market is coiling (low volatility) and energy is building. When
 * that squeeze releases and volatility + volume expand, a big directional move
 * often follows - a scalping opportunity. We also flag moves already underway.
 */
export function computeMomentumBurst(symbol: string, candles: Candle[]): MomentumBurst {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const price = closes[n - 1];

  // Bollinger (20,2) and Keltner (EMA20 +/- 1.5*ATR20).
  const bb = bollinger(closes, 20, 2);
  const kcMid = ema(closes, 20);
  const atr20 = atr(candles, 20);

  const squeezeSeries: boolean[] = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const bu = bb.upper[i];
    const bl = bb.lower[i];
    const mid = kcMid[i];
    const a = atr20[i];
    if (bu != null && bl != null && mid != null && a != null) {
      const kcU = mid + KC_MULT * a;
      const kcL = mid - KC_MULT * a;
      squeezeSeries[i] = bl > kcL && bu < kcU; // BB inside KC = squeeze on
    }
  }
  const squeezeOn = squeezeSeries[n - 1];
  // Did a squeeze release in the last few bars?
  let firedRecently = false;
  for (let i = Math.max(1, n - SQUEEZE_LOOKBACK); i < n; i++) {
    if (squeezeSeries[i - 1] && !squeezeSeries[i]) firedRecently = true;
  }

  // ATR expansion: current vs recent average.
  const atr14 = atr(candles, 14);
  const atrNow = last(atr14);
  const atrVals = atr14.filter((v) => v != null) as number[];
  const atrAvg = atrVals.length
    ? atrVals.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, atrVals.length)
    : null;
  const atrExpansion = atrNow != null && atrAvg ? atrNow / atrAvg : 1;
  const movementPct = atrNow != null && price ? (atrNow / price) * 100 : 0;

  // Volume surge (skip trailing zero-volume/partial bar).
  const vols = candles.map((c) => c.volume);
  let ri = n - 1;
  while (ri > 0 && vols[ri] === 0) ri--;
  const priorV = vols.slice(Math.max(0, ri - 20), ri);
  const avgV = priorV.length ? priorV.reduce((a, b) => a + b, 0) / priorV.length : 0;
  const volumeSurge = avgV > 0 ? vols[ri] / avgV : 0;

  // Range expansion of the last completed bar.
  const ranges = candles.map((c) => c.high - c.low);
  const avgRange = ranges.slice(Math.max(0, n - 21), n - 1).reduce((a, b) => a + b, 0) / 20 || 0;
  const rangeExpansion = avgRange > 0 ? ranges[n - 1] / avgRange : 1;

  // Direction from EMA9/21 + MACD histogram.
  const ema9 = last(ema(closes, 9));
  const ema21 = last(ema(closes, 21));
  const hist = last(macd(closes).histogram);
  let dir: "up" | "down" | "flat" = "flat";
  if (ema9 != null && ema21 != null) {
    if (ema9 > ema21 && (hist == null || hist >= 0)) dir = "up";
    else if (ema9 < ema21 && (hist == null || hist <= 0)) dir = "down";
    else dir = hist != null && hist > 0 ? "up" : hist != null && hist < 0 ? "down" : "flat";
  }

  // Classify state.
  const expanding = atrExpansion >= 1.4 || rangeExpansion >= 1.8;
  let state: MomentumBurst["state"];
  if (squeezeOn) state = "Squeeze";
  else if (firedRecently && (expanding || volumeSurge >= 1.5)) {
    state = dir === "down" ? "Fired Down" : "Fired Up";
  } else if (expanding && dir === "up") state = "Expanding Up";
  else if (expanding && dir === "down") state = "Expanding Down";
  else if (atrExpansion < 0.8 && volumeSurge < 1) state = "Quiet";
  else state = "Normal";

  // Burst score (0..100): energy building + expansion + volume + range + momentum.
  let score = 0;
  if (squeezeOn) score += 45; // coiled energy, move imminent
  if (firedRecently) score += 25;
  score += Math.min(25, Math.max(0, (atrExpansion - 1) * 40)); // expansion
  score += Math.min(15, Math.max(0, (volumeSurge - 1) * 15)); // volume
  score += Math.min(10, Math.max(0, (rangeExpansion - 1) * 8)); // range
  if (dir !== "flat") score += 5;
  const burstScore = Math.max(0, Math.min(100, Math.round(score)));

  const bigMove = expanding && volumeSurge >= 1.3 && dir !== "flat";

  const scalpNote = buildNote(state, dir, atrExpansion, volumeSurge, movementPct);

  return {
    symbol,
    price: round2(price),
    state,
    burstScore,
    direction: dir,
    squeezeOn,
    atrExpansion: round2(atrExpansion),
    volumeSurge: round2(volumeSurge),
    rangeExpansion: round2(rangeExpansion),
    movementPct: round2(movementPct),
    bigMove,
    scalpNote,
    asOf: candles[n - 1].time,
  };
}

function buildNote(
  state: MomentumBurst["state"],
  dir: string,
  atrExp: number,
  vol: number,
  movePct: number
): string {
  switch (state) {
    case "Squeeze":
      return `Coiling (low volatility) - a big move is building. Get ready to scalp the breakout ${
        dir !== "flat" ? "(bias " + dir + ")" : ""
      }. Enter on the release, not before.`;
    case "Fired Up":
      return `Squeeze just released UP with expansion (ATR ${atrExp}x, vol ${vol}x). Momentum scalp long; ride it with a tight trailing stop.`;
    case "Fired Down":
      return `Squeeze just released DOWN with expansion (ATR ${atrExp}x, vol ${vol}x). Momentum scalp short; keep a tight trailing stop.`;
    case "Expanding Up":
      return `Big move underway to the upside (ATR ${atrExp}x). Trend scalp long on pullbacks; avoid chasing extended spikes.`;
    case "Expanding Down":
      return `Big move underway to the downside (ATR ${atrExp}x). Trend scalp short on bounces; avoid chasing.`;
    case "Quiet":
      return `Low volatility, no setup - poor for scalping and options (theta bleed). Wait for a squeeze or expansion.`;
    default:
      return `Normal conditions (movement ~${movePct}%/bar). No strong burst signal right now.`;
  }
}
