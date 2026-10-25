// ============================ MCX DESKS (Gold, Crude Oil) — data feed, ISOLATED from the Indian market screens ============================
// Isolation rules (owner, 2026-10-25: "gold connectivity must not affect the Indian market screens"; the Crude Oil Desk
// follows the same rules and SHARES this one throttle, so both desks together still make one MCX Dhan call at a time):
//  1. Every Dhan call here runs at LOW priority (dhanClient default), so a NIFTY / SENSEX screen's HIGH-priority call is
//     always dispatched first in the shared Dhan rate-limit queue.
//  2. The MCX desks have their own throttle on top: one MCX Dhan call at a time, at least GOLD_GAP_MS apart.
//  3. Only /charts/intraday (data API, 5 req/s) is used — never the 1-req/s quote API or the option-chain API that the
//     Indian screens depend on. The live price is the last 5-min bar's close.
//  4. Circuit breaker: 3 failures in a row → the MCX desks stop calling Dhan for 2 minutes and serve their last data, stale.
//  5. Own cache (keys never shared with the Indian screens), no background warm-up: data is fetched only while a desk screen
//     asks for it. GOLD_DESK=off / CRUDE_DESK=off (env) or the Data Control switches "goldcommand" / "crudecommand" turn a
//     desk off completely.
import YahooFinance from "yahoo-finance2";
import { dhanFetch } from "../data/dhanClient";
import { loadDhanConfig } from "../data/dhanConfig";
import type { Bar } from "./mcxEngine";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
import type { McxFamily } from "./mcxEngine";
export const deskEnabled = (family: McxFamily) => process.env[family === "GOLD" ? "GOLD_DESK" : "CRUDE_DESK"] !== "off";
const GOLD_GAP_MS = Math.max(200, Number(process.env.GOLD_GAP_MS) || 400);

// ---- throttle + circuit breaker -----------------------------------------------------------------------------------------
let _chain: Promise<unknown> = Promise.resolve(), _lastAt = 0, _fails = 0, _openUntil = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function mcxBreaker() { return { open: Date.now() < _openUntil, until: _openUntil, fails: _fails }; }
/** Run one MCX desk Dhan call: serialized, spaced, and refused while the breaker is open. */
function mcxCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = _chain.then(async () => {
    if (Date.now() < _openUntil) throw new Error("MCX feed paused after repeated errors (circuit breaker)");
    const wait = _lastAt + GOLD_GAP_MS - Date.now(); if (wait > 0) await sleep(wait);
    _lastAt = Date.now();
    try { const v = await fn(); _fails = 0; return v; }
    catch (e) { if (++_fails >= 3) { _openUntil = Date.now() + 120_000; _fails = 0; } throw e; }
  });
  _chain = run.catch(() => undefined);
  return run;
}
// the Dhan transport (replaceable in tests only)
let _fetch: typeof dhanFetch = dhanFetch, _cfg: typeof loadDhanConfig = loadDhanConfig;
/** Test hooks: reset throttle / breaker / cache state; swap the Dhan transport. */
export function _resetMcxFeed() { _chain = Promise.resolve(); _lastAt = 0; _fails = 0; _openUntil = 0; _cache.clear(); }
export function _setMcxTransport(f: typeof dhanFetch | null, c: typeof loadDhanConfig | null) { _fetch = f || dhanFetch; _cfg = c || loadDhanConfig; }

// ---- cache (MCX-desk-only keys) with last-good fallback --------------------------------------------------------------------
const _cache = new Map<string, { at: number; v: any }>();
async function cachedMcx<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<{ v: T; stale: boolean; at: number }> {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return { v: hit.v, stale: false, at: hit.at };
  try { const v = await fn(); _cache.set(key, { at: Date.now(), v }); return { v, stale: false, at: Date.now() }; }
  catch (e) { if (hit) return { v: hit.v, stale: true, at: hit.at }; throw e; }
}

const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
const istToday = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);

/** MCX 5 / 15 / 60-min bars (with OI) for one desk contract over the last `days` calendar days — all session hours. */
export async function mcxBars(securityId: string, instrument: "FUTCOM" | "OPTFUT", tf: 5 | 15 | 60, days = 7, ttlMs = 20_000) {
  return cachedMcx(`mcx:bars:${securityId}:${tf}:${days}`, ttlMs, () => mcxCall(async () => {
    const cfg = _cfg(); if (!cfg.accessToken) throw new Error("Dhan not connected");
    const r = await _fetch("/charts/intraday", { method: "POST", accessToken: cfg.accessToken, clientId: cfg.clientId,
      body: { securityId, exchangeSegment: "MCX_COMM", instrument, interval: String(tf), oi: true, fromDate: addDays(istToday(), -days), toDate: addDays(istToday(), 1) } });
    if (!r.ok) throw new Error(`Dhan MCX ${r.status}`);
    const j: any = await r.json(), ts: number[] = j?.timestamp || [];
    const bars: Bar[] = ts.map((t, i) => ({ time: t, open: +j.open[i], high: +j.high[i], low: +j.low[i], close: +j.close[i], volume: +(j.volume?.[i] ?? 0), oi: j.open_interest?.[i] != null ? +j.open_interest[i] : null }))
      .filter((b) => b.close > 0);
    return bars;
  }));
}

/** The global reference for a desk, from Yahoo (the app's existing global-markets source):
 *  GOLD  — COMEX gold (USD/oz) and USD/INR; MCX parity = COMEX × USDINR ÷ 31.1035 × 10 (₹ per 10 g, before duty / GST).
 *  CRUDE — NYMEX WTI and ICE Brent (USD/bbl) and USD/INR; MCX parity = WTI × USDINR (₹ per barrel; MCX crude tracks WTI). */
let _lastFx: { v: number; at: number } | null = null;
export async function refQuote(family: McxFamily) {
  return cachedMcx(`mcx:ref:${family}`, 60_000, async () => {
    const syms = family === "GOLD" ? ["GC=F", "INR=X"] : ["CL=F", "BZ=F", "INR=X"];
    const q: any[] = await yf.quote(syms, { return: "array" } as any), by = (s: string) => q.find((x) => x.symbol === s);
    const main = by(family === "GOLD" ? "GC=F" : "CL=F"), fx = by("INR=X"), brent = family === "CRUDE" ? by("BZ=F") : null;
    // Yahoo occasionally leaves a symbol out of a batch: keep the last USD/INR seen (either desk) rather than a blank card
    const price = Number(main?.regularMarketPrice) || null, fxNow = Number(fx?.regularMarketPrice) || null;
    if (fxNow) _lastFx = { v: fxNow, at: Date.now() };
    const usdinr = fxNow ?? (_lastFx && Date.now() - _lastFx.at < 6 * 3600_000 ? _lastFx.v : null);
    const parity = price && usdinr ? (family === "GOLD" ? Math.round((price * usdinr / 31.1035) * 10) : Math.round(price * usdinr)) : null;
    const pct = (x: any) => (x?.regularMarketChangePercent != null ? Math.round(x.regularMarketChangePercent * 100) / 100 : null);
    return { family, name: family === "GOLD" ? "COMEX GOLD" : "NYMEX WTI CRUDE", unit: family === "GOLD" ? "per ounce · USD" : "per barrel · USD",
      price, changePct: pct(main), usdinr, parity, parityUnit: family === "GOLD" ? "₹/10 g" : "₹/bbl",
      brent: brent ? { price: Number(brent.regularMarketPrice) || null, changePct: pct(brent) } : null,
      at: main?.regularMarketTime ? Math.floor(+new Date(main.regularMarketTime) / 1000) : null };
  });
}
