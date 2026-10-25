// ============================ GOLD DESK — data feed, ISOLATED from the Indian market screens ============================
// Isolation rules (owner, 2026-10-25: "gold connectivity must not affect the Indian market screens"):
//  1. Every Dhan call here runs at LOW priority (dhanClient default), so a NIFTY / SENSEX screen's HIGH-priority call is
//     always dispatched first in the shared Dhan rate-limit queue.
//  2. Gold has its own throttle on top: one gold Dhan call at a time, at least GOLD_GAP_MS apart.
//  3. Only /charts/intraday (data API, 5 req/s) is used — never the 1-req/s quote API or the option-chain API that the
//     Indian screens depend on. The live price is the last 5-min bar's close.
//  4. Circuit breaker: 3 failures in a row → gold stops calling Dhan for 2 minutes and serves its last data, marked stale.
//  5. Own cache (keys never shared with the Indian screens), no background warm-up: data is fetched only while the Gold
//     screen asks for it. GOLD_DESK=off (env) or the Data Control switch "goldcommand" turns it off completely.
import YahooFinance from "yahoo-finance2";
import { dhanFetch } from "../data/dhanClient";
import { loadDhanConfig } from "../data/dhanConfig";
import type { Bar } from "./goldEngine";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
export const goldEnabled = () => process.env.GOLD_DESK !== "off";
const GOLD_GAP_MS = Math.max(200, Number(process.env.GOLD_GAP_MS) || 400);

// ---- throttle + circuit breaker -----------------------------------------------------------------------------------------
let _chain: Promise<unknown> = Promise.resolve(), _lastAt = 0, _fails = 0, _openUntil = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function goldBreaker() { return { open: Date.now() < _openUntil, until: _openUntil, fails: _fails }; }
/** Run one gold Dhan call: serialized, spaced, and refused while the breaker is open. */
function goldCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = _chain.then(async () => {
    if (Date.now() < _openUntil) throw new Error("gold feed paused after repeated errors (circuit breaker)");
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
export function _resetGoldFeed() { _chain = Promise.resolve(); _lastAt = 0; _fails = 0; _openUntil = 0; _cache.clear(); }
export function _setGoldTransport(f: typeof dhanFetch | null, c: typeof loadDhanConfig | null) { _fetch = f || dhanFetch; _cfg = c || loadDhanConfig; }

// ---- cache (gold-only keys) with last-good fallback --------------------------------------------------------------------
const _cache = new Map<string, { at: number; v: any }>();
async function cachedGold<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<{ v: T; stale: boolean; at: number }> {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return { v: hit.v, stale: false, at: hit.at };
  try { const v = await fn(); _cache.set(key, { at: Date.now(), v }); return { v, stale: false, at: Date.now() }; }
  catch (e) { if (hit) return { v: hit.v, stale: true, at: hit.at }; throw e; }
}

const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
const istToday = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);

/** MCX 5 / 15 / 60-min bars (with OI) for one gold contract over the last `days` calendar days — all session hours. */
export async function goldBars(securityId: string, instrument: "FUTCOM" | "OPTFUT", tf: 5 | 15 | 60, days = 7, ttlMs = 20_000) {
  return cachedGold(`gold:bars:${securityId}:${tf}:${days}`, ttlMs, () => goldCall(async () => {
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

/** COMEX gold (USD/oz) and USD/INR from Yahoo (the app's existing global-markets source); MCX parity = COMEX × USDINR ÷ 31.1035 × 10. */
export async function comexGold() {
  return cachedGold("gold:comex", 60_000, async () => {
    const q: any[] = await yf.quote(["GC=F", "INR=X"], { return: "array" } as any);
    const gc = q.find((x) => x.symbol === "GC=F"), fx = q.find((x) => x.symbol === "INR=X");
    const price = Number(gc?.regularMarketPrice) || null, usdinr = Number(fx?.regularMarketPrice) || null;
    return { price, changePct: gc?.regularMarketChangePercent != null ? Math.round(gc.regularMarketChangePercent * 100) / 100 : null, usdinr,
      parity10g: price && usdinr ? Math.round((price * usdinr / 31.1035) * 10) : null, at: gc?.regularMarketTime ? Math.floor(+new Date(gc.regularMarketTime) / 1000) : null };
  });
}
