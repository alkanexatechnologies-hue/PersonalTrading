import { getProvider } from "../data";
import { getIndiaVix } from "../data/dhanProvider";
import { getMarketNews } from "../news/news";
import { fetchMarketData, marketDataConfigured, MdKey } from "./marketDataProvider";
import { getFiiFutures } from "./fiiFutures";
import { computeProbability, overallBiasFromLeans, ProbInputs } from "./probability";
import { saveSnapshot, currentSlot, slotNeedsSnapshot } from "./snapshotStore";
import type { Quote, Freshness, BankRow, MoverRow, SectorRow, OverallSentiment, IndexProbability, Bias, Direction, SentimentSnapshot } from "./types";

// ============================ 09:10 Market & Global Sentiment — assembly ============================
// Pulls REAL data from the existing Dhan provider (Indian indices + VIX), the
// existing news engine, and the pluggable external provider (macro/global/FII).
// Everything is tagged with its own freshness; anything without a source is
// DATA UNAVAILABLE. This module NEVER fabricates a value and NEVER trades.

// Public, well-known NIFTY index weights (%) — reference constants used ONLY to
// ESTIMATE point contribution (labelled "estimated"), the same way the app stores
// lot sizes / strike steps. Not market data; edit when the index rebalances.
const NIFTY_WEIGHT: Record<string, number> = {
  "HDFCBANK.NS": 11.0, "ICICIBANK.NS": 8.2, "RELIANCE.NS": 9.0, "INFY.NS": 5.5,
  "TCS.NS": 4.0, "SBIN.NS": 3.0, "AXISBANK.NS": 3.0, "KOTAKBANK.NS": 2.5,
};
const BANKS = [
  { sym: "HDFCBANK.NS", name: "HDFC Bank" }, { sym: "ICICIBANK.NS", name: "ICICI Bank" },
  { sym: "SBIN.NS", name: "SBI" }, { sym: "AXISBANK.NS", name: "Axis Bank" },
  { sym: "KOTAKBANK.NS", name: "Kotak Bank" },
];
const LARGECAPS = [...BANKS.map((b) => b.sym), "RELIANCE.NS", "INFY.NS", "TCS.NS"];
const NAME: Record<string, string> = { "RELIANCE.NS": "Reliance", "INFY.NS": "Infosys", "TCS.NS": "TCS", ...Object.fromEntries(BANKS.map((b) => [b.sym, b.name])) };

const INDICES = [
  { key: "NIFTY", label: "NIFTY 50", sym: "^NSEI" },
  { key: "BANKNIFTY", label: "BANKNIFTY", sym: "^NSEBANK" },
  { key: "FINNIFTY", label: "FINNIFTY", sym: "^CNXFIN" },
  { key: "SENSEX", label: "SENSEX", sym: "^BSESN" },
];

function marketOpenNow(now = Date.now()): boolean {
  const ist = new Date(now + 19800000);
  const day = ist.getUTCDay(); if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}
// Freshness for a quote that HAS a real value. A missing timestamp with the
// market closed is CLOSED (we have the last session's value), not UNAVAILABLE —
// UNAVAILABLE is reserved for "no value at all".
function quoteFreshness(marketTime: number | null, marketOpen: boolean): Freshness {
  if (!marketOpen) return "CLOSED";
  if (marketTime == null) return "DELAYED";
  const ageMs = Date.now() - marketTime * 1000;
  if (ageMs < 30_000) return "LIVE";
  if (ageMs < 5 * 60_000) return "DELAYED";
  return "STALE";
}
const dir = (pct: number | null): Direction => pct == null ? "NEUTRAL" : pct > 0.05 ? "UP" : pct < -0.05 ? "DOWN" : "NEUTRAL";

