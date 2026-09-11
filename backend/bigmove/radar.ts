import { Candle, BigMovePick } from "../types";
import { ema, rsi, atr, last } from "../indicators";

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function median(a: number[]): number {
  if (!a.length) return 0;
  const b = a.slice().sort((x, y) => x - y);
  const m = Math.floor(b.length / 2);
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

const FWD = 126; // ~6-month forward horizon for "from today onwards"

/**
 * Big-move radar - catch the setup that PRECEDES a 20-100% run.
 *
 * Combines the classic "coiled spring" traits (volatility contraction / tight
 * base, volume dry-up = quiet accumulation, near a breakout, strong long-term
 * trend, not already extended) with the stock's OWN history of making 20/50/100%
 * moves in a 6-month window. The base rate keeps the odds honest - a sleepy
 * large-cap won't suddenly double, a proven high-beta name might.
 */
export function computeBigMove(symbol: string, name: string, daily: Candle[]): BigMovePick | null {
  const n = daily.length;
  if (n < 220) return null;
  const closes = daily.map((c) => c.close);
  const highs = daily.map((c) => c.high);
  const lows = daily.map((c) => c.low);
  const vols = daily.map((c) => c.volume);
  const price = closes[n - 1];

  const ema50v = last(ema(closes, 50)) ?? price;
  const ema200v = last(ema(closes, 200)) ?? price;
  const rsiv = last(rsi(closes, 14));
  const atrv = last(atr(daily, 14));
  const atrPct = atrv != null && price ? round2((atrv / price) * 100) : null;

  const hi52 = Math.max(...highs.slice(Math.max(0, n - 252)));
  const distFrom52wHighPct = round1(((price - hi52) / hi52) * 100);
  const aboveEma200 = price > ema200v;
  const hi60 = Math.max(...highs.slice(Math.max(0, n - 60), n - 1)); // resistance to clear
  const breakoutLevel = round2(Math.max(hi60, price));

  // Volatility contraction: recent 20-day range vs the typical 20-day range.
  const rangePct = (arr: number[], loArr: number[]) => (Math.max(...arr) - Math.min(...loArr)) / price * 100;
  const recentRange = rangePct(highs.slice(n - 20), lows.slice(n - 20));
  const rolls: number[] = [];
  for (let i = Math.max(20, n - 180); i < n; i += 5) {
    rolls.push((Math.max(...highs.slice(i - 20, i)) - Math.min(...lows.slice(i - 20, i))) / closes[i - 1] * 100);
  }
  const typicalRange = median(rolls) || recentRange || 1;
  const contractionRatio = round2(recentRange / typicalRange); // < 1 = tighter than usual (coiled)

  // Volume dry-up: recent 10-day avg vs 50-day avg (< 1 = quiet accumulation).
  const volDryup = round2((mean(vols.slice(n - 10)) || 0) / (mean(vols.slice(n - 50)) || 1));

  const monthChangePct = round1((closes[n - 1] / closes[Math.max(0, n - 22)] - 1) * 100);
  const q3ChangePct = round1((closes[n - 1] / closes[Math.max(0, n - 63)] - 1) * 100);

  // Historical base rate: full 6-month forward windows reaching +20/50/100%.
  let w = 0, b20 = 0, b50 = 0, b100 = 0;
  for (let i = 0; i + FWD < n; i++) {
    w++;
    let mx = 0;
    for (let j = i + 1; j <= i + FWD; j++) {
      const g = highs[j] / closes[i] - 1;
      if (g > mx) mx = g;
      if (mx >= 1.0) break;
    }
    if (mx >= 0.2) b20++;
    if (mx >= 0.5) b50++;
    if (mx >= 1.0) b100++;
  }
  if (w < 60) return null;
  const baseRate20 = round1((b20 / w) * 100);
  const baseRate50 = round1((b50 / w) * 100);
  const baseRate100 = round1((b100 / w) * 100);

  // Stage.
  const extended = q3ChangePct > 60 || (rsiv != null && rsiv > 78);
  const weak = price < ema200v && price < ema50v;
  const breakingOut = price >= hi60 * 0.99 && monthChangePct > 0;
  let stage: BigMovePick["stage"];
  if (weak) stage = "Weak";
  else if (extended) stage = "Extended";
  else if (breakingOut) stage = "Breaking out";
  else if (contractionRatio < 0.7 && aboveEma200) stage = "Coiled base";
  else stage = "Neutral";

  // Readiness score.
  let s = 0;
  if (aboveEma200) s += 20;
  s += clamp((1 - contractionRatio) * 40, 0, 22); // tighter base = more coiled
  if (volDryup < 0.9) s += 10; // quiet accumulation
  if (distFrom52wHighPct >= -12) s += 15; // leadership near highs
  if (breakingOut) s += 15;
  s += Math.min(18, baseRate50 * 0.4); // historical propensity
  if (extended) s -= 25;
  if (weak) s -= 25;
  const readinessScore = clamp(Math.round(s), 0, 100);

  const prob20 = clamp(Math.round(baseRate20 * 0.5 + readinessScore * 0.5), 0, 92);
  const prob50 = clamp(Math.round(baseRate50 * 0.55 + readinessScore * 0.45), 0, 85);
  const prob100 = clamp(Math.round(baseRate100 * 0.6 + readinessScore * 0.4), 0, 70);

  // Plan.
  const entry = round2(price);
  const swingLow = Math.min(...lows.slice(Math.max(0, n - 20)));
  const atrFloor = atrv != null ? price - 2 * atrv : swingLow;
  const stop = round2(Math.max(swingLow, atrFloor, price * 0.85)); // structure, fenced to ~-15%
  const stopPct = round1(((price - stop) / price) * 100);
  const target20 = round2(price * 1.2);
  const target50 = round2(price * 1.5);
  const target100 = round2(price * 2);

  // ---- SHORT-HORIZON potential: 1 week (5d) / 15 days (11d) / 30 days (22d) ----
  // Historical hit-rate of +20/50/100% WITHIN each window + a volatility-scaled
  // expected favourable move for the window (so the list shows realistic "kitna
  // move kar sakta hai" numbers for short horizons, not just the 6-month odds).
  const rets: number[] = [];
  for (let i = Math.max(1, n - 120); i < n; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const rMean = mean(rets);
  const dstd = Math.sqrt(Math.max(0, mean(rets.map((r) => r * r)) - rMean * rMean)) || (atrPct ? atrPct / 100 : 0.02);
  const horizonDefs: { key: "1w" | "15d" | "30d"; days: number }[] = [
    { key: "1w", days: 5 }, { key: "15d", days: 11 }, { key: "30d", days: 22 },
  ];
  const horizons = horizonDefs.map(({ key, days }) => {
    let ww = 0, h20 = 0, h50 = 0, h100 = 0;
    for (let i = 0; i + days < n; i++) {
      ww++;
      let mx = 0;
      for (let j = i + 1; j <= i + days; j++) { const g = highs[j] / closes[i] - 1; if (g > mx) mx = g; if (mx >= 1.0) break; }
      if (mx >= 0.2) h20++;
      if (mx >= 0.5) h50++;
      if (mx >= 1.0) h100++;
    }
    const potentialPct = round1(dstd * Math.sqrt(days) * 1.65 * 100); // ~1-sided 1.65σ move
    return {
      key, days, potentialPct,
      hit20: ww ? round1((h20 / ww) * 100) : 0,
      hit50: ww ? round1((h50 / ww) * 100) : 0,
      hit100: ww ? round1((h100 / ww) * 100) : 0,
    };
  });

  // ---- BREAKOUT proximity: breaking its last (60-day) high or near it ----
  const lastHigh = round2(hi60);
  const breakoutDistPct = round1(((hi60 - price) / price) * 100); // <=0 = already above the 60-day high
  let breakoutStatus: BigMovePick["breakoutStatus"];
  if (breakoutDistPct <= 0) breakoutStatus = "Broke out";
  else if (breakoutDistPct <= 2) breakoutStatus = "Near breakout";
  else if (breakoutDistPct <= 6 && aboveEma200) breakoutStatus = "Building";
  else breakoutStatus = "Away";

  // ---- ORDERING score: breakout proximity + short-term potential + readiness ----
  const breakoutScore = breakoutDistPct <= 0 ? 100 : clamp(100 - breakoutDistPct * 9, 0, 100);
  const h30 = horizons[2];
  const shortPot = clamp(h30.potentialPct * 1.2, 0, 100);
  const shortHist = clamp(h30.hit20, 0, 100);
  const moveRank = Math.round(readinessScore * 0.34 + breakoutScore * 0.30 + shortPot * 0.20 + shortHist * 0.16);

  const note =
    `${stage}. ${breakoutStatus === "Broke out" ? "Broke its 60-day high" : breakoutStatus === "Near breakout" ? `${breakoutDistPct}% below breakout ${lastHigh}` : `${breakoutDistPct}% from breakout ${lastHigh}`}. ` +
    `Short-term potential ~${horizons[0].potentialPct}%/1w, ${horizons[1].potentialPct}%/15d, ${horizons[2].potentialPct}%/30d. ` +
    `Historically made +20% in 6m ${baseRate20}% of the time (+50%: ${baseRate50}%, +100%: ${baseRate100}%). ` +
    `Base ${contractionRatio < 0.7 ? "TIGHT (coiled)" : "normal"} (${contractionRatio}x), volume ${volDryup < 0.9 ? "drying up (accumulation)" : "normal"} (${volDryup}x), ` +
    `${distFrom52wHighPct >= -3 ? "at new highs" : `${Math.abs(distFrom52wHighPct)}% off 52w high`}. ` +
    `Trigger a break above ${breakoutLevel}; stop ${stop} (-${stopPct}%). HIGH RISK - big targets, big downside.`;

  return {
    symbol,
    name,
    price: round2(price),
    stage,
    readinessScore,
    prob20,
    prob50,
    prob100,
    baseRate20,
    baseRate50,
    baseRate100,
    entry,
    breakoutLevel,
    stop,
    stopPct,
    target20,
    target50,
    target100,
    contractionRatio,
    volDryup,
    distFrom52wHighPct,
    aboveEma200,
    rsi: rsiv != null ? round2(rsiv) : null,
    atrPct,
    hasOptions: null,
    note,
    horizons,
    lastHigh,
    breakoutDistPct,
    breakoutStatus,
    moveRank,
  };
}
