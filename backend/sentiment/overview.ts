import { getProvider } from "../data";
import { getIndiaVix } from "../data/dhanProvider";
import { fetchDhanIntradayAllHours } from "../data/dhanHistorical";
import { candidateDates } from "./nseParticipantOi";
import { getMarketNews } from "../news/news";
import { fetchMarketData, marketDataConfigured, MdKey } from "./marketDataProvider";
import { getFiiFutures, fiiLeanOf } from "./fiiFutures";
import { dhanMovers } from "../data/dhanDataApis";
import { readModel } from "./niftyWeights";
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
  const run = async (): Promise<Quote> => {
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
    // MARKET CLOSED → the most recent session's close, clearly CLOSED, and only when
    // the candle is genuinely from the most recent session (not an old stale bar).
    // After the close the daily bar for TODAY is often not published yet, so the
    // last two daily bars would show YESTERDAY's change. The batched last price
    // (closedLtp) tells which bar is the previous close: if it equals the last
    // daily close, today's bar exists (compare with the bar before); otherwise
    // the last daily bar IS the previous close.
    try {
      const c: any[] = await getProvider().getCandles(sym, "1d", 3);
      if (Array.isArray(c) && c.length) {
        const ltp = _closedLtp.data[sym];
        if (ltp != null && ltp > 0 && Math.abs(c[c.length - 1].close - ltp) >= 0.01) {
          const pc = c[c.length - 1].close;
          return mkQuote(key, label, ltp, round2(ltp - pc), round2((ltp - pc) / pc * 100), null, marketOpen);
        }
        const last = c[c.length - 1], prev = c.length > 1 ? c[c.length - 2] : null;
        const price = last.close;
        const ageDays = last.time ? (Date.now() / 1000 - last.time) / 86400 : 999;
        if (price != null && prev && prev.close != null && ageDays <= 5) { // a real previous bar, within the last few days (covers weekends)
          const chg = prev && prev.close != null ? round2(price - prev.close) : null;
          const chgPct = prev && prev.close ? round2((price - prev.close) / prev.close * 100) : null;
          return mkQuote(key, label, price, chg, chgPct, last.time ?? null, marketOpen);
        }
      }
    } catch { /* daily candles unavailable — try the fallbacks below */ }
    // Stocks: NSE's official bhavcopy (5-minute bars do not give the official close for stocks).
    if (/\.NS$/.test(sym)) {
      try {
        const b = await bhavRow(sym.replace(/\.NS$/, ""));
        if (b) return mkQuote(key, label, b.close, round2(b.close - b.prev), round2((b.close - b.prev) / b.prev * 100), Math.floor(Date.parse(b.date + "T10:00:00Z") / 1000), marketOpen);
      } catch { /* none */ }
      return { key, label, value: null, change: null, changePct: null, ts: null, freshness: "UNAVAILABLE", source: null };
    }
    // Indices: last two sessions from 5-minute candles (Dhan's daily-candle service can fail while
    // intraday works). An index's last 5-minute bar close is its session close.
    try {
      const c5: any[] = await getProvider().getCandles(sym, "5m", 7);
      const byDay = new Map<string, any>();
      for (const x of c5 || []) byDay.set(new Date((x.time + 19800) * 1000).toISOString().slice(0, 10), x);
      const days = [...byDay.keys()].sort();
      if (days.length >= 2) {
        const last = byDay.get(days[days.length - 1]), prev = byDay.get(days[days.length - 2]);
        const ageDays = (Date.now() / 1000 - last.time) / 86400;
        if (last.close != null && prev.close && ageDays <= 5) {
          return mkQuote(key, label, last.close, round2(last.close - prev.close), round2((last.close - prev.close) / prev.close * 100), last.time, marketOpen);
        }
      }
    } catch { /* nothing available */ }
    return { key, label, value: null, change: null, changePct: null, ts: null, freshness: "UNAVAILABLE", source: null };
  };
  // Live single quotes go through the quote gate (Dhan Quote API ≈1 req/s); the closed-market
  // path reads daily candles (Data API), which dhanClient already paces per category.
  const built = marketOpen ? await qGate(run) : await run();
  // Only cache real values long; keep retrying an UNAVAILABLE sooner.
  _qCache.set(sym, { ts: built.value != null ? Date.now() : Date.now() - (ttl - 15_000), q: built });
  return built;
}

