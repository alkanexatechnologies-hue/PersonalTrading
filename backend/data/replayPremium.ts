// REPLAY PREMIUMS for Market Command's date filter (owner 2026-10-25): real Dhan option premiums of a PAST session so
// the CE / PE charts follow the ↺ Replay date. Read-only, display only — no trading logic reads this.
// Source: Dhan /charts/rollingoption, 1-minute, nearest weekly (monthly for BANKNIFTY / FINNIFTY / MIDCPNIFTY) expiry,
// ATM−3 … ATM+3, CE and PE — the same series the ProTrader research downloads (data/research-*/raw1m), so expired
// contracts work. A day missing from that cache is fetched once (14 requests) and kept in data/replay-premium/.
// Per-strike candles are built from 1-minute bars only (a 5-minute rolling bar can mix two strikes when the ATM flips).
import fs from "fs";
import path from "path";
import { dhanFetch } from "./dhanClient";
import { loadDhanConfig } from "./dhanConfig";
import { DATA_DIR } from "../config/dataDir";

export const REPLAY_INDEX: Record<string, { name: string; dir: string; securityId: number; seg: string; flag: "WEEK" | "MONTH"; step: number }> = {
  "^NSEI": { name: "NIFTY", dir: path.join("research-nifty20", "raw1m"), securityId: 13, seg: "NSE_FNO", flag: "WEEK", step: 50 },
  "^NSEBANK": { name: "BANKNIFTY", dir: path.join("research-multi", "BANKNIFTY", "raw1m"), securityId: 25, seg: "NSE_FNO", flag: "MONTH", step: 100 },
  "^CNXFIN": { name: "FINNIFTY", dir: path.join("research-multi", "FINNIFTY", "raw1m"), securityId: 27, seg: "NSE_FNO", flag: "MONTH", step: 50 },
  "^NSEMDCP50": { name: "MIDCPNIFTY", dir: path.join("research-multi", "MIDCPNIFTY", "raw1m"), securityId: 442, seg: "NSE_FNO", flag: "MONTH", step: 25 },
  "^BSESN": { name: "SENSEX", dir: path.join("research-multi", "SENSEX", "raw1m"), securityId: 51, seg: "BSE_FNO", flag: "WEEK", step: 100 },
};
export type Side = "CE" | "PE";
export interface Raw { timestamp: number[]; open: number[]; high: number[]; low: number[]; close: number[]; strike: number[]; spot: number[]; oi?: (number | null)[]; volume?: (number | null)[] }
export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }
const IST = 19800;
export const istDay = (t: number) => new Date((t + IST) * 1000).toISOString().slice(0, 10);
const mn = (t: number) => Math.floor(((t + IST) % 86400) / 60);

/** Research cache file (`<from>_<to>_<side>_<rel>.json`) whose range covers the day, or null. */
export function coveringFile(files: string[], day: string, side: Side, rel: number): string | null {
  for (const f of files) { const m = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_(CE|PE)_(-?\d)\.json$/.exec(f); if (m && m[3] === side && Number(m[4]) === rel && m[1] <= day && day <= m[2]) return f; }
  return null;
}

/** 1-minute bars per strike for ONE side and ONE day (first bar wins when two rel series carry the same strike-minute). */
export function legsOf(raws: Raw[], day: string): { legs: Map<number, Bar[]>; spot: Map<number, number> } {
  const legs = new Map<number, Map<number, Bar>>(), spot = new Map<number, number>();
  for (const d of raws) d.timestamp.forEach((t, i) => {
    if (istDay(t) !== day) return; const m = mn(t); if (m < 555 || m >= 930) return;
    if (d.spot?.[i] > 0 && !spot.has(t)) spot.set(t, d.spot[i]);
    if (!(d.close[i] > 0) || !(d.strike[i] > 0)) return;
    const k = d.strike[i], byT = legs.get(k) || new Map<number, Bar>(); if (byT.has(t)) return;
    byT.set(t, { time: t, open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i], volume: d.volume?.[i] ?? 0 }); legs.set(k, byT);
  });
  const out = new Map<number, Bar[]>(); for (const [k, m] of legs) out.set(k, [...m.values()].sort((a, b) => a.time - b.time));
  return { legs: out, spot };
}

/** 1-minute → n-minute candles anchored at 09:15 IST (n = 1, 5, 15, 30, 60). */
export function aggregate(bars: Bar[], n: number): Bar[] {
  const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const b of bars) { const m = mn(b.time); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / n);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: b.time - (m - 555 - k * n) * 60, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 }; key = k; }
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume || 0; } }
  if (cur) out.push(cur); return out;
}

/** ATM strike at the last recorded spot of the day. */
export function atmOf(spot: Map<number, number>, step: number): number | null {
  if (!spot.size) return null; const last = [...spot.entries()].sort((a, b) => a[0] - b[0]).pop()![1]; return Math.round(last / step) * step;
}

/** Same contract on both days? The ATM straddle at the previous close vs the next open: after an expiry the new weekly's
 *  straddle is several times the expiring one's, so a ratio outside 0.5–2 means the previous day must not be joined. */
export function sameContract(prevLastStraddle: number | null, dayFirstStraddle: number | null): boolean {
  if (!prevLastStraddle || !dayFirstStraddle) return false; const r = dayFirstStraddle / prevLastStraddle; return r >= 0.5 && r <= 2;
}

