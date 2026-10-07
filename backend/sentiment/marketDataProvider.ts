import type { Quote, Freshness } from "./types";

// ============================ External market-data provider (macro / global / FX) ============================
// Dhan is an Indian broker and cannot quote GIFT NIFTY, USD/INR, DXY, US 10Y,
// Brent/WTI, gold, the CBOE VIX or global equity indices. Those come from a
// PLUGGABLE external provider chosen by env:
//
//   MARKET_DATA_PROVIDER   ("twelvedata" | "yahoo"; default: twelvedata when a key
//                          is set, otherwise the keyless Yahoo provider)
//   MARKET_DATA_API_KEY    (Twelve Data key — with provider=twelvedata and no key
//                          every value is DATA UNAVAILABLE)
//
// Yahoo (yahoo-finance2, already a dependency) needs no key. Like the rest of
// this desk it is MARKET CONTEXT ONLY — it never feeds a trading decision.
//
// The key is read ONLY from the server environment. It is never hard-coded, never
// sent to the browser, never logged, and never placed in an error/reason string.
// Nothing here is fabricated or estimated: a missing key, provider error, 429,
// timeout, malformed response, or unsupported symbol all yield a null value with
// an explicit status/reason. Requests are centralized, cached, de-duplicated and
// batched to respect the free-tier rate limit.

export type MdKey =
  | "GIFTNIFTY" | "USDINR" | "DXY" | "US10Y" | "BRENT" | "WTI" | "GOLD" | "CBOEVIX"
  | "SPX" | "NASDAQ" | "DOW" | "USFUT"
  | "NIKKEI" | "HANGSENG" | "SHANGHAI" | "KOSPI" | "TAIWAN"
  | "FTSE" | "DAX" | "CAC";

interface MdSpec { label: string; kind: "index" | "fx" | "commodity" | "macro"; twelvedata?: string; yahoo?: string; }

// Display label + Twelve Data symbol per instrument. A blank `twelvedata` means
// "not mappable on this vendor" ⇒ UNAVAILABLE (we NEVER substitute a proxy — e.g.
// GIFT NIFTY / US 10Y / US Futures are left unavailable unless the vendor has a
// real symbol for them).
export const MD_SPECS: Record<MdKey, MdSpec> = {
  GIFTNIFTY: { label: "GIFT NIFTY", kind: "index", twelvedata: "", yahoo: "" },
  USDINR:    { label: "USDINR",     kind: "fx", twelvedata: "USD/INR", yahoo: "INR=X" },
  DXY:       { label: "DXY",        kind: "fx", twelvedata: "DXY", yahoo: "DX-Y.NYB" },
  US10Y:     { label: "US 10Y",     kind: "macro", twelvedata: "", yahoo: "^TNX" },
  BRENT:     { label: "Brent Crude",kind: "commodity", twelvedata: "BRENT", yahoo: "BZ=F" },
  WTI:       { label: "Crude (WTI)",kind: "commodity", twelvedata: "WTI/USD", yahoo: "CL=F" },
  GOLD:      { label: "Gold",       kind: "commodity", twelvedata: "XAU/USD", yahoo: "GC=F" },
  CBOEVIX:   { label: "VIX (CBOE)", kind: "index", twelvedata: "VIX", yahoo: "^VIX" },
  SPX:       { label: "S&P 500",    kind: "index", twelvedata: "GSPC", yahoo: "^GSPC" },
  NASDAQ:    { label: "NASDAQ",     kind: "index", twelvedata: "IXIC", yahoo: "^IXIC" },
  DOW:       { label: "Dow Jones",  kind: "index", twelvedata: "DJI", yahoo: "^DJI" },
  USFUT:     { label: "US Futures", kind: "index", twelvedata: "", yahoo: "ES=F" },
  NIKKEI:    { label: "Nikkei",     kind: "index", twelvedata: "N225", yahoo: "^N225" },
  HANGSENG:  { label: "Hang Seng",  kind: "index", twelvedata: "HSI", yahoo: "^HSI" },
  SHANGHAI:  { label: "Shanghai",   kind: "index", twelvedata: "000001.SS", yahoo: "000001.SS" },
  KOSPI:     { label: "Kospi",      kind: "index", twelvedata: "KS11", yahoo: "^KS11" },
  TAIWAN:    { label: "Taiwan",     kind: "index", twelvedata: "TWII", yahoo: "^TWII" },
  FTSE:      { label: "FTSE",       kind: "index", twelvedata: "FTSE", yahoo: "^FTSE" },
  DAX:       { label: "DAX",        kind: "index", twelvedata: "GDAXI", yahoo: "^GDAXI" },
  CAC:       { label: "CAC",        kind: "index", twelvedata: "FCHI", yahoo: "^FCHI" },
};

