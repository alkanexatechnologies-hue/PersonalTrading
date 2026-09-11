import { Candle } from "../types";
import { adx as adxIndicator, ema } from "../indicators";
import { istMinuteOfDay } from "../util/istTime";

export interface FilterOptions {
  useTrendFilter: boolean;
  trendEmaPeriod: number; // regime/higher-timeframe trend proxy
  trendSlopeLookback: number; // bars used to measure EMA slope
  useAdxFilter: boolean;
  adxMin: number; // min ADX to consider the market "trending"
  adxPeriod: number;
  useTimeFilter: boolean;
  entryStartMinIST: number; // no new entries before this IST minute-of-day
  entryCutoffMinIST: number; // no new entries after this IST minute-of-day
}

export const DEFAULT_FILTERS: FilterOptions = {
  useTrendFilter: false,
  trendEmaPeriod: 50,
  trendSlopeLookback: 3,
  useAdxFilter: false,
  adxMin: 20,
  adxPeriod: 14,
  useTimeFilter: false,
  entryStartMinIST: 570, // 09:30
  entryCutoffMinIST: 885, // 14:45
};

export interface FilterMasks {
  longOk: boolean[];
  shortOk: boolean[];
}

/**
 * Per-bar eligibility masks for taking long / short entries, based on:
 *  1. Trend regime  - EMA position + slope (higher-timeframe trend proxy)
 *  2. ADX gate      - only trade when the market is actually trending
 *  3. Time-of-day   - skip the noisy open and late-session entries (IST)
 * All filters default OFF so the baseline strategy is unchanged.
 */
export function computeFilters(candles: Candle[], optsIn?: Partial<FilterOptions>): FilterMasks {
  const opts = { ...DEFAULT_FILTERS, ...optsIn };
  const n = candles.length;
  const closes = candles.map((c) => c.close);

  const trendEma = opts.useTrendFilter ? ema(closes, opts.trendEmaPeriod) : null;
  const adxRes = opts.useAdxFilter ? adxIndicator(candles, opts.adxPeriod) : null;

  const longOk: boolean[] = new Array(n).fill(true);
  const shortOk: boolean[] = new Array(n).fill(true);

  for (let i = 0; i < n; i++) {
    let lOk = true;
    let sOk = true;

    if (opts.useTrendFilter && trendEma) {
      const e = trendEma[i];
      const ePrev = trendEma[i - opts.trendSlopeLookback];
      if (e == null || ePrev == null) {
        lOk = false;
        sOk = false;
      } else {
        const rising = e > ePrev;
        const price = closes[i];
        lOk = lOk && price > e && rising;
        sOk = sOk && price < e && !rising;
      }
    }

    if (opts.useAdxFilter && adxRes) {
      const a = adxRes.adx[i];
      const trending = a != null && a >= opts.adxMin;
      lOk = lOk && trending;
      sOk = sOk && trending;
    }

    if (opts.useTimeFilter) {
      const m = istMinuteOfDay(candles[i].time);
      const inWindow = m >= opts.entryStartMinIST && m <= opts.entryCutoffMinIST;
      lOk = lOk && inWindow;
      sOk = sOk && inWindow;
    }

    longOk[i] = lOk;
    shortOk[i] = sOk;
  }

  return { longOk, shortOk };
}
