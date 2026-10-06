// Universal indicator components. Every function is CAUSAL: a value at index i
// uses only candles with index <= i. Structure/S-R use a bounded trailing window
// (keeps it O(n·W), and strictly backward-looking — no future candles).
// Reuses the production indicator math (ema/vwap/atr) and detectMarketStructure.

import { Candle } from "../types";
import { ema, atr, vwap, last } from "../indicators";
import { detectMarketStructure } from "../liquidity/orderBlock";

export function emaSeries(cands: Candle[], p: number) { return ema(cands.map((c) => c.close), p); }
export function atrSeries(cands: Candle[], p: number) { return atr(cands, p); }
export function vwapSeries(cands: Candle[]) { return vwap(cands); }

// ---- UT Bot / UT Alert (ATR trailing-stop early-movement detector) ----
// Classic UT Bot: nLoss = key*ATR(period); iterative trailing stop; state flips
// when close crosses the stop. Causal (uses i and i-1 only).
export function utBot(cands: Candle[], key: number, atrPeriod: number): Array<"BULLISH" | "BEARISH" | "NEUTRAL"> {
  const n = cands.length;
  const a = atr(cands, atrPeriod);
  const stop: number[] = new Array(n).fill(0);
  const state: Array<"BULLISH" | "BEARISH" | "NEUTRAL"> = new Array(n).fill("NEUTRAL");
  let prevStop = 0, prevClose = 0, pos = 0;
  for (let i = 0; i < n; i++) {
    const src = cands[i].close;
    const nLoss = (a[i] ?? 0) * key;
    let st: number;
    if (i === 0 || a[i] == null) { st = src - nLoss; }
    else if (src > prevStop && prevClose > prevStop) st = Math.max(prevStop, src - nLoss);
    else if (src < prevStop && prevClose < prevStop) st = Math.min(prevStop, src + nLoss);
    else st = src > prevStop ? src - nLoss : src + nLoss;
    if (prevClose <= prevStop && src > st) pos = 1;
    else if (prevClose >= prevStop && src < st) pos = -1;
    stop[i] = st;
    state[i] = pos > 0 ? "BULLISH" : pos < 0 ? "BEARISH" : "NEUTRAL";
    prevStop = st; prevClose = src;
  }
  return state;
}

// ---- Linear regression over a trailing window (slope normalized by price) ----
export function linReg(closes: number[]): { direction: "UP" | "DOWN" | "FLAT"; slope: number; r2: number } {
  const n = closes.length;
  if (n < 3) return { direction: "FLAT", slope: 0, r2: 0 };
  let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const x = i, y = closes[i]; sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { direction: "FLAT", slope: 0, r2: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const r = (n * sxy - sx * sy) / Math.sqrt(Math.max(1e-9, (n * sxx - sx * sx) * (n * syy - sy * sy)));
  const avg = sy / n;
  const slopePctPerBar = avg ? (slope / avg) * 100 : 0;
  const dir = slopePctPerBar > 0.01 ? "UP" : slopePctPerBar < -0.01 ? "DOWN" : "FLAT";
  return { direction: dir, slope: +slope.toFixed(4), r2: +(r * r).toFixed(3) };
}

// ---- Support / Resistance from recent swing highs/lows in a trailing window ----
// `supports` / `resistances` list every level nearest-first (the window extreme
// is the last fallback) so a target can skip a level that is too close to entry.
export function supportResistance(window: Candle[], price: number): {
  support: number | null; resistance: number | null; supports: number[]; resistances: number[];
} {
  if (window.length < 5) return { support: null, resistance: null, supports: [], resistances: [] };
  const highs: number[] = [], lows: number[] = [];
  for (let i = 2; i < window.length - 2; i++) {
    const h = window[i].high, l = window[i].low;
    if (h > window[i - 1].high && h > window[i - 2].high && h >= window[i + 1].high && h >= window[i + 2].high) highs.push(h);
    if (l < window[i - 1].low && l < window[i - 2].low && l <= window[i + 1].low && l <= window[i + 2].low) lows.push(l);
  }
  const belows = lows.filter((l) => l < price).sort((a, b) => b - a);
  const aboves = highs.filter((h) => h > price).sort((a, b) => a - b);
  // fall back to window extremes so S/R is always defined
  const minLow = Math.min(...window.map((c) => c.low));
  const maxHigh = Math.max(...window.map((c) => c.high));
  const support = belows[0] ?? minLow;
  const resistance = aboves[0] ?? maxHigh;
  const supports = belows.length ? (minLow < belows[belows.length - 1] ? [...belows, minLow] : belows) : [minLow];
  const resistances = aboves.length ? (maxHigh > aboves[aboves.length - 1] ? [...aboves, maxHigh] : aboves) : [maxHigh];
  return { support, resistance, supports, resistances };
}

// ---- Volume state (NORMALIZED vs trailing median — no fixed "2 million" rule) ----
export function volumeState(window: number[], cur: number, expMult: number, weakMult: number): "NORMAL" | "EXPANSION" | "WEAK" | "UNKNOWN" {
  const vals = window.filter((v) => v > 0);
  if (!vals.length || !(cur > 0)) return "UNKNOWN";
  const sorted = [...vals].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  if (med <= 0) return "UNKNOWN";
  if (cur >= med * expMult) return "EXPANSION";
  if (cur <= med * weakMult) return "WEAK";
  return "NORMAL";
}

// ---- Market structure + BOS (causal, windowed) ----
export function structureAt(window: Candle[]): { structure: string; bos: string } {
  try {
    const ms = detectMarketStructure(window, 3);
    const cur = ms.currentStructure || "Ranging";
    const pre = ms.preStructure && ms.preStructure !== cur ? `/prov:${ms.preStructure}` : "";
    const lastBos = (ms.bosEvents || [])[ms.bosEvents.length - 1];
    let bos = "NONE";
    if (lastBos) {
      const dir = String(lastBos.direction).toLowerCase().startsWith("bull") ? "UP" : "DOWN";
      const stage = (lastBos.stage || "").toLowerCase().startsWith("conf") ? "CONFIRMED" : "PRE";
      bos = `${stage}-${dir}`;
    }
    return { structure: `${cur}${pre}`, bos };
  } catch {
    return { structure: "Ranging", bos: "NONE" };
  }
}

// ---- Fake move: break of prior swing then reject back inside, within the data
// available up to the current candle only (never uses later candles). ----
export function fakeMoveAt(window: Candle[]): boolean {
  if (window.length < 6) return false;
  const i = window.length - 1;
  const cur = window[i];
  const prior = window.slice(Math.max(0, i - 6), i);
  const priorHigh = Math.max(...prior.map((c) => c.high));
  const priorLow = Math.min(...prior.map((c) => c.low));
  const bullTrap = cur.high > priorHigh && cur.close < priorHigh; // poked above, closed back under
  const bearTrap = cur.low < priorLow && cur.close > priorLow;    // poked below, closed back over
  return bullTrap || bearTrap;
}

export { last };
