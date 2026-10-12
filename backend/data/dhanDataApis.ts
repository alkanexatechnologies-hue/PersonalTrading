import { dhanFetch } from "./dhanClient";
import { loadDhanConfig } from "./dhanConfig";

// ============================ Dhan data APIs (read-only) ============================
// /data/newsheadline · /data/technical · /data/marketmovers · /data/companyinfo
// Every call goes through dhanFetch (allowlist + rate-limit gate). Results are cached per request so
// screens polling every few seconds never multiply Dhan calls; a failed call serves the last good copy.

const TTL = { news: 120_000, technical: 60_000, movers: 60_000, company: 6 * 3600_000 };
const cache = new Map<string, { at: number; data: any }>();
const inflight = new Map<string, Promise<any>>();

async function post(path: string, body: Record<string, unknown>): Promise<any> {
  const cfg = loadDhanConfig(); if (!cfg.accessToken) throw new Error("Dhan not connected");
  const r = await dhanFetch(path, { method: "POST", body, accessToken: cfg.accessToken, clientId: cfg.clientId });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || !j || j.errorCode || j.status === "failed") throw new Error(`${path} ${r.status} ${j?.errorCode || j?.errorMessage || ""}`.trim());
  return j;
}
/** Cached call: fresh within `ttl`; on error returns the last good copy (flagged stale) or throws. */
async function cached(key: string, ttl: number, fn: () => Promise<any>): Promise<{ data: any; at: number; stale: boolean }> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttl) return { data: c.data, at: c.at, stale: false };
  let p = inflight.get(key);
  if (!p) { p = fn().then((d) => { cache.set(key, { at: Date.now(), data: d }); return d; }).finally(() => inflight.delete(key)); inflight.set(key, p); }
  try { const d = await p; return { data: d, at: cache.get(key)!.at, stale: false }; }
  catch (e) { if (c) return { data: c.data, at: c.at, stale: true }; throw e; }
}

// ---- news ----
export type DhanNewsCat = "ALL" | "COMPANIES" | "EQUITY_MARKETS" | "DEBT_MARKETS" | "IPO" | "GLOBAL" | "INDIAN_ECONOMY" | "GLOBAL_ECONOMY" | "CURRENCY"
  | "COMMODITIES" | "CRYPTOCURRENCIES" | "GOVERNMENT_POLICY_AND_REGULATION" | "INFRASTRUCTURE" | "INTERNATIONAL_TRADE" | "INVESTMENT_IDEAS"
  | "REAL_ESTATE" | "STARTUPS" | "TECHNOLOGY" | "MUTUAL_FUNDS";
export interface DhanNews { title: string; text: string; sentiment: "positive" | "negative" | "neutral"; category: string; subCategory: string; date: string; stock: string | null; symbol: string | null }
export function parseNews(j: any): DhanNews[] {
  return (j?.data?.latestNews || []).map((x: any) => ({
    title: String(x?.newsObject?.title || "").trim(), text: String(x?.newsObject?.text || "").trim(),
    sentiment: (["positive", "negative", "neutral"].includes(x?.newsObject?.overallSentiment) ? x.newsObject.overallSentiment : "neutral"),
    category: String(x?.category || ""), subCategory: String(x?.subCategory || ""), date: String(x?.publishDate || "").slice(0, 10),
    stock: x?.stockName || null, symbol: x?.displaySymbol || x?.smSymbol || null,
  })).filter((n: DhanNews) => n.title && /^\d{4}-\d{2}-\d{2}$/.test(n.date));
}
export async function dhanNews(categories: DhanNewsCat[], limit = 50) {
  const cfg = loadDhanConfig();
  const r = await cached(`news|${categories.join(",")}|${limit}`, TTL.news, () => post("/data/newsheadline", { dhanClientId: cfg.clientId, categories, limit: Math.min(50, limit) }));
  return { items: parseNews(r.data), at: r.at, stale: r.stale };
}

// ---- technical ----
export interface DhanSec { securityId: string; exchangeSegment: "NSE_EQ" | "IDX_I"; instrument: "INDEX" | "EQUITY" }
export const NIFTY_IDX: DhanSec = { securityId: "13", exchangeSegment: "IDX_I", instrument: "INDEX" };
export async function dhanTechnical(sec: DhanSec, timeframe: "1" | "5" | "15" | "D", indicators: string[]) {
  const r = await cached(`tech|${sec.securityId}|${timeframe}|${indicators.join(",")}`, TTL.technical, () => post("/data/technical", { ...sec, timeframe, indicators }));
  return { data: r.data?.data || {}, at: r.at, stale: r.stale };
}

// ---- market movers ----
export interface MoverRow { name: string; symbol: string; instrument: string; expiry: string | null; strike: number | null; ltp: number | null; changePct: number | null; volume: number | null; oi: number | null; oiChgPct: number | null; pcr: number | null; underlyingLtp: number | null }
export function parseMovers(j: any): MoverRow[] {
  const n = (v: any) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return (j?.data || []).map((x: any) => ({
    name: String(x?.displayName || x?.tradingSymbol || ""), symbol: String(x?.tradingSymbol || ""), instrument: String(x?.instrument || ""),
    expiry: x?.expiry || null, strike: n(x?.strikePrice), ltp: n(x?.ltp), changePct: n(x?.changePercent), volume: n(x?.volume),
    oi: n(x?.openInterest), oiChgPct: n(x?.openInterestChangePercent), pcr: n(x?.putCallRatio), underlyingLtp: n(x?.underlyingLtp),
  }));
}
export interface MoversReq { exchangeSegment: "NSE_FNO" | "NSE_EQ"; instrument: string[]; category: "HIGHEST_OI" | "OI_GAINERS" | "OI_LOSERS" | "TOP_VOLUME" | "PRICE_GAINERS" | "PRICE_LOSERS"; expiry?: string; universe?: string; limit: number }
export async function dhanMovers(req: MoversReq) {
  const r = await cached(`movers|${JSON.stringify(req)}`, TTL.movers, () => post("/data/marketmovers", req as any));
  return { rows: parseMovers(r.data), at: r.at, stale: r.stale };
}

// ---- company info ----
export async function dhanCompanyInfo(securityId: string, metrics: ("CO" | "RATIOS" | "SHP")[] = ["CO", "RATIOS", "SHP"]) {
  const r = await cached(`co|${securityId}|${metrics.join(",")}`, TTL.company, () => post("/data/companyinfo", { securityId, exchangeSegment: "NSE_EQ", instrument: "EQUITY", metrics }));
  return { data: r.data?.data || {}, at: r.at, stale: r.stale };
}
