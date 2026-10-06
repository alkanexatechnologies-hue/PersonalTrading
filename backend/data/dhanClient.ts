// ---- Dhan API safety gate (MARKET-DATA ONLY — no order placement) ----
// Dhan is the SINGLE market-data source for live quotes, candles, OI, and
// option chains. This app never places, modifies, or cancels a real order
// through Dhan. This file is the ONE place every Dhan HTTP call goes through,
// so an accidental order-API call fails immediately and loudly.
//
// Two independent layers, both must pass:
//  1. DHAN_BACKTEST_MODE - an explicit, documented safety flag (default true).
//  2. ALLOWED_PATHS - a hard allowlist of read-only market-data/account-read
//     endpoints. This is the REAL protection: even with DHAN_BACKTEST_MODE
//     left at its default, any path not on this list (orders, super-order,
//     forever-order, edit, cancel, ...) is refused unconditionally, before
//     any network call is made.

export const DHAN_BACKTEST_MODE = process.env.DHAN_BACKTEST_MODE !== "false";

import { AsyncLocalStorage } from "node:async_hooks";
import { AUDIT_ENABLED, recordCall, dhanBodyMeta } from "../audit/auditMode";

const BASE = "https://api.dhan.co/v2";

const ALLOWED_PATHS = new Set<string>([
  "/charts/historical", // daily OHLC(+OI)
  "/charts/intraday",   // intraday OHLC(+OI)
  "/charts/rollingoption", // historical (incl. expired) option OHLC+IV+OI per ATM offset — read-only
  "/fundlimit",         // account read-only, used only to verify a token works
  "/marketfeed/ltp",    // live LTP for quotes
  "/marketfeed/ohlc",   // live OHLC for quotes
  "/marketfeed/quote",  // full market quote (OI, volume, OHLC)
  "/optionchain",           // option chain (strikes, OI, greeks) — Dhan v2 POST
  "/optionchain/expirylist", // expiry dates for an underlying — Dhan v2 POST
]);

export interface DhanFetchOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  accessToken: string;
  clientId?: string;
}

// ---- Dhan RATE-LIMIT gate (global, category-aware) --------------------------
// Dhan enforces hard per-second caps PER CATEGORY (DhanHQ v2 docs):
//   Quote APIs (/marketfeed/*)              → 1  req/sec
//   Data APIs  (/charts/*, /optionchain*)   → 5  req/sec
//   Non-Trading(/fundlimit)                 → 20 req/sec
// Breaching any of these returns HTTP 429 / DH-904, which previously starved the
// Option Terminal's OI chain (served stale/last-good → "inconsistent data").
// Because every Dhan call funnels through dhanFetch, pacing HERE throttles the
// whole app at once, no matter how many endpoints fan out concurrently.
type DhanCat = "quote" | "data" | "nontrading";
// Min gap between DISPATCHES per category. Slightly below the documented ceiling
// (gap = 1000/limit, padded) so bursts can't trip the limiter. Overridable via env.
const _envGap = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
// Gaps are set BELOW the documented ceilings with deliberate headroom: tight
// pacing (right at the limit) paradoxically triggers more 429s, each of which
// retries and adds further load — a self-sustaining storm. Backing off to a
// comfortable fraction of the cap lets Dhan's rolling window reset between calls.
const MIN_GAP_MS: Record<DhanCat, number> = {
  quote: _envGap("DHAN_QUOTE_GAP_MS", 1100),   // 1/sec cap → ~0.9/sec
  data: _envGap("DHAN_DATA_GAP_MS", 250),      // 5/sec cap → ~4/sec
  nontrading: _envGap("DHAN_NONTRADING_GAP_MS", 80), // 20/sec cap → ~12/sec
};
// Global in-flight cap: a secondary guard so slow responses can't cluster the
// actual network sends past the per-second budget the pacing above assumes.
const DHAN_MAX_CONCURRENT = _envGap("DHAN_MAX_CONCURRENT", 6);
// Retry policy for transient throttles (DH-904 / 429 — explicitly "safe to retry").
const DHAN_MAX_RETRIES = _envGap("DHAN_MAX_RETRIES", 4);
const DHAN_BACKOFF_BASE_MS = _envGap("DHAN_BACKOFF_BASE_MS", 700);
const DHAN_BACKOFF_CAP_MS = _envGap("DHAN_BACKOFF_CAP_MS", 10000);

const _dhanSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function dhanCategory(basePath: string): DhanCat {
  if (basePath.startsWith("/marketfeed")) return "quote";
  if (basePath.startsWith("/charts") || basePath.startsWith("/optionchain")) return "data";
  return "nontrading";
}

// ---- Request PRIORITY --------------------------------------------------------
// Foreground screens the trader is actively watching (Option Terminal, Market
// Command) must not sit behind a 60s background scan that enqueued dozens of
// calls. A request runs inside a priority context; the scheduler below dispatches
// HIGH-priority waiters before LOW ones within each category. Default is "low"
// so only explicitly-marked foreground work preempts.
export type DhanPriority = "high" | "low";
const _priorityStore = new AsyncLocalStorage<DhanPriority>();
export function withDhanPriority<T>(priority: DhanPriority, fn: () => Promise<T>): Promise<T> {
  return _priorityStore.run(priority, fn);
}
function currentDhanPriority(): DhanPriority {
  return _priorityStore.getStore() ?? "low";
}

