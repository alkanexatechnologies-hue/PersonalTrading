import { Candle, LongTermPick } from "../types";
import { ema, rsi, last } from "../indicators";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Long-term (positional/investing) scan on DAILY candles.
 *
 * Surfaces stocks in durable multi-month up-trends - above the 200-DMA, with a
 * 50/200 "golden" alignment, strong 6-12 month relative strength, and trading
 * near their 52-week high. Gives a positional plan: buy-on-dip near the 50-DMA,
 * a major-trend-break stop under the 200-DMA, and a measured-move target.
 *
 * Needs roughly a year+ of daily history (200-DMA + 12-month return).
 */
export function computeLongTerm(symbol: string, name: string, daily: Candle[]): LongTermPick | null {
  const n = daily.length;
  if (n < 210) return null; // need ~200-DMA plus a buffer for the 12-month return
  const closes = daily.map((c) => c.close);
  const price = closes[n - 1];

  const back = (k: number) => (n - 1 - k >= 0 ? closes[n - 1 - k] : closes[0]);
  const pct = (from: number) => (from ? round2(((price - from) / from) * 100) : 0);
  const ret1mPct = pct(back(21));
  const ret3mPct = pct(back(63));
  const ret6mPct = pct(back(126));
  const ret12mPct = pct(back(252));

  const ema50 = last(ema(closes, 50)) ?? price;
  const ema200 = last(ema(closes, 200)) ?? price;
  const aboveEma200Pct = ema200 ? round2(((price - ema200) / ema200) * 100) : 0;
  const goldenCross = ema50 > ema200;

  const highs = daily.map((c) => c.high);
  const high52 = Math.max(...highs.slice(Math.max(0, n - 252)));
  const distFrom52wHighPct = high52 ? round2(((price - high52) / high52) * 100) : 0;

  const rsiVal = last(rsi(closes, 14));

  // Trend stage.
  let stage: LongTermPick["stage"];
  if (price > ema50 && goldenCross && ret6mPct > 0) stage = "Strong uptrend";
  else if (price > ema200 && goldenCross) stage = "Uptrend";
  else if (price < ema200 && ema50 < ema200) stage = "Downtrend";
  else if (Math.abs(aboveEma200Pct) <= 6) stage = "Base";
  else stage = price > ema200 ? "Uptrend" : "Downtrend";

  // Long-term technical score (higher = stronger, healthier trend).
  let s = 0;
  if (price > ema200) s += 25; // above the long-term trend line
  if (goldenCross) s += 15; // 50-DMA over 200-DMA
  s += Math.min(20, Math.max(0, ret12mPct / 3)); // 12-month relative strength (60% -> full 20)
  s += Math.min(15, Math.max(0, ret6mPct / 2)); // 6-month momentum
  if (distFrom52wHighPct >= -15) s += 15; // near 52-week highs (leadership)
  else if (distFrom52wHighPct >= -30) s += 7;
  if (rsiVal != null && rsiVal >= 50 && rsiVal <= 72) s += 10; // healthy, not exhausted
  if (stage === "Downtrend") s -= 25; // don't bottom-fish a downtrend
  const trendScore = Math.max(0, Math.min(100, Math.round(s)));

  // Positional trade plan.
  // Entry = buy-on-dip near the 50-DMA (or current price if it's already there).
  const entry = round2(Math.min(price, ema50 * 1.02));
  // Stop = ~6% below the 200-DMA (a decisive long-term-trend break).
  const stop = round2(ema200 * 0.94);
  // Target = measured move: reclaim/extend ~5% past the 52-week high, min +15%.
  const target = round2(Math.max(high52 * 1.05, price * 1.15));
  const upsidePct = round2(((target - price) / price) * 100);

  const note =
    stage === "Strong uptrend"
      ? `Strong long-term uptrend: +${ret12mPct}%/yr, above 50 & 200-DMA, ${distFrom52wHighPct >= -3 ? "at new highs" : `${Math.abs(distFrom52wHighPct)}% off the 52w high`}. Accumulate on dips to ~${entry}.`
      : stage === "Uptrend"
      ? `Uptrend above the 200-DMA (golden cross). 12m ${ret12mPct >= 0 ? "+" : ""}${ret12mPct}%. Buy dips near ${entry}; trend-stop ${stop}.`
      : stage === "Base"
      ? `Basing around the 200-DMA - watch for a reclaim + golden cross before committing. 12m ${ret12mPct >= 0 ? "+" : ""}${ret12mPct}%.`
      : `Long-term downtrend (below 200-DMA). Avoid for positional longs until it bases and reclaims the 200-DMA.`;

  return {
    symbol,
    name,
    price: round2(price),
    ret1mPct,
    ret3mPct,
    ret6mPct,
    ret12mPct,
    ema50: round2(ema50),
    ema200: round2(ema200),
    aboveEma200Pct,
    goldenCross,
    distFrom52wHighPct,
    rsi: rsiVal != null ? round2(rsiVal) : null,
    stage,
    trendScore,
    entry,
    stop,
    target,
    upsidePct,
    hasOptions: null, // filled by the endpoint when Groww is connected
    opportunityScore: trendScore, // blended with fundamentals in the endpoint
    note,
  };
}
