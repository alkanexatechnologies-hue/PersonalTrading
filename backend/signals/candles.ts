import { Candle } from "../types";

// ---- Candlestick pattern detection ----
// Reads the last 1-3 candles and returns a directional bias so the paper engine
// can add an EXTRA confirmation: don't take a trade when the latest candle
// pattern clearly opposes the intended direction.

export interface CandleSignal {
  pattern: string;
  bias: 1 | -1 | 0; // +1 bullish, -1 bearish, 0 neutral/indecision
  strength: number; // 0-1
  reason: string;
}

const body = (c: Candle) => Math.abs(c.close - c.open);
const range = (c: Candle) => Math.max(c.high - c.low, 1e-9);
const upperWick = (c: Candle) => c.high - Math.max(c.open, c.close);
const lowerWick = (c: Candle) => Math.min(c.open, c.close) - c.low;
const isBull = (c: Candle) => c.close > c.open;

export function detectCandlePattern(candles: Candle[]): CandleSignal {
  const n = candles.length;
  if (n < 2) return { pattern: "None", bias: 0, strength: 0, reason: "Not enough candles." };
  const c = candles[n - 1];
  const p = candles[n - 2];
  const p2 = n >= 3 ? candles[n - 3] : null;
  const bodyPct = body(c) / range(c);

  // --- 3-candle stars (strong reversal) ---
  if (p2) {
    // Morning star: down, small-body, up closing above midpoint of first.
    if (!isBull(p2) && body(p) / range(p) < 0.4 && isBull(c) && c.close > (p2.open + p2.close) / 2) {
      return { pattern: "Morning Star", bias: 1, strength: 0.85, reason: "3-candle bullish reversal (morning star)." };
    }
    if (isBull(p2) && body(p) / range(p) < 0.4 && !isBull(c) && c.close < (p2.open + p2.close) / 2) {
      return { pattern: "Evening Star", bias: -1, strength: 0.85, reason: "3-candle bearish reversal (evening star)." };
    }
  }

  // --- Engulfing (strong) ---
  if (!isBull(p) && isBull(c) && c.close >= p.open && c.open <= p.close && body(c) > body(p)) {
    return { pattern: "Bullish Engulfing", bias: 1, strength: 0.8, reason: "Current green candle engulfs prior red - bullish." };
  }
  if (isBull(p) && !isBull(c) && c.open >= p.close && c.close <= p.open && body(c) > body(p)) {
    return { pattern: "Bearish Engulfing", bias: -1, strength: 0.8, reason: "Current red candle engulfs prior green - bearish." };
  }

  // --- Marubozu (strong momentum) ---
  if (bodyPct >= 0.85) {
    return isBull(c)
      ? { pattern: "Bullish Marubozu", bias: 1, strength: 0.75, reason: "Full-body green candle - strong buying." }
      : { pattern: "Bearish Marubozu", bias: -1, strength: 0.75, reason: "Full-body red candle - strong selling." };
  }

  // --- Hammer / Shooting star (single-candle reversal) ---
  if (lowerWick(c) >= 2 * body(c) && upperWick(c) <= body(c) && bodyPct < 0.4) {
    return { pattern: "Hammer", bias: 1, strength: 0.6, reason: "Long lower wick - buyers rejected lows." };
  }
  if (upperWick(c) >= 2 * body(c) && lowerWick(c) <= body(c) && bodyPct < 0.4) {
    return { pattern: "Shooting Star", bias: -1, strength: 0.6, reason: "Long upper wick - sellers rejected highs." };
  }

  // --- Doji (indecision) ---
  if (bodyPct <= 0.1) {
    return { pattern: "Doji", bias: 0, strength: 0.3, reason: "Tiny body - indecision." };
  }

  // --- Plain directional candle (weak) ---
  return isBull(c)
    ? { pattern: "Bullish candle", bias: 1, strength: 0.35, reason: "Green candle - mild bullish." }
    : { pattern: "Bearish candle", bias: -1, strength: 0.35, reason: "Red candle - mild bearish." };
}
