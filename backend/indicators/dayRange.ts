import { Candle } from "../types";
import { istDateOfSec } from "../util/istTime";

/**
 * Candles that fall on the same IST calendar day as the most recent bar (or
 * `asOfEpochSec` if given). Previously re-filtered independently in several
 * places (signals/engine.ts, routes/api.ts) with slightly different code for
 * the same "today's bars" concept.
 */
export function todaysCandles(candles: Candle[], asOfEpochSec?: number): Candle[] {
  if (!candles.length) return [];
  const asOf = asOfEpochSec ?? candles[candles.length - 1].time;
  const day = istDateOfSec(asOf);
  return candles.filter((c) => istDateOfSec(c.time) === day);
}

/** High/low across today's candles only (null if there's no data for today). */
export function dayHighLow(candles: Candle[]): { high: number | null; low: number | null } {
  const todays = todaysCandles(candles);
  if (!todays.length) return { high: null, low: null };
  let high = -Infinity;
  let low = Infinity;
  for (const c of todays) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { high, low };
}
