import { Candle, FrequentMover } from "../types";
import { atr, last } from "../indicators";

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// Thresholds (absolute daily % move) we bucket each stock against, so the UI can
// switch "big move = 2% / 3% / 5%" instantly without re-scanning.
const THRESHOLDS = [2, 3, 5];

/**
 * "Frequent mover" profile from DAILY history.
 *
 * Measures how OFTEN a stock makes a big move (share of days above each %
 * threshold) plus how much it typically ranges. High frequency + wide range =
 * a stock that repeatedly offers tradeable swings (good for options/intraday).
 */
export function computeFrequentMover(symbol: string, name: string, daily: Candle[]): FrequentMover | null {
  const n = daily.length;
  if (n < 40) return null; // need a meaningful sample
  const closes = daily.map((c) => c.close);
  const price = closes[n - 1];

  const changes: number[] = []; // |close-to-close| %
  const ranges: number[] = []; // intraday (high-low) as % of prior close
  for (let i = 1; i < n; i++) {
    const prev = closes[i - 1];
    if (!prev) continue;
    changes.push(Math.abs((closes[i] - prev) / prev) * 100);
    ranges.push(((daily[i].high - daily[i].low) / prev) * 100);
  }
  const totalDays = changes.length;
  if (totalDays < 30) return null;

  const freqPct: Record<string, number> = {};
  const bigMoveDays: Record<string, number> = {};
  for (const t of THRESHOLDS) {
    const cnt = changes.filter((c) => c >= t).length;
    bigMoveDays[String(t)] = cnt;
    freqPct[String(t)] = round1((cnt / totalDays) * 100);
  }

  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const avgDailyRangePct = round2(mean(ranges));
  const avgAbsChangePct = round2(mean(changes));
  const maxDayMovePct = round2(Math.max(...changes));
  const atrVal = last(atr(daily, 14));
  const atrPct = atrVal != null && price ? round2((atrVal / price) * 100) : null;

  return {
    symbol,
    name,
    price: round2(price),
    totalDays,
    freqPct,
    bigMoveDays,
    avgDailyRangePct,
    avgAbsChangePct,
    maxDayMovePct,
    atrPct,
    hasOptions: null, // filled by the endpoint when Groww is connected
  };
}
