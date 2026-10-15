// ============================ Candle reading (closed candles only; pure, no I/O) ============================
// Plain-language read of the last closed candle(s) the way a chart reader describes them: the candle's shape (who won the
// candle), the two-candle pattern, and WHERE it formed (at which level). Descriptive context — not a prediction.

export interface C { time: number; open: number; high: number; low: number; close: number }
export interface Lvl { price: number; label: string }
export interface CandleRead { tf: string; time: number; shape: string; pattern: string | null; tone: "bull" | "bear" | "neutral"; at: string | null; closeLoc: number; bodyPct: number; big: string | null; text: string }

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const hm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);

export function readCandle(bars: C[], tf: string, levels: Lvl[] = [], atr: number | null = null): CandleRead | null {
  const n = bars.length; if (!n) return null;
  const c = bars[n - 1], p = n > 1 ? bars[n - 2] : null;
  const range = c.high - c.low, body = Math.abs(c.close - c.open), up = c.high - Math.max(c.open, c.close), lo = Math.min(c.open, c.close) - c.low;
  const bull = c.close > c.open, closeLoc = range > 0 ? pct(c.close - c.low, range) : 50, bodyPct = pct(body, range);
  let shape = "normal candle", tone: CandleRead["tone"] = bull ? "bull" : c.close < c.open ? "bear" : "neutral";
  // pin bars first: a long wick with a small body says more than "doji"
  if (range > 0 && lo >= 2 * body && lo >= 0.6 * range && up <= 0.2 * range) { shape = "hammer / long lower wick — buyers rejected the lows"; tone = "bull"; }
  else if (range > 0 && up >= 2 * body && up >= 0.6 * range && lo <= 0.2 * range) { shape = "shooting star / long upper wick — sellers rejected the highs"; tone = "bear"; }
  else if (range === 0 || bodyPct <= 10) { shape = "doji — indecision"; tone = "neutral"; }
  else if (bodyPct >= 80) { shape = `${bull ? "bullish" : "bearish"} momentum candle (body ${bodyPct}%)`; }
  else if (bodyPct >= 55) { shape = `${bull ? "bullish" : "bearish"} candle, closed near the ${bull ? "high" : "low"}`; }
  else if (up > lo * 1.5 && up > body) { shape = "upper wick dominant — selling pressure above"; tone = bull ? "neutral" : "bear"; }
  else if (lo > up * 1.5 && lo > body) { shape = "lower wick dominant — buying support below"; tone = bull ? "bull" : "neutral"; }
  let pattern: string | null = null;
  if (p) {
    const pBull = p.close > p.open, pBodyHi = Math.max(p.open, p.close), pBodyLo = Math.min(p.open, p.close);
    if (bull && !pBull && c.close >= pBodyHi && c.open <= pBodyLo && body > Math.abs(p.close - p.open)) { pattern = "BULLISH ENGULFING"; tone = "bull"; }
    else if (!bull && pBull && c.close <= pBodyLo && c.open >= pBodyHi && body > Math.abs(p.close - p.open)) { pattern = "BEARISH ENGULFING"; tone = "bear"; }
    else if (c.high < p.high && c.low > p.low) pattern = "INSIDE BAR — compression, a break of its range comes next";
    else if (c.high > p.high && c.low < p.low) pattern = "OUTSIDE BAR — range expansion";
  }
  const big = atr && range >= 1.5 * atr ? `big range (${(range / atr).toFixed(1)}× ATR)` : null;
  // where: the nearest level the candle traded through or touched
  const tol = (atr ?? range) * 0.25;
  const hit = levels.filter((l) => l.price >= c.low - tol && l.price <= c.high + tol).sort((a, b) => Math.abs(a.price - c.close) - Math.abs(b.price - c.close))[0];
  const at = hit ? `${hit.label} ${Math.round(hit.price).toLocaleString("en-IN")}` : null;
  let where = "";
  if (hit) {
    // a candle that crossed the level open→close is a break; only otherwise is a wick through it a rejection/defence
    if (c.close > hit.price && c.open < hit.price) where = ` — closed ABOVE ${at} (break)`;
    else if (c.close < hit.price && c.open > hit.price) where = ` — closed BELOW ${at} (break)`;
    else if (c.high >= hit.price && c.close < hit.price) where = ` — poked above ${at} and closed back below (rejection)`;
    else if (c.low <= hit.price && c.close > hit.price) where = ` — dipped below ${at} and closed back above (defended)`;
    else where = ` — at ${at}`;
  }
  const text = `${tf} ${hm(c.time)}: ${pattern ? pattern + ", " : ""}${shape}${big ? `, ${big}` : ""}, close at ${closeLoc}% of its range${where}.`;
  return { tf, time: c.time, shape, pattern, tone, at, closeLoc, bodyPct, big, text };
}