// MARKET OPEN: one batched /marketfeed/ohlc call for every overview symbol (same lookup and
// parser as getQuote, so values are identical) instead of ~13 serial single quotes 400 ms apart.
// Fills the per-symbol cache that quoteReal reads; symbols the batch misses fall back to the
// single-quote path inside quoteReal.
async function prefetchLive(syms: string[]): Promise<void> {
  const need = syms.filter((s) => { const h = _qCache.get(s); return !h || Date.now() - h.ts >= Q_TTL_OPEN; });
  if (!need.length) return;
  const p: any = getProvider();
  if (typeof p.getQuotes !== "function") return;
  try {
    const qs: Record<string, any> = await qGate(() => p.getQuotes(need));
    for (const s0 of need) {
      const q: any = qs?.[s0];
      if (!q || q.price == null) continue;
      const mt = q.marketTime && q.marketTime > 0 ? q.marketTime : null;
      _qCache.set(s0, { ts: Date.now(), q: mkQuote(s0, s0, q.price, q.change ?? null, q.changePercent ?? q.changePct ?? null, mt, true) });
    }
  } catch { /* quoteReal falls back to single quotes */ }
}

// ---- NSE bhavcopy (official close + previous close for every stock), the stock fallback while
// the market is closed and Dhan's daily candles are unavailable. Latest published file, cached 1 h.
let _bhav: { at: number; date: string; rows: Map<string, { close: number; prev: number }> } | null = null;
export function parseBhav(csv: string): Map<string, { close: number; prev: number }> {
  const lines = csv.replace(/\r/g, "").split("\n");
  const head = (lines[0] || "").split(",").map((h) => h.trim().toUpperCase());
  const iS = head.indexOf("SYMBOL"), iSer = head.indexOf("SERIES"), iP = head.indexOf("PREV_CLOSE"), iC = head.indexOf("CLOSE_PRICE");
  const out = new Map<string, { close: number; prev: number }>();
  if ([iS, iSer, iP, iC].some((i) => i < 0)) return out;
  for (const l of lines.slice(1)) {
    const c = l.split(",").map((x) => x.trim());
    if (c[iSer] !== "EQ") continue;
    const close = Number(c[iC]), prev = Number(c[iP]);
    if (close > 0 && prev > 0) out.set(c[iS], { close, prev });
  }
  return out;
}
async function bhavRow(nseSymbol: string): Promise<{ close: number; prev: number; date: string } | null> {
  if (!_bhav || Date.now() - _bhav.at > 3600_000) {
    for (const d of candidateDates(Math.floor(Date.now() / 1000), 5)) {
      try {
        const r = await fetch(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d.slice(8, 10)}${d.slice(5, 7)}${d.slice(0, 4)}.csv`, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" } as any, signal: AbortSignal.timeout(10000) });
        if (!r.ok) continue;
        const rows = parseBhav(await r.text());
        if (rows.size > 500) { _bhav = { at: Date.now(), date: d, rows }; break; }
      } catch { /* try the previous day */ }
    }
    if (!_bhav) return null;
  }
  const x = _bhav.rows.get(nseSymbol);
  return x ? { ...x, date: _bhav.date } : null;
}

// ---- GIFT NIFTY from Dhan (IDX_I 5024; trades ~06:30–02:45 IST on NSE IX) ----
// Value = latest 5-minute bar; change = gap against NIFTY's last session close (what GIFT NIFTY
// is read for before the open). Cached 60 s. Freshness from the bar's own time.
const GIFT_SEC = { securityId: "5024", exchangeSegment: "IDX_I", instrument: "INDEX" };
let _gift: { at: number; close: number; ts: number } | null = null;
async function giftNifty(niftyRef: number | null): Promise<Quote | null> {
  try {
    if (!_gift || Date.now() - _gift.at > 60_000) {
      const ist = (ms: number) => new Date(ms + 19800_000).toISOString().slice(0, 10);
      const c = await fetchDhanIntradayAllHours(GIFT_SEC, "5", ist(Date.now() - 4 * 86400_000), ist(Date.now() + 86400_000));
      const last = c[c.length - 1];
      if (!last || !(last.close > 0)) return null;
      _gift = { at: Date.now(), close: last.close, ts: last.time };
    }
    const ageMin = (Date.now() / 1000 - _gift.ts) / 60;
    const freshness: Freshness = ageMin < 10 ? "LIVE" : ageMin < 60 ? "DELAYED" : "STALE";
    const chg = niftyRef ? round2(_gift.close - niftyRef) : null;
    return { key: "GIFTNIFTY", label: "GIFT NIFTY", value: round2(_gift.close), change: chg, changePct: niftyRef && chg != null ? round2(chg / niftyRef * 100) : null, ts: _gift.ts, freshness, source: "DHAN · vs NIFTY close" };
  } catch { return null; }
}

// India VIX: keep the last good value (≤ 18 h) through Dhan quote hiccups (e.g. 502s), marked STALE.
let _vixLast: { at: number; q: Quote } | null = null;

// One batched last-price call (ONE Dhan request) per 30 min while closed — see quoteReal.
let _closedLtp: { at: number; data: Record<string, number> } = { at: 0, data: {} };
async function refreshClosedLtp(syms: string[]): Promise<void> {
  if (Date.now() - _closedLtp.at < Q_TTL_CLOSED) return;
  const p: any = getProvider();
  if (typeof p.getQuotes !== "function") return;
  _closedLtp.at = Date.now();
  try {
    const qs: Record<string, any> = await qGate(() => p.getQuotes(syms));
    const data: Record<string, number> = {};
    for (const [s0, q0] of Object.entries(qs || {})) if (q0 && q0.price != null) data[s0] = q0.price;
    _closedLtp = { at: Date.now(), data };
  } catch { _closedLtp.at = Date.now() - Q_TTL_CLOSED + 60_000; /* retry in a minute */ }
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

/** `force` (the 09:13 full refresh) drops every quote cache and waits for fresh Yahoo and news. */
export async function buildPremarketOverview(opts: { force?: boolean } = {}): Promise<PremarketOverview> {
  if (opts.force) { _qCache.clear(); _closedLtp.at = 0; }
  const now = Date.now();
  const marketOpen = marketOpenNow(now);

  // Independent sources start together (they used to run one after another).
  const mdKeys: MdKey[] = ["GIFTNIFTY","USDINR","DXY","US10Y","BRENT","WTI","GOLD","CBOEVIX","SPX","NASDAQ","DOW","USFUT","NIKKEI","HANGSENG","SHANGHAI","KOSPI","TAIWAN","FTSE","DAX","CAC"];
  const mdP = fetchMarketData(mdKeys, { force: opts.force });
  const fiiP = getFiiFutures(20);
  const newsP = getMarketNews(!!opts.force);
  const vixP = getIndiaVix();
  [mdP, fiiP, newsP, vixP].forEach((pr) => (pr as Promise<unknown>).catch(() => null));

  // ---- Indian indices + VIX (REAL, Dhan) ----
  const allSyms = [...INDICES.map((i) => i.sym), ...LARGECAPS];
  if (marketOpen) await prefetchLive(allSyms);
  else await refreshClosedLtp(allSyms);
  const idxQuotes = await Promise.all(INDICES.map((i) => quoteReal(i.sym, i.label, i.key, marketOpen)));
  const idxByKey: Record<string, Quote> = Object.fromEntries(idxQuotes.map((q) => [q.key, q]));
  let vixQuote: Quote = { key: "INDIA VIX", label: "INDIA VIX", value: null, change: null, changePct: null, ts: null, freshness: "UNAVAILABLE", source: null };
  try {
    const v: any = await vixP;
    if (v && v.available && v.value != null) vixQuote = { key: "INDIA VIX", label: "INDIA VIX", value: v.value, change: v.change ?? null, changePct: v.changePct ?? null, ts: v.ts ?? null, freshness: quoteFreshness(v.ts ?? null, marketOpen), source: "DHAN" };
  } catch { /* unavailable */ }
  if (vixQuote.value != null) _vixLast = { at: Date.now(), q: vixQuote };
  else if (_vixLast && Date.now() - _vixLast.at < 18 * 3600_000) vixQuote = { ..._vixLast.q, freshness: "STALE" };

  // ---- External macro / global / GIFT (provider; UNAVAILABLE until key set) ----
  const md = await mdP;

  // ---- Strip (order matches the mockup) ----
  // GIFT NIFTY: Dhan first (Yahoo has no symbol for it); gap vs NIFTY's last session close.
  const niftyRef = idxByKey.NIFTY?.value != null ? (marketOpen ? (idxByKey.NIFTY.change != null ? round2(idxByKey.NIFTY.value - idxByKey.NIFTY.change) : null) : idxByKey.NIFTY.value) : null;
  const gift = await giftNifty(niftyRef);
  const strip: Quote[] = [
    gift || md.GIFTNIFTY, idxByKey.NIFTY, idxByKey.BANKNIFTY, idxByKey.FINNIFTY, idxByKey.SENSEX,
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
  let gainers: MoverRow[] = capRows.filter((r) => (r.changePct ?? 0) > 0).sort((a, b) => (b.estImpact ?? 0) - (a.estImpact ?? 0)).slice(0, 5).map((r, i) => ({ rank: i + 1, ...r }));
  let losers: MoverRow[] = capRows.filter((r) => (r.changePct ?? 0) < 0).sort((a, b) => (a.estImpact ?? 0) - (b.estImpact ?? 0)).slice(0, 5).map((r, i) => ({ rank: i + 1, ...r }));
  let moversNote = "Ranked by estimated index impact across tracked large-caps.";
  // Preferred: Dhan market movers — the real NIFTY 50 top gainers / losers by % change.
  const dm = await niftyMoversFromDhan(niftyLevel);
  if (dm) { gainers = dm.gainers; losers = dm.losers; moversNote = dm.note; }
  const moversAvail = gainers.length + losers.length > 0;

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
    const n = await newsP;
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
  const fii = await fiiP;
  const fiiLean = fiiLeanOf(fii);
  const fiiPct = fii.rows[0]?.longPct;

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
  factor(fiiLean, fiiPct != null ? `FIIs net long index futures (${fiiPct}% long)` : "FII futures supportive",
    fiiPct != null && fiiPct < 40 ? `FIIs net short index futures (${fiiPct}% long)` : "FII building shorts");
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
    movers: { gainers, losers, freshness: moversAvail ? (marketOpen ? "LIVE" : "CLOSED") : "UNAVAILABLE", note: moversAvail ? moversNote : "DATA UNAVAILABLE." },
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

/** NIFTY 50 top gainers / losers from Dhan market movers. Index impact uses the estimated
 *  contribution model's coefficient when one exists for the stock. Null when Dhan fails. */
async function niftyMoversFromDhan(niftyLevel: number | null): Promise<{ gainers: MoverRow[]; losers: MoverRow[]; note: string } | null> {
  try {
    const [g, l] = await Promise.all((["PRICE_GAINERS", "PRICE_LOSERS"] as const).map((category) =>
      dhanMovers({ exchangeSegment: "NSE_EQ", instrument: ["EQUITY"], category, universe: "NIFTY_50", limit: 5 })));
    const coefs = readModel()?.coefs || {};
    const row = (r: { name: string; symbol: string; ltp: number | null; changePct: number | null }, i: number): MoverRow => {
      const c = coefs[r.symbol], pct = r.changePct == null ? null : round2(r.changePct);
      return { rank: i + 1, stock: r.name, price: r.ltp, changePct: pct, weight: c != null ? round2(c * 100) : null,
        estImpact: c != null && pct != null && niftyLevel != null ? Math.round(((c * pct) / 100) * niftyLevel * 10) / 10 : null, direction: dir(pct) };
    };
    const gainers = g.rows.filter((r) => (r.changePct ?? 0) > 0).map(row), losers = l.rows.filter((r) => (r.changePct ?? 0) < 0).map(row);
    if (!gainers.length && !losers.length) return null;
    return { gainers, losers, note: `NIFTY 50 top gainers / losers by % change — Dhan market movers${g.stale || l.stale ? " (last good copy)" : ""}. Impact = estimated contribution model, not official weights.` };
  } catch { return null; }
}
