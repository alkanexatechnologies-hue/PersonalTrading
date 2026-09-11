import YahooFinance from "yahoo-finance2";
import { Fundamentals } from "../types";

// Fundamentals source. Groww's API has NO fundamentals, so we use Yahoo's
// financials ONLY for growth/valuation/quality metrics (never for prices).
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });

// Market-cap bands (INR): 1 Cr = 1e7.
const SMALL_CAP = 2.5e11; // < ~25,000 Cr
const MID_CAP = 1.0e12; // < ~1,00,000 Cr

function pct(v: any): number | null {
  const n = Number(v);
  return isFinite(n) ? Math.round(n * 1000) / 10 : null; // fraction -> % (1 dp)
}
function num(v: any): number | null {
  const n = Number(v);
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Fundamentals change slowly (quarterly), so cache them to keep re-scans fast.
const cache = new Map<string, { at: number; data: Fundamentals | null }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function getFundamentals(symbol: string): Promise<Fundamentals | null> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const data = await fetchFundamentals(symbol);
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

// Fundamentals from Yahoo (Groww has none) - prices/candles/OI still come from Groww.
async function fetchFundamentals(symbol: string): Promise<Fundamentals | null> {
  let r: any;
  try {
    r = await yf.quoteSummary(symbol, {
      modules: ["price", "summaryDetail", "defaultKeyStatistics", "financialData", "assetProfile"],
    });
  } catch {
    return null; // Yahoo has no data for this symbol
  }

  const price = r?.price ?? {};
  const sd = r?.summaryDetail ?? {};
  const ks = r?.defaultKeyStatistics ?? {};
  const fd = r?.financialData ?? {};
  const ap = r?.assetProfile ?? {};

  const marketCap = num(price.marketCap);
  const capCategory: Fundamentals["capCategory"] =
    marketCap == null ? "Unknown" : marketCap < SMALL_CAP ? "Small" : marketCap < MID_CAP ? "Mid" : "Large";

  const revenueGrowthPct = pct(fd.revenueGrowth);
  const earningsGrowthPct = pct(fd.earningsGrowth ?? ks.earningsQuarterlyGrowth);
  const roePct = pct(fd.returnOnEquity);
  const profitMarginPct = pct(fd.profitMargins);
  const debtToEquity = num(fd.debtToEquity);
  const trailingPE = num(sd.trailingPE ?? price.trailingPE);
  const pegRatio = num(ks.pegRatio);

  // If Yahoo gave essentially nothing usable, treat as no data.
  if (
    marketCap == null &&
    revenueGrowthPct == null &&
    earningsGrowthPct == null &&
    roePct == null
  ) {
    return null;
  }

  // Growth/quality/value score (only from available metrics).
  let s = 0;
  const reasons: string[] = [];
  if (revenueGrowthPct != null) {
    s += revenueGrowthPct >= 20 ? 30 : revenueGrowthPct >= 10 ? 20 : revenueGrowthPct >= 0 ? 8 : -10;
    reasons.push(`Revenue ${revenueGrowthPct >= 0 ? "+" : ""}${revenueGrowthPct}%`);
  }
  if (earningsGrowthPct != null) {
    s += earningsGrowthPct >= 20 ? 25 : earningsGrowthPct >= 10 ? 15 : earningsGrowthPct >= 0 ? 6 : -12;
    reasons.push(`Earnings ${earningsGrowthPct >= 0 ? "+" : ""}${earningsGrowthPct}%`);
  }
  if (roePct != null) {
    s += roePct >= 18 ? 15 : roePct >= 12 ? 8 : roePct >= 0 ? 3 : -5;
    reasons.push(`ROE ${roePct}%`);
  }
  if (profitMarginPct != null) s += profitMarginPct > 0 ? 6 : -4;
  if (debtToEquity != null) {
    s += debtToEquity <= 50 ? 8 : debtToEquity <= 150 ? 0 : -8;
    reasons.push(`D/E ${debtToEquity}`);
  }
  if (pegRatio != null) {
    s += pegRatio > 0 && pegRatio < 1.5 ? 8 : pegRatio > 3 ? -6 : 2;
    reasons.push(`PEG ${pegRatio}`);
  }
  if (trailingPE != null) reasons.push(`P/E ${trailingPE}`);
  const growthScore = Math.max(0, Math.min(100, Math.round(s)));

  const capNote = capCategory === "Small" ? "Small-cap (room to grow, higher risk)" : capCategory === "Mid" ? "Mid-cap" : capCategory === "Large" ? "Large-cap" : "";
  const growthNote = [capNote, reasons.join(", ")].filter(Boolean).join(" · ") || "Limited fundamental data.";

  return {
    marketCap,
    capCategory,
    sector: ap.sector ?? null,
    trailingPE,
    pegRatio,
    revenueGrowthPct,
    earningsGrowthPct,
    roePct,
    profitMarginPct,
    debtToEquity,
    growthScore,
    growthNote,
  };
}
