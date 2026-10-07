// Synthetic candle builders for the Breakout Engine tests. Deterministic paths
// (no randomness) so every scenario is reproducible. Test-only.
import { Candle } from "../types";

// 2026-10-05 09:15 IST (Monday) and the following session.
export const DAY1 = Math.floor(Date.UTC(2026, 9, 5, 3, 45) / 1000);
export const DAY2 = Math.floor(Date.UTC(2026, 9, 6, 3, 45) / 1000);

export interface Leg { to: number; bars: number; wick?: number; vol?: number }

/** Build 5-minute candles that walk from `start` through each leg's target. */
export function path(t0: number, start: number, legs: Leg[], baseVol = 1000): Candle[] {
  const out: Candle[] = [];
  let p = start, t = t0;
  for (const leg of legs) {
    const step = (leg.to - p) / leg.bars;
    for (let k = 0; k < leg.bars; k++) {
      const o = p, c = p + step, w = leg.wick ?? Math.max(1, Math.abs(step) * 0.3);
      out.push({ time: t, open: +o.toFixed(2), high: +(Math.max(o, c) + w).toFixed(2), low: +(Math.min(o, c) - w).toFixed(2), close: +c.toFixed(2), volume: leg.vol ?? baseVol });
      p = c; t += 300;
    }
  }
  return out;
}

/** One quiet prior session (75 bars) oscillating in a band, then today's legs. */
export function session(prevMid: number, prevBand: number, todayStart: number, todayLegs: Leg[]): Candle[] {
  const prevLegs: Leg[] = [];
  for (let k = 0; k < 7; k++) prevLegs.push({ to: prevMid + (k % 2 === 0 ? prevBand : -prevBand), bars: k === 6 ? 15 : 10 });
  const prev = path(DAY1, prevMid, prevLegs);
  const today = path(DAY2, todayStart, todayLegs);
  return [...prev, ...today];
}

/** Replace the candle at `idx` (keeps time/volume unless given). */
export function setBar(cs: Candle[], idx: number, o: number, h: number, l: number, c: number, vol?: number): void {
  cs[idx] = { time: cs[idx].time, open: o, high: h, low: l, close: c, volume: vol ?? cs[idx].volume };
}
