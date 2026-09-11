import { Candle, MonthlySwingPick } from "../types";
import { ema, rsi, atr, last } from "../indicators";

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

const H = 21; // ~1 trading month

/**
 * "Monthly shot" model - HIGH-RISK swing targeting a 20-50% move in ~1 month.
 *
 * Probability is grounded in the stock's OWN history: over the past ~1-2 years,
 * how often did it actually gain >= 20% within a 21-day window? That base rate is
 * blended with the current setup (trend, momentum, volume, volatility, breakout
 * proximity, not-already-extended) to estimate the odds. Volatile small/mid-caps
 * score here; sleepy large-caps don't.
 */
export function computeMonthlyShot(symbol: string, name: string, daily: Candle[]): MonthlySwingPick | null {
  const n = daily.length;
  if (n < 150) return null;
  const closes = daily.map((c) => c.close);
  const highs = daily.map((c) => c.high);
  const vols = daily.map((c) => c.volume);
  const price = closes[n - 1];

  // Historical base rate: share of 1-month windows that gained >= 20/30/50%.
  let w = 0, c20 = 0, c30 = 0, c50 = 0;
  for (let i = 0; i + H < n; i++) {
    w++;
    let mx = 0;
    for (let j = i + 1; j <= i + H; j++) {
      const g = highs[j] / closes[i] - 1;
      if (g > mx) mx = g;
    }
    if (mx >= 0.2) c20++;
    if (mx >= 0.3) c30++;
    if (mx >= 0.5) c50++;
  }
  if (w < 50) return null;
  const baseRate20 = round1((c20 / w) * 100);
  const baseRate30 = round1((c30 / w) * 100);
  const baseRate50 = round1((c50 / w) * 100);

  const ema50v = last(ema(closes, 50)) ?? price;
  const rsiv = last(rsi(closes, 14));
  const atrv = last(atr(daily, 14));
  const atrPct = atrv != null && price ? round2((atrv / price) * 100) : null;
  // Expected 1-month range ~ daily ATR% x sqrt(21) (square-root-of-time).
  const expectedMonthlyMovePct = atrPct != null ? round1(atrPct * Math.sqrt(H)) : null;

  const volSurge = (() => {
    const r = mean(vols.slice(-5));
    const a = mean(vols.slice(-30));
    return a > 0 ? round2(r / a) : 1;
  })();
  const monthChangePct = round1((closes[n - 1] / closes[Math.max(0, n - 1 - H)] - 1) * 100);
  const aboveEma50 = price > ema50v;
  const hi20 = Math.max(...highs.slice(Math.max(0, n - 20)));

  // Current-setup score (0..100).
  let s = 0;
  if (aboveEma50) s += 20; // in an uptrend
  if (rsiv != null && rsiv >= 52 && rsiv <= 68) s += 20; // momentum, not overbought
  else if (rsiv != null && rsiv > 68 && rsiv <= 75) s += 8;
  s += Math.min(20, Math.max(0, (volSurge - 1) * 20)); // volume interest
  if (expectedMonthlyMovePct != null) s += Math.min(20, expectedMonthlyMovePct * 0.5); // volatile enough to move
  if (price >= hi20 * 0.98) s += 20; // near/at a breakout
  if (monthChangePct > 30) s -= 15; // already ran - move may be spent
  const setupScore = clamp(Math.round(s), 0, 100);

  // Probability of hitting the 20% target in a month = base rate + setup.
  const probability = clamp(Math.round(baseRate20 * 0.5 + setupScore * 0.5), 0, 95);

  // Target within the 20-50% band (scaled by expected move), stop = a fraction of it.
  const targetPct = clamp(Math.round(expectedMonthlyMovePct ?? 20), 20, 50);
  const target = round2(price * (1 + targetPct / 100));
  const stopPct = clamp(Math.round((expectedMonthlyMovePct ?? 20) * 0.35), 6, 15);
  const stop = round2(price * (1 - stopPct / 100));
  const riskReward = round1(targetPct / stopPct);

  const note =
    `Historically hit +20% in a month ${baseRate20}% of the time (+30%: ${baseRate30}%, +50%: ${baseRate50}%). ` +
    `Now: ${aboveEma50 ? "above" : "below"} 50-DMA, RSI ${rsiv != null ? Math.round(rsiv) : "?"}, vol ${volSurge}x, ` +
    `~${expectedMonthlyMovePct ?? "?"}% expected monthly range. ` +
    (monthChangePct > 30 ? `Already +${monthChangePct}% this month - chasing risk. ` : "") +
    `Plan: target +${targetPct}% (${target}), stop -${stopPct}% (${stop}). HIGH RISK.`;

  return {
    symbol,
    name,
    price: round2(price),
    targetPct,
    target,
    stopPct,
    stop,
    riskReward,
    expectedMonthlyMovePct,
    probability,
    setupScore,
    baseRate20,
    baseRate30,
    baseRate50,
    monthChangePct,
    volSurge,
    rsi: rsiv != null ? round2(rsiv) : null,
    atrPct,
    aboveEma50,
    hasOptions: null,
    riskLevel: "High",
    note,
  };
}
