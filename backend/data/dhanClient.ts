// ---- Dhan API safety gate (BACKTEST / MARKET-DATA ONLY) ----
// This app never places, modifies, or cancels a real order through Dhan - the
// connection exists solely for historical-data backtesting (see
// dhanHistorical.ts, dhanConfig.ts). This file is the ONE place every Dhan
// HTTP call in the codebase is required to go through, so a future accidental
// order-API call (a typo, a copy-pasted snippet, a careless edit) fails
// immediately and loudly instead of silently reaching Dhan's servers.
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
  "/charts/historical", // daily OHLC(+OI) - backtesting
  "/charts/intraday",   // intraday OHLC(+OI) - backtesting
  "/fundlimit",         // account read-only, used only to verify a token works
]);

export interface DhanFetchOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  accessToken: string;
}

export async function dhanFetch(path: string, opts: DhanFetchOptions): Promise<Response> {
  if (!DHAN_BACKTEST_MODE) {
    throw new Error("Dhan integration disabled (DHAN_BACKTEST_MODE=false) — set it back to true (or unset it) to use historical data.");
  }
  if (!ALLOWED_PATHS.has(path)) {
    throw new Error(
      `BLOCKED: "${path}" is not on the Dhan read-only allowlist (backtest/market-data only — no order-placement APIs are ever called from this app). Refusing to call it.`
    );
  }
  return fetch(`${BASE}${path}`, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", Accept: "application/json", "access-token": opts.accessToken },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
}
