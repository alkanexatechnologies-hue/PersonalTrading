import fs from "fs";
import path from "path";
import { dhanFetch } from "../../data/dhanClient";
import { loadDhanConfig } from "../../data/dhanConfig";
import { DATA_DIR } from "../../config/dataDir";

// ============================ NIFTY 20-point research — clean per-strike data ============================
// Source: Dhan /charts/rollingoption, 1-MINUTE, nearest weekly expiry, ATM−3 … ATM+3, CE and PE, with OI, IV, volume, spot.
// Why 1-minute: the 5-minute rolling candles mix two strikes whenever the ATM flips inside the 5 minutes (audit: 19 % of
// 5-min bars are roll bars; open-vs-previous-close gaps > 20 % on 38,879 of them). At 1 minute each bar belongs to the
// strike it is labelled with, so per-strike series are assembled from 1-minute bars only, keyed by (strike, side).
// Research only — nothing here is read by signals, the arbiter or paper trading.

export type Side = "CE" | "PE";
export interface Min { t: number; o: number; h: number; l: number; c: number; v: number | null; oi: number | null; iv: number | null }
export interface DayData { day: string; spot: Map<number, number>; legs: Map<string, Min[]>; expiryGuess: string | null }   // legs key `${strike}${side}`
const IST = 19800;
export const istDay = (t: number) => new Date((t + IST) * 1000).toISOString().slice(0, 10);
export const istHm = (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16);
const CACHE = path.join(DATA_DIR, "research-nifty20", "raw1m");
const FIELDS = ["open", "high", "low", "close", "strike", "spot", "oi", "iv", "volume"];

export function monthChunks(from: string, to: string): [string, string][] {
  const out: [string, string][] = []; let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  for (;;) {
    const a = `${y}-${String(m).padStart(2, "0")}-01`, last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const s = a < from ? from : a, e = last > to ? to : last;
    if (s > to) break; out.push([s, e]); m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
async function fetchRaw(from: string, to: string, side: Side, rel: number): Promise<any> {
  const f = path.join(CACHE, `${from}_${to}_${side}_${rel}.json`);
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* fetch */ }
  const cfg = loadDhanConfig(), strike = rel === 0 ? "ATM" : rel > 0 ? `ATM+${rel}` : `ATM${rel}`;
  let d: any = null, status = 0;
  for (let attempt = 0; attempt < 5 && !d; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const r = await dhanFetch("/charts/rollingoption", { method: "POST", accessToken: cfg.accessToken, clientId: cfg.clientId,
        body: { exchangeSegment: "NSE_FNO", interval: "1", securityId: 13, instrument: "OPTIDX", expiryFlag: "WEEK", expiryCode: 1, strike, drvOptionType: side === "CE" ? "CALL" : "PUT", requiredData: FIELDS, fromDate: from, toDate: to } });
      status = r.status;
      const j: any = await r.json().catch(() => null), x = j?.data?.[side === "CE" ? "ce" : "pe"];
      if (r.ok && x && Array.isArray(x.timestamp)) d = x;
    } catch { /* retry */ }
  }
  if (!d) throw new Error(`rollingoption 1m ${from}..${to} ${side} ${strike}: ${status}`);
  fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, JSON.stringify(d));
  return d;
}
/** Download (cached) every month × side × rel; 4 requests in flight, Dhan rate limits enforced by dhanFetch. */
export async function downloadAll(from: string, to: string, onProgress?: (done: number, total: number) => void) {
  const jobs: [string, string, Side, number][] = [];
  for (const [a, b] of monthChunks(from, to)) for (const s of ["CE", "PE"] as Side[]) for (let r = -3; r <= 3; r++) jobs.push([a, b, s, r]);
  let next = 0, done = 0;
  const worker = async () => { while (next < jobs.length) { const [a, b, s, r] = jobs[next++]; await fetchRaw(a, b, s, r); done++; onProgress?.(done, jobs.length); } };
  await Promise.all(Array.from({ length: 4 }, worker));
  return jobs.length;
}

export interface Assembly { days: DayData[]; stats: { minuteRows: number; dupConflicts: number; zeroPrice: number; daysMissingSpot: number } }
/** Assemble per-strike 1-minute series from the cached raw files (no network). */
export function assemble(from: string, to: string): Assembly {
  const byDay = new Map<string, DayData>(); let rows = 0, dup = 0, zero = 0;
  for (const [a, b] of monthChunks(from, to)) for (const s of ["CE", "PE"] as Side[]) for (let r = -3; r <= 3; r++) {
    let d: any; try { d = JSON.parse(fs.readFileSync(path.join(CACHE, `${a}_${b}_${s}_${r}.json`), "utf8")); } catch { continue; }
    d.timestamp.forEach((t: number, i: number) => {
      rows++;
      const day = istDay(t), dd = byDay.get(day) || { day, spot: new Map(), legs: new Map(), expiryGuess: null };
      if (d.spot[i] > 0) dd.spot.set(t, d.spot[i]);
      if (!(d.close[i] > 0)) { zero++; byDay.set(day, dd); return; }
      const k = `${d.strike[i]}${s}`, arr = dd.legs.get(k) || [];
      if (arr.length && arr[arr.length - 1].t === t) { dup++; byDay.set(day, dd); return; }    // same strike from two rel series in one minute: keep the first
      arr.push({ t, o: d.open[i], h: d.high[i], l: d.low[i], c: d.close[i], v: d.volume?.[i] ?? null, oi: d.oi?.[i] ?? null, iv: d.iv?.[i] ?? null });
      dd.legs.set(k, arr); byDay.set(day, dd);
    });
  }
  const days = [...byDay.values()].sort((x, y) => x.day.localeCompare(y.day));
  for (const d of days) for (const arr of d.legs.values()) arr.sort((x, y) => x.t - y.t);
  return { days, stats: { minuteRows: rows, dupConflicts: dup, zeroPrice: zero, daysMissingSpot: days.filter((d) => d.spot.size < 300).length } };
}
