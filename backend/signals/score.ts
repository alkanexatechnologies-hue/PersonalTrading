import { Candle } from "../types";
import { atr, bollinger, ema, macd, rsi, supertrend, vwap } from "../indicators";

// Shared weights so the live signal and the backtest score the market identically.
export const WEIGHTS = {
  emaCross: 22,
  supertrend: 22,
  vwap: 18,
  macd: 18,
  rsi: 12,
  bollinger: 8,
};

export const MAX_SCORE = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

// Phase 3.1 audit (consistency decision, documented here as the intentional
// design — not changed): EMA cross / VWAP / RSI / Bollinger / MACD all scale
// their contribution by a "strength" in [0,1] derived from how far the signal
// sits from a neutral reading. Supertrend does NOT — it contributes its full
// weight the instant direction flips. This is kept as-is: Supertrend is a
// binary trend-FLIP indicator (the ATR band the price is on), not a continuous
// oscillator like the others — there is no equivalent "how strong is this flip"
// reading without inventing a new, unvalidated heuristic (e.g. price-distance
// from the ST line conflates trend strength with potential exhaustion, since a
// big move away from a fresh flip can mean either continuation or a top/bottom).
// Scaling it would be new strategy logic, not a bug fix.
//
// MACD's `Math.max(0.4, strength)` floor (below) is also kept as-is: its
// strength is |histogram| / |macdLine|, a RATIO that gets noisy and can read
// near-zero right as the MACD line itself crosses zero — exactly when the
// histogram's SIGN is still a meaningful, real vote. The floor keeps MACD's
// directional voice through that noisy crossover zone instead of letting a
// denominator artifact silence it; it does not mean "any nonzero histogram
// votes at 40%" (a flat/zero histogram contributes nothing either way — the
// floor only raises weak-but-present momentum, never fabricates a direction).

// Directional-bias cutoff on the shared -100..+100 score scale: at/above this is
// Bullish/BUY, at/below its negative is Bearish/SELL, between is Neutral/HOLD.
// Centralized here (was the same unexplained magic 15 repeated independently in
// signals/engine.ts, signals/direction4L.ts, nextday/outlook.ts, paper/entryRules.ts
// and routes/api.ts) so it's documented and tunable in one place.
export const DIRECTION_THRESHOLD = 15;

/**
 * Vectorised score for every bar (-100..+100), computed once over the full
 * series so the backtest runs in O(n). Bars without enough history are null.
 */
export function computeScoreSeries(candles: Candle[]): (number | null)[] {
  const closes = candles.map((c) => c.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const st = supertrend(candles, 10, 3);
  const vw = vwap(candles);
  const m = macd(closes);
  const rsiS = rsi(closes, 14);
  const bb = bollinger(closes, 20, 2);

  const out: (number | null)[] = new Array(candles.length).fill(null);

  for (let i = 0; i < candles.length; i++) {
    const price = closes[i];
    let raw = 0;
    let defined = false;

    // EMA cross
    if (ema9[i] != null && ema21[i] != null) {
      defined = true;
      const a = ema9[i] as number;
      const b = ema21[i] as number;
      const spreadPct = ((a - b) / b) * 100;
      const strength = Math.min(1, Math.abs(spreadPct) / 0.5);
      raw += (a > b ? 1 : -1) * WEIGHTS.emaCross * strength;
    }

    // Supertrend — intentionally binary (full weight, no strength scaling); see
    // the Phase 3.1 note above WEIGHTS.
    if (st[i] && st[i].direction !== 0) {
      raw += st[i].direction * WEIGHTS.supertrend;
    }

    // VWAP
    if (vw[i] != null) {
      const v = vw[i] as number;
      const diffPct = ((price - v) / v) * 100;
      const strength = Math.min(1, Math.abs(diffPct) / 0.4);
      raw += (price > v ? 1 : -1) * WEIGHTS.vwap * strength;
    }

    // MACD — the 0.4 floor is intentional (noisy ratio near a MACD-line zero
    // crossing); see the Phase 3.1 note above WEIGHTS.
    if (m.histogram[i] != null && m.macd[i] != null) {
      const hist = m.histogram[i] as number;
      const macdLine = m.macd[i] as number;
      const strength = Math.min(1, Math.abs(hist) / (Math.abs(macdLine) + 1e-9));
      raw += (hist > 0 ? 1 : -1) * WEIGHTS.macd * Math.max(0.4, strength);
    }

    // RSI — same conditions as signals/direction4L.ts (momentum, not 30/70 reversal).
    if (rsiS[i] != null) {
      const r = rsiS[i] as number;
      if (r >= 55) raw += WEIGHTS.rsi;
      else if (r <= 45) raw -= WEIGHTS.rsi;
    }

    // Bollinger — same conditions as signals/direction4L.ts (price vs middle band).
    if (bb.middle[i] != null) {
      const mid = bb.middle[i] as number;
      if (price > mid) raw += WEIGHTS.bollinger;
      else if (price < mid) raw -= WEIGHTS.bollinger;
    }

    if (defined) {
      out[i] = Math.max(-100, Math.min(100, Math.round((raw / MAX_SCORE) * 100)));
    }
  }

  return out;
}

/** ATR series exposed for the backtest's volatility-aware stops if needed. */
export function atrSeries(candles: Candle[], period = 14) {
  return atr(candles, period);
}