// Per-category PRIORITY scheduler. A single runner per category dispatches one
// queued waiter every MIN_GAP_MS, always picking the highest-priority waiter
// (FIFO within the same priority). Only dispatch STARTS are spaced/ordered — the
// network request itself still overlaps, so Data calls keep their allowed burst.
type DhanWaiter = { priority: number; seq: number; resolve: () => void };
const _dhanQueue: Record<DhanCat, DhanWaiter[]> = { quote: [], data: [], nontrading: [] };
const _dhanRunning: Record<DhanCat, boolean> = { quote: false, data: false, nontrading: false };
const _dhanLastDispatch: Record<DhanCat, number> = { quote: 0, data: 0, nontrading: 0 };
let _dhanSeq = 0;

async function _runDhanQueue(cat: DhanCat): Promise<void> {
  if (_dhanRunning[cat]) return;
  _dhanRunning[cat] = true;
  try {
    while (_dhanQueue[cat].length) {
      const wait = Math.max(0, _dhanLastDispatch[cat] + MIN_GAP_MS[cat] - Date.now());
      if (wait > 0) await _dhanSleep(wait);
      // Pick highest priority (lower number first), breaking ties by arrival order.
      let best = 0;
      for (let i = 1; i < _dhanQueue[cat].length; i++) {
        const a = _dhanQueue[cat][i], b = _dhanQueue[cat][best];
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
      }
      const [w] = _dhanQueue[cat].splice(best, 1);
      _dhanLastDispatch[cat] = Date.now();
      w.resolve(); // let this caller proceed to the actual fetch
    }
  } finally {
    _dhanRunning[cat] = false;
  }
}

function acquireDhanSlot(cat: DhanCat): Promise<void> {
  const priority = currentDhanPriority() === "high" ? 0 : 1;
  return new Promise<void>((resolve) => {
    _dhanQueue[cat].push({ priority, seq: _dhanSeq++, resolve });
    void _runDhanQueue(cat);
  });
}

let _dhanActive = 0;
async function awaitConcurrency(): Promise<void> {
  const start = Date.now();
  while (_dhanActive >= DHAN_MAX_CONCURRENT) {
    if (Date.now() - start > 15_000) break; // never hang forever
    await _dhanSleep(25);
  }
  _dhanActive++;
}

export async function dhanFetch(path: string, opts: DhanFetchOptions): Promise<Response> {
  if (!DHAN_BACKTEST_MODE) {
    throw new Error("Dhan integration disabled (DHAN_BACKTEST_MODE=false) — set it back to true (or unset it) to use historical data.");
  }
  const basePath = path.split("?")[0];
  if (!ALLOWED_PATHS.has(basePath)) {
    throw new Error(
      `BLOCKED: "${basePath}" is not on the Dhan read-only allowlist (market-data only — no order-placement APIs are ever called from this app). Refusing to call it.`
    );
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "access-token": opts.accessToken,
  };
  if (opts.clientId) headers["client-id"] = opts.clientId;

  const cat = dhanCategory(basePath);
  const t0 = Date.now();
  let lastRes: Response | null = null;

  for (let attempt = 0; attempt <= DHAN_MAX_RETRIES; attempt++) {
    // Pace this dispatch within the category's per-second budget, then take an
    // in-flight slot. Both are re-acquired on each retry so back-off is honoured.
    await acquireDhanSlot(cat);
    await awaitConcurrency();
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: opts.method || "GET",
        headers,
        body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e: any) {
      _dhanActive--;
      if (AUDIT_ENABLED) recordCall({ provider: "dhan", endpoint: basePath, ...dhanBodyMeta(opts.body), latencyMs: Date.now() - t0, httpStatus: 0, respBytes: null, error: String(e?.message || e), retry: attempt, rateLimit: false });
      throw e;
    }
    _dhanActive--;
    if (AUDIT_ENABLED) {
      const cl = Number(res.headers.get("content-length"));
      recordCall({ provider: "dhan", endpoint: basePath, ...dhanBodyMeta(opts.body), latencyMs: Date.now() - t0, httpStatus: res.status, respBytes: Number.isFinite(cl) ? cl : null, error: res.ok ? null : `http_${res.status}`, retry: attempt, rateLimit: res.status === 429 });
    }
    // DH-904 / 429 is the ONLY status Dhan marks "safe to retry" here. Everything
    // else (auth, input, data errors) returns immediately to the caller unchanged.
    if (res.status !== 429 || attempt >= DHAN_MAX_RETRIES) return res;
    lastRes = res;
    const ra = Number(res.headers.get("retry-after"));
    const expo = Math.min(DHAN_BACKOFF_CAP_MS, DHAN_BACKOFF_BASE_MS * Math.pow(2, attempt));
    const backoff = Math.max(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0, expo) + Math.floor(Math.random() * 300);
    console.warn(`[dhan-rl] 429/DH-904 on ${basePath} (${cat}) — retry ${attempt + 1}/${DHAN_MAX_RETRIES} after ${backoff}ms`);
    try { await res.body?.cancel(); } catch { /* release the unread body before retrying */ }
    await _dhanSleep(backoff);
  }
  // Unreachable in practice (loop returns on the last attempt), but satisfies the
  // type checker and guarantees a Response is always produced.
  return lastRes as Response;
}
