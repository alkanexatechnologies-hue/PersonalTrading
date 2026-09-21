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

const BASE = "https://api.dhan.co/v2";

const ALLOWED_PATHS = new Set<string>([
  "/charts/historical", // daily OHLC(+OI)
  "/charts/intraday",   // intraday OHLC(+OI)
  "/fundlimit",         // account read-only, used only to verify a token works
  "/marketfeed/ltp",    // live LTP for quotes
  "/marketfeed/ohlc",   // live OHLC for quotes
  "/marketfeed/quote",  // full market quote (OI, volume, OHLC)
  "/option/chain",      // option chain (strikes, OI, greeks)
  "/expiry/list",       // expiry dates for an underlying
]);

export interface DhanFetchOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  accessToken: string;
  clientId?: string;
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
  return fetch(`${BASE}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
}