const hasKey = (): boolean => !!(process.env.MARKET_DATA_API_KEY && process.env.MARKET_DATA_API_KEY.trim());
export function marketDataProviderName(): string { return process.env.MARKET_DATA_PROVIDER || (hasKey() ? "twelvedata" : "yahoo"); }
export function marketDataConfigured(): boolean { return marketDataProviderName() === "yahoo" || hasKey(); }

// ---- Provider interface (UI/sentiment engine depend on THIS, not on the vendor) ----
export interface MarketDataProvider {
  name: string;
  getQuote(keys: MdKey[]): Promise<Record<string, Quote>>;
  getFX(keys: MdKey[]): Promise<Record<string, Quote>>;
  getCommodity(keys: MdKey[]): Promise<Record<string, Quote>>;
  getIndex(keys: MdKey[]): Promise<Record<string, Quote>>;
  getMacro(keys: MdKey[]): Promise<Record<string, Quote>>;
  healthCheck(): Promise<ProviderHealth>;
}

export interface ProviderHealth {
  provider: string;
  configured: boolean;
  status: "LIVE" | "ERROR" | "NOT_CONFIGURED";
  lastSuccessAt: number | null;   // epoch sec
  lastError: string | null;       // key-free reason
}

// ---- Injectable fetch (tests stub this) + state resets ----
type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
let _fetch: FetchLike = ((...a: any[]) => (globalThis as any).fetch(...a)) as FetchLike;
export function _setFetchForTests(f: FetchLike | null): void { _fetch = f ?? (((...a: any[]) => (globalThis as any).fetch(...a)) as FetchLike); }

interface Health { lastSuccessAt: number | null; lastError: string | null; disconnected: boolean; }
const health: Health = { lastSuccessAt: null, lastError: null, disconnected: false };
const lastGood: Partial<Record<MdKey, Quote>> = {};
let cache: { at: number; data: Partial<Record<MdKey, Quote>> } = { at: 0, data: {} };
let inflight: Promise<Partial<Record<MdKey, Quote>>> | null = null;
const reqLog: { at: number; n: number; ok: boolean; ms: number; status: number }[] = [];
const CACHE_MS = 60_000;

export function _resetMarketDataForTests(): void {
  health.lastSuccessAt = null; health.lastError = null; health.disconnected = false;
  for (const k of Object.keys(lastGood)) delete (lastGood as any)[k];
  cache = { at: 0, data: {} }; inflight = null; reqLog.length = 0;
}

const unavailable = (k: MdKey, reason: string, freshness: Freshness = "UNAVAILABLE"): Quote => ({
  key: k, label: MD_SPECS[k].label, value: null, change: null, changePct: null,
  ts: null, receivedTs: null, ageSec: null, freshness, source: marketDataProviderName(), reason,
});