// ---- Throttled + cached quote with a last-daily-close fallback ----
// The overview fans out ~12 symbols at once; firing them all in parallel trips
// Dhan's rate limit (DH-904) and everything falls back to UNAVAILABLE. So quotes
// go through a small concurrency gate, a short per-symbol cache, and — when the
// live quote is missing or rate-limited — a last-daily-close fallback so the
// segment shows a real CLOSED value instead of nothing. Never fabricated.
const _qCache = new Map<string, { ts: number; q: Quote }>();
const Q_TTL_OPEN = 25_000;           // < route cache (30s) so each rebuild refetches live quotes
const Q_TTL_CLOSED = 30 * 60_000;    // daily close is static — cache long
let _qActive = 0; const _qWaiters: Array<() => void> = [];
let _qLast = 0; const Q_GAP_MS = 400; // serial + ~400ms spacing → ≈2.5 req/s, under Dhan's limit
async function qGate<T>(fn: () => Promise<T>): Promise<T> {
  if (_qActive >= 1) await new Promise<void>((r) => _qWaiters.push(r));
  _qActive++;
  const wait = Q_GAP_MS - (Date.now() - _qLast);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _qLast = Date.now();
  try { return await fn(); } finally { _qActive--; const n = _qWaiters.shift(); if (n) n(); }
}
function mkQuote(key: string, label: string, price: number, chg: number | null, chgPct: number | null, mt: number | null, marketOpen: boolean): Quote {
  return { key, label, value: price, change: chg, changePct: chgPct, ts: mt, freshness: quoteFreshness(mt, marketOpen), source: "DHAN" };
}
async function quoteReal(sym: string, label: string, key: string, marketOpen: boolean): Promise<Quote> {
  const ttl = marketOpen ? Q_TTL_OPEN : Q_TTL_CLOSED;
  const hit = _qCache.get(sym);
  if (hit && Date.now() - hit.ts < ttl) {
    // Recompute freshness from the quote's own provider timestamp so a cached
    // value never under-reports how stale it is.
    const fresh = hit.q.value == null ? "UNAVAILABLE" : quoteFreshness(hit.q.ts, marketOpen);
    return { ...hit.q, key, label, freshness: fresh };
  }
  const built = await qGate(async (): Promise<Quote> => {
    if (marketOpen) {
      // MARKET OPEN → only a LIVE quote (today's move). NEVER fall back to the
      // daily close here: a prior session's direction shown as "today" is
      // dangerous to trade on. If the live quote is missing, report UNAVAILABLE.
      try {
        const q: any = await getProvider().getQuote(sym);
        if (q && q.price != null) {
          const mt = q.marketTime && q.marketTime > 0 ? q.marketTime : null;
          return mkQuote(key, label, q.price, q.change ?? null, q.changePercent ?? q.changePct ?? null, mt, marketOpen);
        }
      } catch { /* live quote unavailable → report UNAVAILABLE, do not show stale */ }
      return { key, label, value: null, change: null, changePct: null, ts: null, freshness: "UNAVAILABLE", source: null };
    }
    // MARKET CLOSED → the previous session's close, clearly CLOSED, and only when
    // the candle is genuinely from the most recent session (not an old stale bar).
    try {
      const c: any[] = await getProvider().getCandles(sym, "1d", 3);
      if (Array.isArray(c) && c.length) {
        const last = c[c.length - 1], prev = c.length > 1 ? c[c.length - 2] : null;
        const price = last.close;
        const ageDays = last.time ? (Date.now() / 1000 - last.time) / 86400 : 999;
        if (price != null && ageDays <= 5) { // within the last few calendar days (covers weekends)
          const chg = prev && prev.close != null ? round2(price - prev.close) : null;
          const chgPct = prev && prev.close ? round2((price - prev.close) / prev.close * 100) : null;
          return mkQuote(key, label, price, chg, chgPct, last.time ?? null, marketOpen);
        }
      }
    } catch { /* nothing available */ }
    return { key, label, value: null, change: null, changePct: null, ts: null, freshness: "UNAVAILABLE", source: null };
  });
  // Only cache real values long; keep retrying an UNAVAILABLE sooner.
  _qCache.set(sym, { ts: built.value != null ? Date.now() : Date.now() - (ttl - 15_000), q: built });
  return built;
}