// ---------------------------------------------------------------------------------------------------------------- I/O
async function rawFor(sym: string, day: string, side: Side, rel: number, allowFetch: boolean): Promise<Raw | null> {
  const c = REPLAY_INDEX[sym]; if (!c) return null;
  const dir = path.join(DATA_DIR, c.dir);
  try { const f = coveringFile(fs.readdirSync(dir), day, side, rel); if (f) return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { /* not cached */ }
  const own = path.join(DATA_DIR, "replay-premium", c.name, `${day}_${side}_${rel}.json`);
  try { return JSON.parse(fs.readFileSync(own, "utf8")); } catch { /* fetch */ }
  if (!allowFetch) return null;
  const cfg = loadDhanConfig(), strike = rel === 0 ? "ATM" : rel > 0 ? `ATM+${rel}` : `ATM${rel}`;
  const next = new Date(Date.parse(day + "T00:00:00Z") + 86400e3).toISOString().slice(0, 10);
  const r = await dhanFetch("/charts/rollingoption", { method: "POST", accessToken: cfg.accessToken, clientId: cfg.clientId,
    body: { exchangeSegment: c.seg, interval: "1", securityId: c.securityId, instrument: "OPTIDX", expiryFlag: c.flag, expiryCode: 1, strike, drvOptionType: side === "CE" ? "CALL" : "PUT",
      requiredData: ["open", "high", "low", "close", "strike", "spot", "oi", "volume"], fromDate: day, toDate: next } });
  const j: any = await r.json().catch(() => null), x0 = j?.data?.[side === "CE" ? "ce" : "pe"];
  // Dhan answers OK with no series on a holiday / weekend — keep it as an empty day (no re-fetch), like the research downloader
  const x = r.ok && j && !x0 ? { timestamp: [], open: [], high: [], low: [], close: [], strike: [], spot: [], oi: [], volume: [] } : x0;
  if (!r.ok || !x || !Array.isArray(x.timestamp)) throw new Error(`Dhan rolling option ${c.name} ${day} ${side} ${strike}: ${r.status}`);
  fs.mkdirSync(path.dirname(own), { recursive: true }); fs.writeFileSync(own, JSON.stringify(x));
  return x;
}
async function dayLegs(sym: string, day: string, allowFetch: boolean) {
  const out: Record<Side, ReturnType<typeof legsOf>> = {} as any;
  for (const side of ["CE", "PE"] as Side[]) {
    const raws: Raw[] = [];
    for (let rel = -3; rel <= 3; rel++) { const r = await rawFor(sym, day, side, rel, allowFetch); if (r) raws.push(r); }
    out[side] = legsOf(raws, day);
  }
  return out;
}
const straddle = (L: Record<Side, ReturnType<typeof legsOf>>, k: number | null, first: boolean) => {
  if (k == null) return null; const pick = (b?: Bar[]) => (b?.length ? (first ? b[0].open : b[b.length - 1].close) : null);
  const c = pick(L.CE.legs.get(k)), p = pick(L.PE.legs.get(k)); return c != null && p != null ? c + p : null;
};

/** Replay premium candles for one strike of a past session (+ the previous session for the EMAs when it is the same contract). */
export async function replayPremium(sym: string, day: string, strike: number | null, interval: number) {
  const c = REPLAY_INDEX[sym]; if (!c) return { available: false, message: "Replay premiums are kept for NIFTY, BANKNIFTY, FINNIFTY, MIDCAP NIFTY and SENSEX." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { available: false, message: "date must be YYYY-MM-DD" };
  const L = await dayLegs(sym, day, true);
  const atm = atmOf(L.CE.spot.size ? L.CE.spot : L.PE.spot, c.step);
  if (atm == null) return { available: false, message: `No Dhan premium data for ${c.name} on ${day} (holiday or not a trading day).` };
  const k = strike ?? atm, strikes = [...new Set([...L.CE.legs.keys(), ...L.PE.legs.keys()])].sort((a, b) => a - b);
  // previous session from the cache only (no extra fetch), joined only when it is the same contract
  let prev: typeof L | null = null, prevDay: string | null = null;
  for (let back = 1; back <= 5 && !prev; back++) {
    const dd = new Date(Date.parse(day + "T00:00:00Z") - back * 86400e3).toISOString().slice(0, 10);
    const P = await dayLegs(sym, dd, false).catch(() => null);
    if (P && (P.CE.spot.size || P.PE.spot.size)) { prevDay = dd; if (sameContract(straddle(P, atmOf(P.CE.spot, c.step), false), straddle(L, atmOf(L.CE.spot, c.step), true))) prev = P; break; }
  }
  const side = (s: Side) => { const today = L[s].legs.get(k) || [], before = prev?.[s].legs.get(k) || [];
    return { candles: aggregate([...before, ...today], interval), sessionCandles: today.length ? aggregate(today, interval).length : 0, message: today.length ? undefined : `${k} ${s} was outside the recorded ATM±3 band on ${day}` }; };
  return { available: true, source: `Dhan rolling option · 1-minute · ${c.flag === "WEEK" ? "nearest weekly" : "nearest monthly"} expiry · ATM±3`, index: c.name, date: day,
    atm, strike: k, strikes, prevJoined: prevDay && prev ? prevDay : null, prevSkipped: prevDay && !prev ? `${prevDay} (expiry roll — different contract)` : null,
    interval, ce: side("CE"), pe: side("PE") };
}
