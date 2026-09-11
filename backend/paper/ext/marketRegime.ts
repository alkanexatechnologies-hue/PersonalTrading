// ---- Step 1: marketRegime.ts ----
// Continuous module. No dependency on other new modules.
//
// Classifies the current index state as Trending / Compressed / Transitioning.
//  - Swing-fractal slope: REUSES the existing 2-bar fractal detection in
//    entryRules.ts by CALLING its exported levelContext() (read-only). We never
//    copy or modify the fractal, and we never touch Setup's inputs. levelContext
//    surfaces the fractal's swingHigh/swingLow; we sample it across three
//    progressively-later windows to read whether swings are stepping up
//    (higher highs + higher lows) or down. 3+ consecutive HH+HL => Trending.
//  - ATR contraction: current ATR vs its 20-bar rolling average. Meaningfully
//    below average => Compressed.
//  - Squeeze->fire transition (read from momentum.ts burst state) => Transitioning.

import { Candle, OiAnalysis, BurstState } from "../../types";
import { levelContext } from "../entryRules";
import { atr, last } from "../../indicators";
import { MarketRegime } from "./types";

export interface RegimeResult {
  marketRegime: MarketRegime;
  regimeDir: "up" | "down" | "flat";
  note: string;
}

// How far below the rolling-average ATR counts as a meaningful contraction.
const CONTRACTION = 0.85; // curATR < 85% of the 20-bar avg ATR
const WINDOW_STEP = 8;    // bars between fractal-slope samples

// Sample the entryRules fractal (via the exported levelContext) at three window
// ends and return the sequence of {high, low} swing points (oldest first).
function fractalSwingSequence(candles: Candle[], daily: Candle[], oi: OiAnalysis | null): { high: number; low: number }[] {
  const n = candles.length;
  const out: { high: number; low: number }[] = [];
  // Oldest -> newest so we can check for a stepping (monotonic) sequence.
  const ends = [n - 2 * WINDOW_STEP, n - WINDOW_STEP, n];
  for (const end of ends) {
    if (end < 30) continue; // levelContext needs a reasonable window
    const lv = levelContext(candles.slice(0, end), daily, oi);
    if (lv.swingHigh != null && lv.swingLow != null) out.push({ high: lv.swingHigh, low: lv.swingLow });
  }
  return out;
}

function isSteppingUp(seq: { high: number; low: number }[]): boolean {
  if (seq.length < 3) return false;
  for (let i = 1; i < seq.length; i++) {
    if (!(seq[i].high > seq[i - 1].high && seq[i].low > seq[i - 1].low)) return false;
  }
  return true;
}
function isSteppingDown(seq: { high: number; low: number }[]): boolean {
  if (seq.length < 3) return false;
  for (let i = 1; i < seq.length; i++) {
    if (!(seq[i].high < seq[i - 1].high && seq[i].low < seq[i - 1].low)) return false;
  }
  return true;
}

export function computeMarketRegime(
  candles: Candle[],
  daily: Candle[],
  oi: OiAnalysis | null,
  burstState: BurstState,
): RegimeResult {
  // 1) Trending via reused fractal slope (3+ consecutive HH+HL / LH+LL).
  const seq = fractalSwingSequence(candles, daily, oi);
  if (isSteppingUp(seq)) {
    return { marketRegime: "Trending", regimeDir: "up", note: `3+ higher highs + higher lows (fractal, ${seq.length} swings)` };
  }
  if (isSteppingDown(seq)) {
    return { marketRegime: "Trending", regimeDir: "down", note: `3+ lower highs + lower lows (fractal, ${seq.length} swings)` };
  }

  // 2) ATR contraction vs its own 20-bar rolling average.
  const atrSeries = atr(candles, 14).filter((v): v is number => v != null);
  const curAtr = last(atr(candles, 14));
  let compressed = false;
  if (curAtr != null && atrSeries.length >= 20) {
    const win = atrSeries.slice(-20);
    const avg = win.reduce((a, b) => a + b, 0) / win.length;
    if (avg > 0 && curAtr < avg * CONTRACTION) compressed = true;
  }

  // 3) Squeeze->fire transition (from momentum burst state). A "Fired" state is a
  //    squeeze that just released; that IS the transition. A live "Squeeze" is
  //    still coiling => Compressed.
  const firing = burstState === "Fired Up" || burstState === "Fired Down";

  if (compressed && burstState !== "Fired Up" && burstState !== "Fired Down") {
    return { marketRegime: "Compressed", regimeDir: "flat", note: `ATR contracted (< ${Math.round(CONTRACTION * 100)}% of 20-bar avg)` };
  }
  if (firing) {
    const dir = burstState === "Fired Up" ? "up" : "down";
    return { marketRegime: "Transitioning", regimeDir: dir, note: `squeeze->fire transition (${burstState})` };
  }
  if (burstState === "Squeeze") {
    return { marketRegime: "Compressed", regimeDir: "flat", note: "coiling (Bollinger inside Keltner squeeze)" };
  }
  // Neither clearly trending nor compressed, no fire: treat as Transitioning
  // (indeterminate — between states).
  return { marketRegime: "Transitioning", regimeDir: "flat", note: "no clear trend or contraction" };
}
