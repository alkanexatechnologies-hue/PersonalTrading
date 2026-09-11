import { Candle } from "../types";
import { adx, atr, ema, last } from "../indicators";

// ---- Clean-Move Rating (option tradeability) ----
// Rates a stock by how CLEANLY it moves directionally - the trait that makes it
// good to BUY options on. A clean trender lets a bought call/put ride the move;
// a high-ATR but choppy/whipsaw stock bleeds theta even when it "moves".
//
// Ingredients:
//  - Efficiency Ratio (Kaufman): net move / total path travelled. ~1 = a clean
//    straight trend, ~0 = lots of back-and-forth. This is the core of "clean".
//  - ADX: trend STRENGTH (is there a real directional push).
//  - Move size: ATR% / average daily move - options need actual movement.
//  - Trend persistence: do moves follow through (runs of same-direction days).
//  - Choppiness Index + whipsaw count: penalise range-bound / reversing names.

export interface CleanMoveRating {
  symbol: string;
  name: string;
  price: number;
  rating: number; // 0-100 overall option-directional rating
  grade: "A+" | "A" | "B" | "C" | "D";
  efficiencyRatio: number; // 0-1 (cleanliness)
  adx: number; // trend strength
  atrPct: number; // typical daily range %
  avgAbsMovePct: number; // avg |daily move| %
  trendPersistence: number; // 0-100 follow-through
  whipsawPerMonth: number; // direction flips per ~21 sessions
  choppinessIndex: number; // 0-100 (low = trending, high = choppy)
  directionBias: "Up" | "Down" | "Neutral";
  hasOptions: boolean | null;
  note: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// Kaufman Efficiency Ratio over the last `w` closes.
function efficiencyRatio(closes: number[], w: number): number {
  const n = closes.length;
  if (n <= w) return 0;
  const net = Math.abs(closes[n - 1] - closes[n - 1 - w]);
  let path = 0;
  for (let i = n - w; i < n; i++) path += Math.abs(closes[i] - closes[i - 1]);
  return path > 0 ? net / path : 0;
}

// Choppiness Index over the last `w` bars (100*log10(sumTR/range)/log10(w)).
function choppiness(candles: Candle[], w: number): number {
  const n = candles.length;
  if (n <= w) return 50;
  let sumTr = 0;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = n - w; i < n; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    sumTr += tr;
    if (candles[i].high > hi) hi = candles[i].high;
    if (candles[i].low < lo) lo = candles[i].low;
  }
  const range = hi - lo;
  if (range <= 0 || sumTr <= 0) return 50;
  return clamp((100 * Math.log10(sumTr / range)) / Math.log10(w), 0, 100);
}

export function computeCleanMover(symbol: string, name: string, daily: Candle[]): CleanMoveRating | null {
  const n = daily.length;
  if (n < 60) return null;
  const closes = daily.map((c) => c.close);
  const price = closes[n - 1];
  if (!price) return null;

  // Cleanliness: blend a medium (20) and longer (40) efficiency ratio.
  const er20 = efficiencyRatio(closes, 20);
  const er40 = efficiencyRatio(closes, 40);
  const er = round2(0.6 * er20 + 0.4 * er40);

  // Trend strength.
  const a = adx(daily, 14);
  const adxV = last(a.adx) ?? 0;

  // Move size.
  const atrv = last(atr(daily, 14));
  const atrPct = atrv != null ? round2((atrv / price) * 100) : 0;
  const rets: number[] = [];
  for (let i = n - 20; i < n; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const avgAbsMovePct = round2(mean(rets.map((r) => Math.abs(r))) * 100);

  // Trend persistence: average run length of same-direction closes (last ~40),
  // normalised so long clean runs score high, alternating up/down scores low.
  let runs = 0;
  let runLen = 0;
  let sumRun = 0;
  let prevDir = 0;
  let flips = 0;
  const start = Math.max(1, n - 40);
  for (let i = start; i < n; i++) {
    const dir = Math.sign(closes[i] - closes[i - 1]);
    if (dir === 0) continue;
    if (dir === prevDir) runLen++;
    else {
      if (prevDir !== 0) { runs++; sumRun += runLen; flips++; }
      runLen = 1;
      prevDir = dir;
    }
  }
  if (runLen > 0) { runs++; sumRun += runLen; }
  const avgRun = runs ? sumRun / runs : 1;
  const trendPersistence = clamp(Math.round((avgRun - 1) / (4 - 1) * 100), 0, 100); // avgRun 1->0, >=4->100
  const sessions = n - start;
  const whipsawPerMonth = round1((flips / Math.max(1, sessions)) * 21);

  const chop = round1(choppiness(daily, 14));

  // Direction bias from net move + EMA slope.
  const ema20now = last(ema(closes, 20)) ?? price;
  const ema20prev = ema(closes, 20)[n - 6] ?? ema20now;
  const netW = closes[n - 1] - closes[n - 21];
  const dir = netW > 0 && ema20now >= ema20prev ? "Up" : netW < 0 && ema20now <= ema20prev ? "Down" : "Neutral";

  // ---- Composite rating (0-100) ----
  const erScore = er * 40; // cleanliness (0-40) - the dominant factor
  const adxScore = clamp(((adxV - 15) / (40 - 15)) * 25, 0, 25); // strength (0-25)
  const moveScore = clamp((atrPct - 1) * 10, 0, 20); // needs to move (0-20), ~3% -> 20
  const persistScore = (trendPersistence / 100) * 15; // follow-through (0-15)
  const chopPenalty = clamp(((chop - 38) / (61 - 38)) * 20, 0, 20); // choppy -> penalty (0-20)
  const rating = clamp(Math.round(erScore + adxScore + moveScore + persistScore - chopPenalty), 0, 100);

  const grade: CleanMoveRating["grade"] =
    rating >= 80 ? "A+" : rating >= 68 ? "A" : rating >= 55 ? "B" : rating >= 40 ? "C" : "D";

  const cleanWord = er >= 0.5 ? "very clean" : er >= 0.35 ? "clean" : er >= 0.22 ? "moderate" : "choppy";
  const note =
    `${grade} - ${cleanWord} trend (efficiency ${er}), ADX ${round1(adxV)} ` +
    `(${adxV >= 25 ? "strong" : adxV >= 18 ? "moderate" : "weak"} strength), moves ~${atrPct}%/day, ` +
    `${chop <= 38 ? "trending" : chop >= 61 ? "range-bound" : "mixed"} (chop ${chop}), ` +
    `${whipsawPerMonth <= 6 ? "low" : whipsawPerMonth <= 9 ? "some" : "high"} whipsaw. ` +
    `${rating >= 68 ? "Good for buying options - directional moves tend to follow through." : rating >= 55 ? "Usable for options with tight management." : "Poor for bought options - chop/theta risk."}`;

  return {
    symbol, name, price: round2(price), rating, grade,
    efficiencyRatio: er, adx: round1(adxV), atrPct, avgAbsMovePct,
    trendPersistence, whipsawPerMonth, choppinessIndex: chop,
    directionBias: dir, hasOptions: null, note,
  };
}
