import { Candle } from "../types";
import { loadDhanConfig } from "./dhanConfig";
import { DhanSecurity } from "./dhanInstruments";
import { dhanFetch as guardedDhanFetch } from "./dhanClient";

// ---- Dhan historical candles (BACKTESTING ONLY) ----
// Verified live against the real API before writing this (dhanhq.co/docs/v2/
// historical-data/): daily via POST /charts/historical (fromDate/toDate, no
// documented per-call range cap), intraday via POST /charts/intraday (capped
// at 90 days per call per Dhan's docs - paginated below for longer ranges).
// Response is parallel arrays (open/high/low/close/volume/timestamp); a live
// test call confirmed `timestamp` is epoch SECONDS UTC, directly compatible
// with this app's Candle.time.

const MAX_INTRADAY_DAYS = 90; // Dhan's documented per-call cap for intraday intervals

export type DhanBacktestInterval = "1d" | "5" | "15" | "60";

function toCandles(payload: any): Candle[] {
  const open: number[] = payload?.open || [];
  const high: number[] = payload?.high || [];
  const low: number[] = payload?.low || [];
  const close: number[] = payload?.close || [];
  const volume: number[] = payload?.volume || [];
  const timestamp: number[] = payload?.timestamp || [];
  const n = Math.min(open.length, high.length, low.length, close.length, timestamp.length);
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ time: timestamp[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: volume[i] ?? 0 });
  }
  return out;
}

// Routed through dhanClient.ts's allowlisted guard - see that file's header
// comment for why (hard-fails any path that isn't explicit read-only market
// data, even before this function's own logic runs).
async function dhanFetchJson(path: string, body: Record<string, unknown>): Promise<any> {
  const cfg = loadDhanConfig();
  if (!cfg.accessToken) throw new Error("Dhan not connected — paste an access token first (Dhan button in the top bar).");
  const res = await guardedDhanFetch(path, { method: "POST", body, accessToken: cfg.accessToken });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Dhan ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// fromDate/toDate are "yyyy-mm-dd". Returns candles sorted ascending, deduped
// on timestamp (chunk boundaries can otherwise repeat one bar).
export async function fetchDhanCandles(
  sec: DhanSecurity,
  interval: DhanBacktestInterval,
  fromDate: string,
  toDate: string
): Promise<Candle[]> {
  if (interval === "1d") {
    const payload = await dhanFetchJson("/charts/historical", {
      securityId: sec.securityId, exchangeSegment: sec.exchangeSegment, instrument: sec.instrument,
      fromDate, toDate,
    });
    return toCandles(payload);
  }
  const chunks: Candle[] = [];
  let curFrom = fromDate;
  while (curFrom < toDate) {
    const candidateTo = addDaysIso(curFrom, MAX_INTRADAY_DAYS);
    const curTo = candidateTo < toDate ? candidateTo : toDate;
    const payload = await dhanFetchJson("/charts/intraday", {
      securityId: sec.securityId, exchangeSegment: sec.exchangeSegment, instrument: sec.instrument,
      interval: Number(interval), fromDate: curFrom, toDate: curTo,
    });
    chunks.push(...toCandles(payload));
    if (curTo === curFrom) break; // safety: range didn't advance, stop instead of looping forever
    curFrom = curTo;
  }
  const seen = new Set<number>();
  return chunks
    .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
    .sort((a, b) => a.time - b.time);
}