/** The batched, cached, de-duplicated entry point used by the sentiment engine. */
export async function fetchMarketData(keys: MdKey[]): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  if (!marketDataConfigured()) {
    for (const k of keys) out[k] = unavailable(k, "API key not configured");
    return out;
  }
  // Serve from the warm cache when possible.
  if (Date.now() - cache.at < CACHE_MS && keys.every((k) => cache.data[k])) {
    for (const k of keys) out[k] = cache.data[k]!;
    return out;
  }
  // De-duplicate concurrent refreshes into ONE provider round-trip.
  if (!inflight) {
    const provider = getMarketDataProvider();
    inflight = provider.getQuote(allKeys()).finally(() => { inflight = null; });
  }
  let fetched: Partial<Record<MdKey, Quote>> = {};
  try { fetched = await inflight; } catch { fetched = {}; }
  cache = { at: Date.now(), data: { ...cache.data, ...fetched } };
  for (const k of keys) out[k] = cache.data[k] ?? unavailable(k, "no data");
  return out;
}

function allKeys(): MdKey[] { return Object.keys(MD_SPECS) as MdKey[]; }

// ---- Concrete provider: Twelve Data ----
export class TwelveDataProvider implements MarketDataProvider {
  name = "twelvedata";
  getFX(k: MdKey[]) { return this.getQuote(k); }
  getCommodity(k: MdKey[]) { return this.getQuote(k); }
  getIndex(k: MdKey[]) { return this.getQuote(k); }
  getMacro(k: MdKey[]) { return this.getQuote(k); }

  async healthCheck(): Promise<ProviderHealth> {
    if (!marketDataConfigured()) return { provider: this.name, configured: false, status: "NOT_CONFIGURED", lastSuccessAt: null, lastError: null };
    try {
      await this.getQuote(["GOLD"]);
      const ok = !health.disconnected;
      return { provider: this.name, configured: true, status: ok ? "LIVE" : "ERROR", lastSuccessAt: health.lastSuccessAt, lastError: health.lastError };
    } catch {
      return { provider: this.name, configured: true, status: "ERROR", lastSuccessAt: health.lastSuccessAt, lastError: health.lastError };
    }
  }

