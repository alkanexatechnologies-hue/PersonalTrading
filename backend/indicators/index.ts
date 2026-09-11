import { Candle } from "../types";

export type Series = (number | null)[];

/** Simple Moving Average. */
export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential Moving Average (seeded with the first SMA). */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFrom(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdSeries {
  macd: Series;
  signal: Series;
  histogram: Series;
}

/** MACD (default 12/26/9). */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine: Series = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? (emaFast[i] as number) - (emaSlow[i] as number) : null
  );
  // Signal line is an EMA of the (defined portion of the) MACD line.
  const defined: number[] = [];
  const idx: number[] = [];
  macdLine.forEach((v, i) => {
    if (v != null) {
      defined.push(v);
      idx.push(i);
    }
  });
  const sigDefined = ema(defined, signalPeriod);
  const signal: Series = new Array(values.length).fill(null);
  idx.forEach((origIdx, j) => {
    signal[origIdx] = sigDefined[j];
  });
  const histogram: Series = values.map((_, i) =>
    macdLine[i] != null && signal[i] != null ? (macdLine[i] as number) - (signal[i] as number) : null
  );
  return { macd: macdLine, signal, histogram };
}

/** Session-aware VWAP: resets at each new trading day. */
export function vwap(candles: Candle[]): Series {
  const out: Series = new Array(candles.length).fill(null);
  let cumPV = 0;
  let cumVol = 0;
  let currentDay = "";
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = new Date(c.time * 1000).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      cumPV = 0;
      cumVol = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumVol += c.volume;
    out[i] = cumVol > 0 ? cumPV / cumVol : c.close;
  }
  return out;
}

export interface BollingerSeries {
  middle: Series;
  upper: Series;
  lower: Series;
}

/** Bollinger Bands (default 20, 2 std dev). */
export function bollinger(values: number[], period = 20, mult = 2): BollingerSeries {
  const middle = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const mean = middle[i] as number;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { middle, upper, lower };
}

