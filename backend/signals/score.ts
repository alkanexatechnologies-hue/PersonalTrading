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

    // Supertrend
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

    // MACD
    if (m.histogram[i] != null && m.macd[i] != null) {
      const hist = m.histogram[i] as number;
      const macdLine = m.macd[i] as number;
      const strength = Math.min(1, Math.abs(hist) / (Math.abs(macdLine) + 1e-9));
      raw += (hist > 0 ? 1 : -1) * WEIGHTS.macd * Math.max(0.4, strength);
    }

    // RSI
    if (rsiS[i] != null) {
      const r = rsiS[i] as number;
      if (r < 30) raw += WEIGHTS.rsi;
      else if (r > 70) raw -= WEIGHTS.rsi;
      else if (r >= 55) raw += WEIGHTS.rsi * 0.4;
      else if (r <= 45) raw -= WEIGHTS.rsi * 0.4;
    }

    // Bollinger
    if (bb.upper[i] != null && bb.lower[i] != null) {
      if (price >= (bb.upper[i] as number)) raw -= WEIGHTS.bollinger;
      else if (price <= (bb.lower[i] as number)) raw += WEIGHTS.bollinger;
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
