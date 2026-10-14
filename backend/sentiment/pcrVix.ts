// ============================ PCR and India VIX bands (Market Sentiment, context only) ============================
// PCR = total PUT OI / total CALL OI (whole chain, nearest expiry). Writers sell options, so more put OI = more traders
// selling puts below the market (support) → bullish read; more call OI = resistance above → bearish read. Extremes are
// contrarian: very high PCR = crowded bullish (pullback risk), very low = crowded bearish (short-covering risk).
// These are the conventional Indian-market bands, shown on screen as fixed reference levels — not a trade signal.

export interface Band { min: number; max: number; label: string; tone: "bull" | "bear" | "neutral" | "caution"; meaning: string }

export const PCR_BANDS: Band[] = [
  { min: 0, max: 0.5, label: "BEARISH · OVERSOLD", tone: "caution", meaning: "Heavy call writing; crowd very bearish — short-covering bounce risk" },
  { min: 0.5, max: 0.8, label: "BEARISH", tone: "bear", meaning: "Call writers dominate — resistance overhead" },
  { min: 0.8, max: 0.95, label: "MILDLY BEARISH", tone: "bear", meaning: "Slightly more call OI than put OI" },
  { min: 0.95, max: 1.05, label: "NEUTRAL", tone: "neutral", meaning: "Puts and calls balanced — range likely" },
  { min: 1.05, max: 1.3, label: "MILDLY BULLISH", tone: "bull", meaning: "Put writers slightly ahead — support below" },
  { min: 1.3, max: 1.6, label: "BULLISH", tone: "bull", meaning: "Put writers dominate — strong support below" },
  { min: 1.6, max: Infinity, label: "BULLISH · OVERBOUGHT", tone: "caution", meaning: "Crowd very bullish — pullback risk" },
];

export const VIX_BANDS: Band[] = [
  { min: 0, max: 11, label: "VERY LOW", tone: "caution", meaning: "Complacent market; option premiums cheap; a sudden sharp move is possible" },
  { min: 11, max: 14, label: "LOW", tone: "bull", meaning: "Calm; trends extend more easily; option buyers see slower premium moves" },
  { min: 14, max: 18, label: "NORMAL", tone: "neutral", meaning: "Typical swings; normal stop-loss sizes" },
  { min: 18, max: 22, label: "ELEVATED", tone: "caution", meaning: "Bigger swings; widen stops and cut position size" },
  { min: 22, max: 28, label: "HIGH", tone: "bear", meaning: "Fear in the market; whipsaws common; premiums expensive" },
  { min: 28, max: Infinity, label: "EXTREME", tone: "bear", meaning: "Panic levels; very large moves both ways" },
];

export function bandOf(v: number | null | undefined, bands: Band[]): Band | null {
  if (v == null || !Number.isFinite(v)) return null;
  return bands.find((b) => v >= b.min && v < b.max) || null;
}

/** PCR of the strikes within ±n of ATM (near-money, where the day's trading happens). */
export function nearPcr(strikes: { strike: number; ceOi: number; peOi: number }[], spot: number | null, n = 5): number | null {
  if (!strikes.length || spot == null) return null;
  const ks = strikes.map((s) => s.strike).sort((a, b) => a - b);
  const step = ks.length > 1 ? Math.min(...ks.slice(1).map((k, i) => k - ks[i]).filter((d) => d > 0)) : 50;
  const atm = ks.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), ks[0]);
  const w = strikes.filter((s) => Math.abs(s.strike - atm) <= n * step);
  const ce = w.reduce((a, s) => a + (s.ceOi || 0), 0), pe = w.reduce((a, s) => a + (s.peOi || 0), 0);
  return ce > 0 ? Math.round((pe / ce) * 100) / 100 : null;
}

/** VIX direction today: a rise of more than 5 % = fear rising (usually bearish for stocks); a fall of more than 5 % = easing. */
export function vixTrend(changePct: number | null | undefined): { label: string; tone: Band["tone"] } {
  if (changePct == null || !Number.isFinite(changePct)) return { label: "change unavailable", tone: "neutral" };
  if (changePct >= 5) return { label: `Fear rising (+${changePct.toFixed(1)}%) — usually bearish for the market`, tone: "bear" };
  if (changePct <= -5) return { label: `Fear easing (${changePct.toFixed(1)}%) — supportive for the market`, tone: "bull" };
  return { label: `Steady (${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}%)`, tone: "neutral" };
}