/** Average True Range (Wilder). */
export function atr(candles: Candle[], period = 14): Series {
  const out: Series = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr: number[] = new Array(candles.length).fill(0);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export interface SupertrendPoint {
  value: number | null;
  direction: 1 | -1 | 0; // 1 = uptrend, -1 = downtrend
}

/** Supertrend (default 10, 3). */
export function supertrend(candles: Candle[], period = 10, mult = 3): SupertrendPoint[] {
  const out: SupertrendPoint[] = candles.map(() => ({ value: null, direction: 0 }));
  const atrSeries = atr(candles, period);
  let prevUpper = 0;
  let prevLower = 0;
  let prevSt = 0;
  let prevDir: 1 | -1 = 1;
  for (let i = 0; i < candles.length; i++) {
    const a = atrSeries[i];
    if (a == null) continue;
    const c = candles[i];
    const mid = (c.high + c.low) / 2;
    let upper = mid + mult * a;
    let lower = mid - mult * a;

    if (i > 0 && atrSeries[i - 1] != null) {
      upper = upper < prevUpper || candles[i - 1].close > prevUpper ? upper : prevUpper;
      lower = lower > prevLower || candles[i - 1].close < prevLower ? lower : prevLower;
    }

    let dir: 1 | -1;
    if (prevSt === 0) {
      dir = c.close >= mid ? 1 : -1;
    } else if (prevDir === 1) {
      dir = c.close < prevLower ? -1 : 1;
    } else {
      dir = c.close > prevUpper ? 1 : -1;
    }

    const stValue = dir === 1 ? lower : upper;
    out[i] = { value: stValue, direction: dir };

    prevUpper = upper;
    prevLower = lower;
    prevSt = stValue;
    prevDir = dir;
  }
  return out;
}

export interface AdxSeries {
  adx: Series;
  plusDI: Series;
  minusDI: Series;
}

/**
 * Average Directional Index (Wilder, default 14).
 * ADX measures trend STRENGTH (not direction). >20-25 => trending;
 * +DI/-DI give direction. Used as a regime gate to avoid choppy markets.
 */
export function adx(candles: Candle[], period = 14): AdxSeries {
  const n = candles.length;
  const plusDI: Series = new Array(n).fill(null);
  const minusDI: Series = new Array(n).fill(null);
  const adxOut: Series = new Array(n).fill(null);
  if (n <= period * 2) return { adx: adxOut, plusDI, minusDI };

  const tr: number[] = new Array(n).fill(0);
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  }

  // Wilder smoothing seeds (sum over first `period` starting at index 1).
  let trS = 0;
  let plusS = 0;
  let minusS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    plusS += plusDM[i];
    minusS += minusDM[i];
  }

  const dx: number[] = new Array(n).fill(0);
  const firstDIidx = period;
  for (let i = period; i < n; i++) {
    if (i > period) {
      trS = trS - trS / period + tr[i];
      plusS = plusS - plusS / period + plusDM[i];
      minusS = minusS - minusS / period + minusDM[i];
    }
    const pDI = trS === 0 ? 0 : (100 * plusS) / trS;
    const mDI = trS === 0 ? 0 : (100 * minusS) / trS;
    plusDI[i] = pDI;
    minusDI[i] = mDI;
    const diSum = pDI + mDI;
    dx[i] = diSum === 0 ? 0 : (100 * Math.abs(pDI - mDI)) / diSum;
  }

  // ADX = Wilder-smoothed DX, first value = average of first `period` DX values.
  const adxStart = firstDIidx + period;
  if (adxStart < n) {
    let dxSum = 0;
    for (let i = firstDIidx; i < firstDIidx + period; i++) dxSum += dx[i];
    let prevAdx = dxSum / period;
    adxOut[adxStart - 1] = prevAdx;
    for (let i = adxStart; i < n; i++) {
      prevAdx = (prevAdx * (period - 1) + dx[i]) / period;
      adxOut[i] = prevAdx;
    }
  }

  return { adx: adxOut, plusDI, minusDI };
}

/** On-Balance Volume: cumulative volume flow (rising = net buying). */
export function obv(candles: Candle[]): Series {
  const out: Series = new Array(candles.length).fill(null);
  if (!candles.length) return out;
  let cum = 0;
  out[0] = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) cum += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) cum -= candles[i].volume;
    out[i] = cum;
  }
  return out;
}

/** Money Flow Index (volume-weighted RSI), default 14. 0-100. */
export function mfi(candles: Candle[], period = 14): Series {
  const n = candles.length;
  const out: Series = new Array(n).fill(null);
  if (n <= period) return out;
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const rawFlow = candles.map((c, i) => tp[i] * c.volume);
  for (let i = period; i < n; i++) {
    let posFlow = 0;
    let negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) posFlow += rawFlow[j];
      else if (tp[j] < tp[j - 1]) negFlow += rawFlow[j];
    }
    if (negFlow === 0) out[i] = 100;
    else {
      const ratio = posFlow / negFlow;
      out[i] = 100 - 100 / (1 + ratio);
    }
  }
  return out;
}

/** Chaikin Money Flow, default 20. -1..+1 (positive = buying pressure). */
export function cmf(candles: Candle[], period = 20): Series {
  const n = candles.length;
  const out: Series = new Array(n).fill(null);
  if (n < period) return out;
  const mfv = candles.map((c) => {
    const range = c.high - c.low;
    if (range === 0) return 0;
    const mult = ((c.close - c.low) - (c.high - c.close)) / range; // close location value
    return mult * c.volume;
  });
  for (let i = period - 1; i < n; i++) {
    let sumMfv = 0;
    let sumVol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumMfv += mfv[j];
      sumVol += candles[j].volume;
    }
    out[i] = sumVol === 0 ? 0 : sumMfv / sumVol;
  }
  return out;
}

/** Convenience: last non-null value of a series. */
export function last(series: Series): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) return series[i];
  }
  return null;
}