export interface PremarketOverview {
  ts: number; slot: string; marketOpen: boolean;
  strip: Quote[];
  overall: OverallSentiment;
  probability: IndexProbability[];
  sectors: { rows: SectorRow[]; freshness: Freshness; note: string };
  banks: { rows: BankRow[]; netImpact: number | null; bias: Bias; freshness: Freshness; note: string };
  movers: { gainers: MoverRow[]; losers: MoverRow[]; freshness: Freshness; note: string };
  global: { us: Quote[]; asia: Quote[]; europe: Quote[]; bias: Bias; freshness: Freshness };
  macro: Quote[];
  fii: Awaited<ReturnType<typeof getFiiFutures>>;
  news: { items: any[]; freshness: Freshness };
  providers: { marketData: boolean; fii: boolean };
}

export async function buildPremarketOverview(): Promise<PremarketOverview> {
  const now = Date.now();
  const marketOpen = marketOpenNow(now);

  // ---- Indian indices + VIX (REAL, Dhan) ----
  const idxQuotes = await Promise.all(INDICES.map((i) => quoteReal(i.sym, i.label, i.key, marketOpen)));
  const idxByKey: Record<string, Quote> = Object.fromEntries(idxQuotes.map((q) => [q.key, q]));
  let vixQuote: Quote = { key: "INDIA VIX", label: "INDIA VIX", value: null, change: null, changePct: null, ts: null, freshness: "UNAVAILABLE", source: null };
  try {
    const v: any = await getIndiaVix();
    if (v && v.available && v.value != null) vixQuote = { key: "INDIA VIX", label: "INDIA VIX", value: v.value, change: v.change ?? null, changePct: v.changePct ?? null, ts: v.ts ?? null, freshness: quoteFreshness(v.ts ?? null, marketOpen), source: "DHAN" };
  } catch { /* unavailable */ }

  // ---- External macro / global / GIFT (provider; UNAVAILABLE until key set) ----
  const mdKeys: MdKey[] = ["GIFTNIFTY","USDINR","DXY","US10Y","BRENT","WTI","GOLD","CBOEVIX","SPX","NASDAQ","DOW","USFUT","NIKKEI","HANGSENG","SHANGHAI","KOSPI","TAIWAN","FTSE","DAX","CAC"];
  const md = await fetchMarketData(mdKeys);

  // ---- Strip (order matches the mockup) ----
  const strip: Quote[] = [
    md.GIFTNIFTY, idxByKey.NIFTY, idxByKey.BANKNIFTY, idxByKey.FINNIFTY, idxByKey.SENSEX,
    vixQuote, md.USDINR, md.DXY, md.US10Y, md.BRENT, md.GOLD,
  ];

  // ---- Bank leaders (REAL quotes + reference weights → estimated contribution) ----
  const bankQuotes = await Promise.all(BANKS.map((b) => quoteReal(b.sym, b.name, b.sym, marketOpen)));
  const niftyLevel = idxByKey.NIFTY?.value ?? null;
  const bankRows: BankRow[] = bankQuotes.map((q, i) => {
    const w = NIFTY_WEIGHT[BANKS[i].sym] ?? null;
    const ptsPer1pct = w != null && niftyLevel != null ? round2(niftyLevel * w / 10000) : null;
    const estContribution = ptsPer1pct != null && q.changePct != null ? round2(ptsPer1pct * q.changePct) : null;
    return { stock: BANKS[i].name, price: q.value, pctMove: q.changePct, direction: dir(q.changePct), weight: w, ptsPer1pct, estContribution, volume: null, ts: q.ts, freshness: q.freshness };
  });
  const bankNet = bankRows.reduce((a, r) => a + (r.estContribution ?? 0), 0);
  const bankPos = bankRows.filter((r) => (r.estContribution ?? 0) > 0.5).length;
  const bankNeg = bankRows.filter((r) => (r.estContribution ?? 0) < -0.5).length;
  const bankingBias: Bias = bankRows.every((r) => r.freshness === "UNAVAILABLE") ? "NEUTRAL" : bankPos > bankNeg && bankNet > 1 ? "BULLISH" : bankNeg > bankPos && bankNet < -1 ? "BEARISH" : "MIXED";
  const banksAvail = bankRows.some((r) => r.freshness !== "UNAVAILABLE");

  // ---- Top movers among the tracked large-caps (REAL quotes only) ----
  const capQuotes = await Promise.all(LARGECAPS.map((s) => quoteReal(s, NAME[s] || s, s, marketOpen)));
  const capRows = capQuotes.filter((q) => q.changePct != null).map((q) => {
    const w = NIFTY_WEIGHT[q.key] ?? null;
    const est = w != null && niftyLevel != null && q.changePct != null ? round2(niftyLevel * w / 10000 * q.changePct) : null;
    return { stock: q.label, price: q.value, changePct: q.changePct, weight: w, estImpact: est, direction: dir(q.changePct) };
  });
  const gainers: MoverRow[] = capRows.filter((r) => (r.changePct ?? 0) > 0).sort((a, b) => (b.estImpact ?? 0) - (a.estImpact ?? 0)).slice(0, 5).map((r, i) => ({ rank: i + 1, ...r }));
  const losers: MoverRow[] = capRows.filter((r) => (r.changePct ?? 0) < 0).sort((a, b) => (a.estImpact ?? 0) - (b.estImpact ?? 0)).slice(0, 5).map((r, i) => ({ rank: i + 1, ...r }));
  const moversAvail = capRows.length > 0;

  // ---- Sector analysis: only sectors we can back with a REAL representative quote ----
  const bankPct = idxByKey.BANKNIFTY?.changePct ?? null;
  const itPct = avg([q(capQuotes, "INFY.NS"), q(capQuotes, "TCS.NS")]);
  const enPct = q(capQuotes, "RELIANCE.NS");
  const sectorDefs: { sector: string; pct: number | null; weight: number; key: string[]; reason: string }[] = [
    { sector: "Banking & Financials", pct: bankPct, weight: 35.2, key: ["HDFC","ICICI","SBI"], reason: "From BANKNIFTY move" },
    { sector: "IT", pct: itPct, weight: 14.8, key: ["TCS","Infosys"], reason: "From TCS / Infosys" },
    { sector: "Energy (Oil & Gas)", pct: enPct, weight: 12.4, key: ["Reliance"], reason: "From Reliance" },
  ];
  const sectorRows: SectorRow[] = sectorDefs.filter((s) => s.pct != null).map((s) => ({
    sector: s.sector, direction: dir(s.pct), pctMove: s.pct, advancers: null, decliners: null,
    weight: s.weight, estImpact: niftyLevel != null && s.pct != null ? round2(niftyLevel * s.weight / 10000 * s.pct) : null,
    strength: s.pct == null ? null : Math.abs(s.pct) > 0.8 ? "STRONG" : Math.abs(s.pct) > 0.3 ? "MODERATE" : "WEAK",
    keyStocks: s.key, reason: s.reason, ts: null, freshness: marketOpen ? "LIVE" : "CLOSED",
  }));

  // ---- News (REAL RSS, classified) ----
  let newsItems: any[] = []; let newsFresh: Freshness = "UNAVAILABLE";
  try {
    const n = await getMarketNews();
    if (Array.isArray(n.items)) {
      newsItems = n.items.slice(0, 12).map((it: any) => ({
        time: it.ago || "", impact: it.impact === "high" ? "HIGH" : "MEDIUM",
        category: (it.tags && it.tags[0]) || "Market", title: it.title, source: it.source, link: it.link, sentiment: it.sentiment,
      }));
      newsFresh = "LIVE";
    }
  } catch { /* unavailable */ }
  const newsLean = newsItems.length ? clamp(newsItems.filter((n) => n.impact === "HIGH").reduce((a, n) => a + (n.sentiment === "positive" ? 1 : n.sentiment === "negative" ? -1 : 0), 0) / Math.max(1, newsItems.filter((n) => n.impact === "HIGH").length), -1, 1) : null;

  // ---- FII futures (provider / NSE; UNAVAILABLE until source) ----
  const fii = await getFiiFutures(20);
  const fiiLean = fii.available && fii.pressure ? (fii.pressure === "UPWARD" ? 0.6 : fii.pressure === "DOWNWARD" ? -0.6 : 0) : null;

  // ---- Global bias from the external indices that resolved ----
  const us = [md.SPX, md.NASDAQ, md.DOW, md.USFUT];
  const asia = [md.NIKKEI, md.HANGSENG, md.SHANGHAI, md.KOSPI, md.TAIWAN];
  const europe = [md.FTSE, md.DAX, md.CAC];
  const globalPcts = [...us, ...asia, ...europe].filter((qq) => qq.freshness !== "UNAVAILABLE" && qq.changePct != null).map((qq) => qq.changePct as number);
  const globalLean = globalPcts.length ? clamp(globalPcts.reduce((a, b) => a + b, 0) / globalPcts.length / 1.0, -1, 1) : null;
  const globalBias = overallBiasFromLeans(globalPcts.map((p) => clamp(p, -1, 1)));

  // ---- Leans → overall sentiment ----
  const niftyPct = idxByKey.NIFTY?.changePct ?? null;
  const breadthUp = capRows.filter((r) => (r.changePct ?? 0) > 0).length;
  const breadthDown = capRows.filter((r) => (r.changePct ?? 0) < 0).length;
  const breadthLean = capRows.length ? clamp((breadthUp - breadthDown) / capRows.length, -1, 1) : null;
  const bankingLean = banksAvail ? clamp(bankNet / 15, -1, 1) : null;
  const indexLean = niftyPct != null ? clamp(niftyPct / 1.5, -1, 1) : null;
  const overallBias = overallBiasFromLeans([indexLean, globalLean, fiiLean, bankingLean, breadthLean, newsLean]);
  const positives: string[] = [], negatives: string[] = [];
  // Each factor contributes to EITHER positives or negatives (never both) by the
  // sign of its own lean.
  const factor = (lean: number | null, posLabel: string, negLabel: string) => {
    if (lean == null) return;
    if (lean > 0.15) positives.push(posLabel);
    else if (lean < -0.15) negatives.push(negLabel);
  };
  factor(indexLean, "NIFTY holding up", "NIFTY under pressure");
  factor(globalLean, "Global markets supportive", "Weak global cues");
  factor(fiiLean, "FII futures supportive", "FII building shorts");
  factor(bankingLean, "Banking heavyweights positive", "Banking heavyweights dragging");
  factor(breadthLean, "Breadth positive", "Breadth negative");
  factor(newsLean, "News flow positive", "Negative news flow");
  const riskLevel = vixQuote.value == null ? null : vixQuote.value >= 20 ? "HIGH" : vixQuote.value >= 14 ? "MEDIUM" : "LOW";
  const overall: OverallSentiment = {
    bias: overallBias, confidence: leanConfidence([indexLean, globalLean, fiiLean, bankingLean, breadthLean, newsLean]),
    estNiftyMove: estMoveText(niftyLevel, vixQuote.value, overallBias),
    breadthUp, breadthDown, breadthNeutral: 0, bankingBias, globalBias, riskLevel,
    positives: dedupe(positives).slice(0, 4), negatives: dedupe(negatives).slice(0, 4),
    freshness: idxByKey.NIFTY?.freshness ?? "UNAVAILABLE",
  };

  // ---- Probabilities per index ----
  const mkProb = (index: string, q0: Quote): IndexProbability => computeProbability({
    index, changePct: q0?.changePct ?? null, vix: vixQuote.value, vixChangePct: vixQuote.changePct,
    newsLean, globalLean, fiiLean, bankingLean, breadthLean, spot: q0?.value ?? null,
  } as ProbInputs);
  const probability = [mkProb("NIFTY 50", idxByKey.NIFTY), mkProb("BANKNIFTY", idxByKey.BANKNIFTY), mkProb("FINNIFTY", idxByKey.FINNIFTY)];

  // ---- Store the 30-min snapshot (deduped by slot) ----
  const slot = currentSlot(now);
  if (slotNeedsSnapshot(now)) {
    const snap: SentimentSnapshot = {
      ts: Math.floor(now / 1000), slot, date: new Date(now + 19800000).toISOString().slice(0, 10),
      overall: overallBias, breadthUp, breadthDown, breadthNeutral: 0, bankingBias, globalBias, riskLevel,
      fiiContext: fii.available ? fii.behaviour : "DATA UNAVAILABLE",
      niftyProb: probability[0]?.downside ?? null, bankniftyProb: probability[1]?.downside ?? null, finniftyProb: probability[2]?.downside ?? null,
      topPositive: positives[0] ?? null, topNegative: negatives[0] ?? null,
    };
    try { saveSnapshot(snap); } catch { /* best-effort */ }
  }

  return {
    ts: Math.floor(now / 1000), slot, marketOpen, strip, overall, probability,
    sectors: { rows: sectorRows, freshness: sectorRows.length ? (marketOpen ? "LIVE" : "CLOSED") : "UNAVAILABLE", note: sectorRows.length ? "Direction from representative constituents; full 12-sector advance/decline breadth needs a constituent feed." : "DATA UNAVAILABLE — sector constituent feed not connected." },
    banks: { rows: bankRows, netImpact: banksAvail ? round2(bankNet) : null, bias: bankingBias, freshness: banksAvail ? (marketOpen ? "LIVE" : "CLOSED") : "UNAVAILABLE", note: "Estimated contribution = reference NIFTY weight × observed % move." },
    movers: { gainers, losers, freshness: moversAvail ? (marketOpen ? "LIVE" : "CLOSED") : "UNAVAILABLE", note: moversAvail ? "Ranked by estimated index impact across tracked large-caps." : "DATA UNAVAILABLE." },
    global: { us, asia, europe, bias: globalBias, freshness: globalPcts.length ? "DELAYED" : "UNAVAILABLE" },
    macro: [md.BRENT, md.WTI, md.GOLD, md.USDINR, md.DXY, md.US10Y, vixQuote, md.CBOEVIX],
    fii, news: { items: newsItems, freshness: newsFresh },
    providers: { marketData: marketDataConfigured(), fii: !!(process.env.FII_DATA_URL || fii.available) },
  };
}

