// Test Lab historical data access. REUSES the existing Dhan client (auth +
// rate-limit + allowlist) and saved config — no new auth. Fetches index SPOT
// and FUTURES intraday candles and EMPIRICALLY probes whether Dhan returns
// Open Interest for the derivative series (spec §5: do not assume OI absent).
// Never prints/stores the access token.

import { dhanFetch } from "../data/dhanClient";
import { loadDhanConfig } from "../data/dhanConfig";
import { Candle } from "../types";
import { DHAN_NATIVE_INTRADAY } from "./config";

export interface SeriesResult {
  candles: Candle[];
  oi: (number | null)[];      // aligned to candles; null when absent
  oiStatus: "AVAILABLE" | "UNAVAILABLE";
  rawKeys: string[];          // response keys seen (diagnostics)
}

const MAX_CHUNK_DAYS = 90;
const DAY = 86_400_000;
const istDay = (ms: number) => new Date(ms + 19800000).toISOString().slice(0, 10);

function parsePayload(j: any): { c: Candle[]; oi: (number | null)[]; keys: string[]; hasOi: boolean } {
  const keys = j && typeof j === "object" ? Object.keys(j) : [];
  const o = j?.open, h = j?.high, l = j?.low, cl = j?.close, v = j?.volume, t = j?.timestamp ?? j?.start_Time ?? j?.start_time;
  // Dhan returns OI as `open_interest` (array) on derivative charts when present.
  const oiArr = j?.open_interest ?? j?.oi ?? null;
  const c: Candle[] = [];
  const oi: (number | null)[] = [];
  if (Array.isArray(t) && Array.isArray(cl)) {
    for (let i = 0; i < t.length; i++) {
      const ts = Number(t[i]);
      c.push({
        time: ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts),
        open: Number(o?.[i] ?? 0), high: Number(h?.[i] ?? 0), low: Number(l?.[i] ?? 0),
        close: Number(cl?.[i] ?? 0), volume: Number(v?.[i] ?? 0),
      });
      oi.push(Array.isArray(oiArr) && oiArr[i] != null ? Number(oiArr[i]) : null);
    }
  }
  const hasOi = Array.isArray(oiArr) && oiArr.some((x: any) => x != null && Number(x) > 0);
  return { c, oi, keys, hasOi };
}

async function fetchChunk(body: Record<string, unknown>): Promise<any> {
  const cfg = loadDhanConfig();
  if (!cfg.accessToken) throw new Error("Dhan not connected (no access token).");
  const res = await dhanFetch("/charts/intraday", { method: "POST", body, accessToken: cfg.accessToken, clientId: cfg.clientId });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Dhan /charts/intraday ${res.status}: ${txt.slice(0, 160)}`);
  }
  return res.json();
}

/**
 * Fetch intraday candles for a Dhan security over [startEpoch,endEpoch] (sec),
 * paginated in <=90-day chunks. `intervalMin` must be a Dhan-native minute
 * (1/5/15/25/60); 3-min is handled by the caller via 1-min resample.
 * Requests OI (`oi:true`) and reports whether the feed actually returned it.
 */
export async function fetchIntraday(
  securityId: string,
  exchangeSegment: string,
  instrument: string,
  intervalMin: number,
  startEpoch: number,
  endEpoch: number,
): Promise<SeriesResult> {
  if (!DHAN_NATIVE_INTRADAY.has(intervalMin)) throw new Error(`Interval ${intervalMin}m not Dhan-native`);
  const all: Candle[] = [];
  const allOi: (number | null)[] = [];
  const keysSeen = new Set<string>();
  let anyOi = false;
  let fromMs = startEpoch * 1000;
  const endMs = endEpoch * 1000;
  // pad start by 1 day so the first bar isn't clipped; filter at the end.
  let cursor = fromMs - DAY;
  while (cursor <= endMs) {
    const chunkTo = Math.min(cursor + MAX_CHUNK_DAYS * DAY, endMs + DAY);
    const body = {
      securityId, exchangeSegment, instrument,
      interval: String(intervalMin),
      oi: true,
      fromDate: istDay(cursor), toDate: istDay(chunkTo),
    };
    let j: any;
    try { j = await fetchChunk(body); } catch (e) { if (cursor === fromMs - DAY && all.length === 0) throw e; else break; }
    const { c, oi, keys, hasOi } = parsePayload(j);
    keys.forEach((k) => keysSeen.add(k));
    if (hasOi) anyOi = true;
    for (let i = 0; i < c.length; i++) { all.push(c[i]); allOi.push(oi[i]); }
    cursor = chunkTo + DAY;
  }
  // dedupe on time, sort asc, clip to window
  const seen = new Set<number>();
  const idx: number[] = [];
  all.forEach((cd, i) => { if (!seen.has(cd.time) && cd.time >= startEpoch && cd.time <= endEpoch) { seen.add(cd.time); idx.push(i); } });
  idx.sort((a, b) => all[a].time - all[b].time);
  const candles = idx.map((i) => all[i]);
  const oiOut = idx.map((i) => allOi[i]);
  return { candles, oi: oiOut, oiStatus: anyOi ? "AVAILABLE" : "UNAVAILABLE", rawKeys: [...keysSeen] };
}

/** Resample 1-min candles into N-min buckets (for 3m, which Dhan lacks natively). */
export function resample(cands: Candle[], oi: (number | null)[], factor: number): { candles: Candle[]; oi: (number | null)[] } {
  const out: Candle[] = []; const outOi: (number | null)[] = [];
  for (let i = 0; i < cands.length; i += factor) {
    const chunk = cands.slice(i, i + factor);
    if (!chunk.length) continue;
    out.push({
      time: chunk[0].time, open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)), low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close, volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
    const lastOi = oi.slice(i, i + factor).filter((x) => x != null).pop();
    outOi.push(lastOi ?? null);
  }
  return { candles: out, oi: outOi };
}