  async getQuote(keys: MdKey[]): Promise<Record<string, Quote>> {
    const out: Record<string, Quote> = {};
    const mappable = keys.filter((k) => MD_SPECS[k].twelvedata);
    for (const k of keys) if (!MD_SPECS[k].twelvedata) out[k] = unavailable(k, "symbol not supported by provider");
    if (!mappable.length) return out;

    const apikey = (process.env.MARKET_DATA_API_KEY || "").trim();
    const symbols = mappable.map((k) => MD_SPECS[k].twelvedata!).join(",");
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols)}&apikey=${encodeURIComponent(apikey)}`;
    const t0 = Date.now();
    let status = 0; let json: any = null; let errored = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await _fetch(url, { signal: (ctrl as any).signal });
      status = res.status;
      if (res.status === 429) throw new Error("rate limited (429)");
      if (!res.ok) throw new Error(`http ${res.status}`);
      json = await res.json();
      // A top-level {status:"error"} means auth/plan/symbol error for the whole call.
      if (json && json.status === "error") throw new Error(sanitize(json.message || "provider error"));
      health.lastSuccessAt = Math.floor(Date.now() / 1000); health.lastError = null; health.disconnected = false;
    } catch (e: any) {
      errored = true; health.disconnected = true; health.lastError = sanitize(e?.message || "request failed");
    } finally {
      clearTimeout(timer);
      reqLog.push({ at: Math.floor(Date.now() / 1000), n: mappable.length, ok: !errored, ms: Date.now() - t0, status });
      if (reqLog.length > 50) reqLog.shift();
    }

    const receivedTs = Math.floor(Date.now() / 1000);
    for (const k of mappable) {
      if (errored) {
        // Preserve last-good value as STALE; otherwise report DISCONNECTED. Never fabricate.
        const lg = lastGood[k];
        out[k] = lg ? { ...lg, freshness: "STALE", receivedTs, ageSec: lg.ts != null ? receivedTs - lg.ts : null, reason: "provider unavailable (showing last good)" }
                    : unavailable(k, health.lastError || "provider unavailable", "DISCONNECTED");
        continue;
      }
      const sym = MD_SPECS[k].twelvedata!;
      const row = (mappable.length === 1 ? json : json?.[sym]) as any;
      if (!row || row.status === "error" || row.code) { out[k] = unavailable(k, "symbol not returned by provider"); continue; }
      const value = num(row.close);
      if (value == null) { out[k] = unavailable(k, "no price in response"); continue; }
      const tsSec = row.timestamp ? Number(row.timestamp) : null; // PROVIDER timestamp
      const ageSec = tsSec != null ? receivedTs - tsSec : null;
      const isOpen = row.is_market_open === true;
      let freshness: Freshness = "DELAYED";
      if (!isOpen) freshness = "CLOSED";
      else if (ageSec != null && ageSec < 120) freshness = "LIVE";
      else if (ageSec != null && ageSec < 15 * 60) freshness = "DELAYED";
      else freshness = "STALE";
      const qte: Quote = { key: k, label: MD_SPECS[k].label, value, change: num(row.change), changePct: num(row.percent_change), ts: tsSec, receivedTs, ageSec, freshness, source: this.name, reason: null };
      out[k] = qte; lastGood[k] = qte;
    }
    return out;
  }
}

// ---- Concrete provider: Yahoo (keyless) ----
// One batched yf.quote() per refresh (the 60s cache above de-duplicates). Yahoo
// marks quotes as delayed; marketState tells us whether the venue is trading.
type YahooQuoteFn = (symbols: string[]) => Promise<any[]>;
let _yfQuote: YahooQuoteFn | null = null;
export function _setYahooQuoteForTests(f: YahooQuoteFn | null): void { _yfQuote = f; }
async function yahooQuote(symbols: string[]): Promise<any[]> {
  if (_yfQuote) return _yfQuote(symbols);
  const { default: YahooFinance } = await import("yahoo-finance2");
  const yf = new (YahooFinance as any)({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
  const r = await yf.quote(symbols, { return: "array" });
  return Array.isArray(r) ? r : [r];
}

export class YahooProvider implements MarketDataProvider {
  name = "yahoo";
  getFX(k: MdKey[]) { return this.getQuote(k); }
  getCommodity(k: MdKey[]) { return this.getQuote(k); }
  getIndex(k: MdKey[]) { return this.getQuote(k); }
  getMacro(k: MdKey[]) { return this.getQuote(k); }

  async healthCheck(): Promise<ProviderHealth> {
    if (health.lastSuccessAt == null && !health.lastError) await this.getQuote(["GOLD"]).catch(() => null);
    const ok = !health.disconnected && health.lastSuccessAt != null;
    return { provider: this.name, configured: true, status: ok ? "LIVE" : "ERROR", lastSuccessAt: health.lastSuccessAt, lastError: health.lastError };
  }

  async getQuote(keys: MdKey[]): Promise<Record<string, Quote>> {
    const out: Record<string, Quote> = {};
    const mappable = keys.filter((k) => MD_SPECS[k].yahoo);
    for (const k of keys) if (!MD_SPECS[k].yahoo) out[k] = unavailable(k, "symbol not supported by provider");
    if (!mappable.length) return out;

    const t0 = Date.now();
    let rows: any[] = []; let errored = false;
    try {
      rows = await Promise.race([
        yahooQuote(mappable.map((k) => MD_SPECS[k].yahoo!)),
        new Promise<any[]>((_, rej) => setTimeout(() => rej(new Error("timeout")), 10_000).unref?.()),
      ]);
      health.lastSuccessAt = Math.floor(Date.now() / 1000); health.lastError = null; health.disconnected = false;
    } catch (e: any) {
      errored = true; health.disconnected = true; health.lastError = sanitize(e?.message || "request failed");
    } finally {
      reqLog.push({ at: Math.floor(Date.now() / 1000), n: mappable.length, ok: !errored, ms: Date.now() - t0, status: errored ? 0 : 200 });
      if (reqLog.length > 50) reqLog.shift();
    }

    const receivedTs = Math.floor(Date.now() / 1000);
    const bySym = new Map<string, any>();
    for (const r of rows || []) if (r && r.symbol) bySym.set(String(r.symbol), r);
    for (const k of mappable) {
      if (errored) {
        const lg = lastGood[k];
        out[k] = lg ? { ...lg, freshness: "STALE", receivedTs, ageSec: lg.ts != null ? receivedTs - lg.ts : null, reason: "provider unavailable (showing last good)" }
                    : unavailable(k, health.lastError || "provider unavailable", "DISCONNECTED");
        continue;
      }
      const row = bySym.get(MD_SPECS[k].yahoo!);
      if (!row) { out[k] = unavailable(k, "symbol not returned by provider"); continue; }
      const value = num(row.regularMarketPrice);
      if (value == null) { out[k] = unavailable(k, "no price in response"); continue; }
      const t = row.regularMarketTime;
      const tsSec = t instanceof Date ? Math.floor(t.getTime() / 1000) : (num(t) ?? null);
      const ageSec = tsSec != null ? receivedTs - tsSec : null;
      const state = String(row.marketState || "");
      let freshness: Freshness;
      if (state && state !== "REGULAR") freshness = "CLOSED";       // PRE/POST/CLOSED: last session's close
      else if (ageSec != null && ageSec < 30 * 60) freshness = "DELAYED"; // Yahoo quotes are not real-time
      else freshness = "STALE";
      const qte: Quote = { key: k, label: MD_SPECS[k].label, value, change: num(row.regularMarketChange), changePct: num(row.regularMarketChangePercent),
        ts: tsSec, receivedTs, ageSec, freshness, source: this.name, reason: freshness === "CLOSED" ? `market ${state.toLowerCase()} — last session` : null };
      out[k] = qte; lastGood[k] = qte;
    }
    return out;
  }
}

let _provider: MarketDataProvider | null = null;
export function getMarketDataProvider(): MarketDataProvider {
  const name = marketDataProviderName();
  if (_provider && _provider.name === name) return _provider;
  // Adding a vendor = add a class + a case here.
  _provider = name === "yahoo" ? new YahooProvider() : new TwelveDataProvider();
  return _provider;
}

/** Health for the UI status pill + startup diagnostic (no key, ever). */
export async function getMarketDataHealth(): Promise<ProviderHealth & { lastRequests: typeof reqLog }> {
  const h = await getMarketDataProvider().healthCheck();
  return { ...h, lastRequests: reqLog.slice(-5) };
}

/** Startup diagnostic (logged once at boot). Never prints the key. */
export function logMarketDataStartup(): void {
  const configured = marketDataConfigured();
  /* eslint-disable no-console */
  console.log("External Market Data");
  console.log(`  Provider: ${marketDataProviderName()}`);
  console.log(`  API Key: ${marketDataProviderName() === "yahoo" ? "not needed (keyless)" : configured ? "CONFIGURED" : "NOT CONFIGURED"}`);
  console.log(`  Status: ${configured ? "ready (health verified on first request)" : "DATA UNAVAILABLE until MARKET_DATA_API_KEY is set"}`);
}

function num(v: any): number | null { const n = Number(v); return Number.isFinite(n) ? n : null; }
// Strip anything that could resemble the API key from a message before it is stored/shown.
function sanitize(msg: string): string {
  const key = (process.env.MARKET_DATA_API_KEY || "").trim();
  let s = String(msg || "");
  if (key && key.length >= 6) s = s.split(key).join("***");
  return s.replace(/apikey=[^&\s]+/gi, "apikey=***").slice(0, 200);
}