// ---- small helpers ----
function round2(n: number): number { return Math.round(n * 100) / 100; }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function dedupe(xs: string[]): string[] { return [...new Set(xs)]; }
function q(quotes: Quote[], sym: string): number | null { const x = quotes.find((z) => z.key === sym); return x?.changePct ?? null; }
function avg(xs: (number | null)[]): number | null { const v = xs.filter((x): x is number => x != null); return v.length ? round2(v.reduce((a, b) => a + b, 0) / v.length) : null; }
function leanConfidence(leans: (number | null)[]): number | null {
  const present = leans.filter((l): l is number => l != null);
  if (present.length < 3) return null;
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  const agree = 1 - Math.sqrt(present.reduce((a, b) => a + (b - mean) ** 2, 0) / present.length);
  return Math.round(clamp(present.length * 10 + agree * 30, 20, 95));
}
function estMoveText(spot: number | null, vix: number | null, bias: Bias): string | null {
  if (spot == null || vix == null) return null;
  const sigmaDay = (vix / 100) / Math.sqrt(252);
  const band = Math.round(spot * sigmaDay);
  if (bias === "BEARISH") return `-${Math.round(band * 0.6)} to -${band} pts`;
  if (bias === "BULLISH") return `+${Math.round(band * 0.6)} to +${band} pts`;
  return `±${band} pts`;
}
