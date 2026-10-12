import fs from "fs";
import path from "path";
import { dhanFetch } from "../data/dhanClient";
import { loadDhanConfig } from "../data/dhanConfig";
import { DATA_DIR } from "../config/dataDir";

// ============================ "20 points a day" research backtest (NIFTY options, real premiums) ============================
// Data: Dhan /charts/rollingoption — 5-min OHLC of EXPIRED NIFTY weekly options at ATM−3 … ATM+3 (CE and PE), with spot.
// A trade follows ONE fixed strike from entry to exit (looked up among the rolling series by its strike), so the
// premium path is the real contract's path. No look-ahead: signals use closed bars, entries fill at the NEXT bar's open,
// and when a bar touches both target and stop the stop is assumed first. Research only — not used by any live logic.

export interface Leg { o: number; h: number; l: number; c: number }
export interface Bar { t: number; spot: number; legs: Map<string, Leg> }     // key `${strike}${CE|PE}`
const IST = 19800;
export const istDay = (t: number) => new Date((t + IST) * 1000).toISOString().slice(0, 10);
export const istHm = (t: number) => new Date((t + IST) * 1000).toISOString().slice(11, 16);

// ---------------- data ----------------
const CACHE = path.join(DATA_DIR, "backtest-rolling");
async function fetchSeries(from: string, to: string, type: "CALL" | "PUT", rel: number): Promise<any> {
  const f = path.join(CACHE, `NIFTY-${from}-${to}-${type}-${rel}.json`);
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* fetch */ }
  const cfg = loadDhanConfig();
  const strike = rel === 0 ? "ATM" : rel > 0 ? `ATM+${rel}` : `ATM${rel}`;
  let d: any = null, status = 0;
  for (let attempt = 0; attempt < 4 && !d; attempt++) {          // Dhan sometimes answers 5xx under load — retry with backoff
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const r = await dhanFetch("/charts/rollingoption", { method: "POST", accessToken: cfg.accessToken, clientId: cfg.clientId,
        body: { exchangeSegment: "NSE_FNO", interval: "5", securityId: 13, instrument: "OPTIDX", expiryFlag: "WEEK", expiryCode: 1, strike, drvOptionType: type, requiredData: ["open", "high", "low", "close", "strike", "spot"], fromDate: from, toDate: to } });
      status = r.status;
      const j: any = await r.json().catch(() => null);
      const x = j?.data?.[type === "CALL" ? "ce" : "pe"];
      if (r.ok && x && Array.isArray(x.timestamp)) d = x;
    } catch { /* retry */ }
  }
  if (!d) throw new Error(`rollingoption ${from}..${to} ${type} ${strike}: ${status}`);
  fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, JSON.stringify(d));
  return d;
}
/** Month chunks from `from` to `to` (inclusive). */
export function monthChunks(from: string, to: string): [string, string][] {
  const out: [string, string][] = []; let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  while (true) {
    const a = `${y}-${String(m).padStart(2, "0")}-01`, last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const s = a < from ? from : a, e = last > to ? to : last;
    if (s > to) break; out.push([s, e]);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
export async function loadBars(from: string, to: string, rels = [-3, -2, -1, 0, 1, 2, 3]): Promise<Bar[]> {
  const byT = new Map<number, Bar>();
  const jobs: [string, string, "CALL" | "PUT", number][] = [];
  for (const [a, b] of monthChunks(from, to)) for (const type of ["CALL", "PUT"] as const) for (const rel of rels) jobs.push([a, b, type, rel]);
  const results: { type: "CALL" | "PUT"; d: any }[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const k = next++; const [a, b, type, rel] = jobs[k]; results[k] = { type, d: await fetchSeries(a, b, type, rel) }; } };
  await Promise.all(Array.from({ length: 4 }, worker));   // 4 in flight; dhanFetch still enforces Dhan's rate limits
  for (const { type, d } of results) {
    d.timestamp.forEach((t: number, i: number) => {
      const bar = byT.get(t) || { t, spot: d.spot[i], legs: new Map() };
      const k = `${d.strike[i]}${type === "CALL" ? "CE" : "PE"}`;
      if (!bar.legs.has(k) && d.open[i] > 0) bar.legs.set(k, { o: d.open[i], h: d.high[i], l: d.low[i], c: d.close[i] });
      byT.set(t, bar);
    });
  }
  return [...byT.values()].filter((b) => b.spot > 0).sort((x, y) => x.t - y.t);
}

// ---------------- strategy ----------------
export interface Params { target: number; stop: number; maxBars: number; costPts: number; itm: number; entryFrom: string; entryTo: string; maxTrades: number; stopAfterWin: boolean; useEmaFilter: boolean }
export const DEFAULT: Params = { target: 20, stop: 10, maxBars: 6, costPts: 2.73, itm: 0, entryFrom: "09:30", entryTo: "14:00", maxTrades: 2, stopAfterWin: true, useEmaFilter: true };
export interface Trade { day: string; side: "CE" | "PE"; strike: number; signalT: number; entryT: number; entry: number; exitT: number; exit: number; why: "TARGET" | "STOP" | "TIME" | "EOD"; gross: number; net: number }

const ema = (vals: number[], p: number) => { const k = 2 / (p + 1); const out: number[] = []; let e = vals[0]; vals.forEach((v, i) => { e = i ? v * k + e * (1 - k) : v; out.push(e); }); return out; };

/** Opening-range breakout on spot (09:15–09:25 closes), EMA 9/21 trend filter, ATM (or ITM) option, fixed target/stop/time. */
export function simulate(bars: Bar[], p: Params = DEFAULT): Trade[] {
  const trades: Trade[] = [];
  const e9 = ema(bars.map((b) => b.spot), 9), e21 = ema(bars.map((b) => b.spot), 21);
  const days = new Map<string, number[]>(); bars.forEach((b, i) => { const d = istDay(b.t); (days.get(d) || days.set(d, []).get(d)!).push(i); });
  for (const [day, idx] of days) {
    const or = idx.filter((i) => istHm(bars[i].t) < "09:30").map((i) => bars[i].spot);
    if (or.length < 3) continue;
    const orH = Math.max(...or), orL = Math.min(...or);
    let n = 0, i0 = 0;
    for (let q = 0; q < idx.length; q++) {
      const i = idx[q]; if (q < i0) continue;
      const hm = istHm(bars[i].t); if (hm < p.entryFrom || hm > p.entryTo || n >= p.maxTrades) continue;
      const s = bars[i].spot, up = s > orH && (!p.useEmaFilter || e9[i] > e21[i]), dn = s < orL && (!p.useEmaFilter || e9[i] < e21[i]);
      if (!up && !dn) continue;
      const side: "CE" | "PE" = up ? "CE" : "PE";
      const atm = Math.round(s / 50) * 50, strike = side === "CE" ? atm - p.itm * 50 : atm + p.itm * 50;
      const eq = q + 1; if (eq >= idx.length) break;
      const leg0 = bars[idx[eq]].legs.get(`${strike}${side}`); if (!leg0) continue;    // strike not in the ATM±3 data at entry
      const entry = leg0.o; let exit = leg0.c, exitQ = eq, why: Trade["why"] = "EOD";
      for (let r = eq; r < idx.length; r++) {
        const L = bars[idx[r]].legs.get(`${strike}${side}`);
        if (!L) { exitQ = r - 1; why = "EOD"; break; }                                  // left the data window: exit at last close
        if (L.l <= entry - p.stop) { exit = entry - p.stop; exitQ = r; why = "STOP"; break; }   // stop first if both
        if (L.h >= entry + p.target) { exit = entry + p.target; exitQ = r; why = "TARGET"; break; }
        exit = L.c; exitQ = r;
        if (r - eq + 1 >= p.maxBars) { why = "TIME"; break; }
        if (istHm(bars[idx[r]].t) >= "15:15") { why = "EOD"; break; }
      }
      const gross = Math.round((exit - entry) * 100) / 100;
      trades.push({ day, side, strike, signalT: bars[i].t, entryT: bars[idx[eq]].t, entry, exitT: bars[idx[Math.max(eq, exitQ)]].t, exit, why, gross, net: Math.round((gross - p.costPts) * 100) / 100 });
      n++; i0 = Math.max(eq, exitQ) + 1;
      if (p.stopAfterWin && why === "TARGET") break;
    }
  }
  return trades;
}

export function summarize(trades: Trade[], tradingDays: number) {
  const byDay = new Map<string, number>(); trades.forEach((t) => byDay.set(t.day, (byDay.get(t.day) || 0) + t.net));
  const dayVals = [...byDay.values()];
  let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const t of trades) { eq += t.net; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); streak = t.net < 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
  const wins = trades.filter((t) => t.net > 0).length, r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    tradingDays, daysTraded: byDay.size, trades: trades.length,
    winRate: trades.length ? r2((wins / trades.length) * 100) : 0,
    targetHit: trades.filter((t) => t.why === "TARGET").length,
    daysPlus20: dayVals.filter((v) => v >= 20).length, daysPositive: dayVals.filter((v) => v > 0).length, daysNegative: dayVals.filter((v) => v < 0).length,
    pctAllDaysPlus20: tradingDays ? r2((dayVals.filter((v) => v >= 20).length / tradingDays) * 100) : 0,
    avgNetPerTrade: trades.length ? r2(trades.reduce((a, t) => a + t.net, 0) / trades.length) : 0,
    totalNet: r2(trades.reduce((a, t) => a + t.net, 0)), maxDrawdown: r2(dd), worstLosingStreak: worst,
    bestDay: dayVals.length ? r2(Math.max(...dayVals)) : 0, worstDay: dayVals.length ? r2(Math.min(...dayVals)) : 0,
  };
}
