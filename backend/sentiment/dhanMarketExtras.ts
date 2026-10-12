import fs from "fs";
import path from "path";
import { fetchDhanCandles, fetchDhanIntradayAllHours } from "../data/dhanHistorical";
import { dhanFetch } from "../data/dhanClient";
import { loadDhanConfig } from "../data/dhanConfig";
import type { Candle } from "../types";

// ============================ Dhan-only market extras for the Market Sentiment inputs ============================
// · MCX CRUDEOIL front-month (₹/bbl) — the crude input (Dhan has no live USD/INR, so the rule is in ₹)
// · GIFT NIFTY overnight move (IDX_I 5024) — the global-markets cue (it trades through US hours)
// · India VIX daily (IDX_I 21)

export const GIFT_SEC = { securityId: "5024", exchangeSegment: "IDX_I", instrument: "INDEX" };
export const VIX_SEC = { securityId: "21", exchangeSegment: "IDX_I", instrument: "INDEX" };
const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const istHm = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);

export interface McxContract { securityId: string; expiry: string; name: string }
/** Listed MCX CRUDEOIL futures from the Dhan instrument master (data/dhan_instruments.csv). */
export function crudeContracts(): McxContract[] {
  try {
    const lines = fs.readFileSync(path.resolve(process.cwd(), "data", "dhan_instruments.csv"), "utf8").split("\n");
    const h = lines[0].split(","), ix = (n: string) => h.indexOf(n);
    const iEx = ix("EXCH_ID"), iId = ix("SECURITY_ID"), iIn = ix("INSTRUMENT"), iU = ix("UNDERLYING_SYMBOL"), iE = ix("SM_EXPIRY_DATE");
    return lines.slice(1).map((l) => l.split(",")).filter((c) => c[iEx] === "MCX" && c[iIn] === "FUTCOM" && c[iU] === "CRUDEOIL")
      .map((c) => ({ securityId: c[iId], expiry: c[iE], name: `CRUDEOIL ${c[iE].slice(0, 7)}` })).sort((a, b) => a.expiry.localeCompare(b.expiry));
  } catch { return []; }
}
/** Front month = nearest expiry at least 3 days after `date` (avoids the expiry-week squeeze). */
export function frontContract(list: McxContract[], date: string): McxContract | null {
  const lim = new Date(Date.parse(date + "T00:00:00Z") + 3 * 86400_000).toISOString().slice(0, 10);
  return list.find((c) => c.expiry >= lim) || null;
}

/** Live MCX crude front month (one Dhan quote call). */
export async function mcxCrudeLive(): Promise<{ value: number; ts: number; contract: string } | null> {
  const fc = frontContract(crudeContracts(), istDay(Math.floor(Date.now() / 1000))); if (!fc) return null;
  const cfg = loadDhanConfig(); if (!cfg.accessToken) return null;
  const r = await dhanFetch("/marketfeed/ltp", { method: "POST", body: { MCX_COMM: [Number(fc.securityId)] }, accessToken: cfg.accessToken, clientId: cfg.clientId });
  const j: any = await r.json().catch(() => null);
  const v = Number(j?.data?.MCX_COMM?.[fc.securityId]?.last_price);
  return v > 0 ? { value: v, ts: Math.floor(Date.now() / 1000), contract: fc.name } : null;
}

/** GIFT NIFTY overnight move: last bar after the previous trading day's 15:25 bar and before 06:30 IST
 *  today (the night session can run past midnight — Friday's ends Saturday 02:45) vs that 15:25 bar. */
export function giftOvernightFrom(bars: { time: number; close: number }[], today: string): { nightPct: number; ts: number } | null {
  const ref = bars.filter((b) => istHm(b.time) === "15:25" && istDay(b.time) < today).pop();
  const cutoff = Math.floor(Date.parse(today + "T01:00:00Z") / 1000);   // 06:30 IST
  const night = ref ? bars.filter((b) => b.time > ref.time && b.time < cutoff).pop() : undefined;
  return ref && night ? { nightPct: Math.round((night.close / ref.close - 1) * 10000) / 100, ts: night.time + 300 } : null;
}
export async function giftOvernightLive(): Promise<{ nightPct: number; ts: number } | null> {
  const now = Math.floor(Date.now() / 1000), today = istDay(now);
  const from = istDay(now - 5 * 86400), to = istDay(now + 86400);
  return giftOvernightFrom(await fetchDhanIntradayAllHours(GIFT_SEC, "5", from, to), today);
}

/** Daily series helpers for the scenario library. */
export async function vixDaily(fromDate: string, toDate: string): Promise<Candle[]> { return fetchDhanCandles(VIX_SEC as any, "1d", fromDate, toDate); }
/** MCX crude per date (Dhan returns a rolled front-month series for the listed contract; liquid days only, volume ≥ 5,000). */
export async function crudeDailySeries(fromDate: string, toDate: string): Promise<[string, number][]> {
  const list = crudeContracts(), out = new Map<string, number>();
  for (const c of list.slice(0, 4)) {
    let bars: Candle[] = [];
    try { bars = await fetchDhanCandles({ securityId: c.securityId, exchangeSegment: "MCX_COMM", instrument: "FUTCOM" } as any, "1d", fromDate, toDate); } catch { continue; }
    for (const b of bars) { const d = istDay(b.time); const fc = frontContract(list, d); if (fc && fc.securityId === c.securityId && (b.volume || 0) >= 5000 && !out.has(d)) out.set(d, b.close); }
  }
  return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
/** GIFT NIFTY 5-min bars over a long range (90-day chunks). */
export async function giftHistory(fromDate: string, toDate: string): Promise<Candle[]> {
  const out: Candle[] = []; let cur = fromDate;
  while (cur < toDate) {
    const nxt = new Date(Date.parse(cur + "T00:00:00Z") + 85 * 86400_000).toISOString().slice(0, 10);
    const end = nxt < toDate ? nxt : toDate;
    try { out.push(...(await fetchDhanIntradayAllHours(GIFT_SEC, "5", cur, end))); } catch { /* gap */ }
    if (end === cur) break; cur = end;
  }
  const seen = new Set<number>(); return out.filter((b) => (seen.has(b.time) ? false : (seen.add(b.time), true))).sort((a, b) => a.time - b.time);
}
