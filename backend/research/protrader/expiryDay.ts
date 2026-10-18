// ProTrader expiry-day study — option-BUYER strategies for the index's own expiry day, on ~2 years of real Dhan 1-minute
// premiums (rolling-option ATM±3). Rules are fixed in RESULTS_EXPIRY.md before running; choose on DEVELOPMENT (first ⅔ of
// expiry days), judge on VALIDATION (last ⅓). Usage: npx tsx expiryDay.ts [out.json]
import * as fs from "fs";
import * as TV from "../../premium/traderView";
import { atr, ema } from "../../indicators";
import { assemble, DayData, Min } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { barsOf, premAt, expiryDays } from "./premiumBacktest2";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Sig = { m: number; t: number; s: 1 | -1; entryIdx: number; trigger?: number; stop?: number; t1?: number; t2?: number | null };
const IST = 19800, mn = (t: number) => Math.floor(((t + IST) % 86400) / 60);
const COST = (p: number) => Math.max(0.5, 0.0025 * p);
const IDX = { NIFTY: { step: 50, lot: 75 }, SENSEX: { step: 100, lot: 20 } } as const;
export type Mgmt = "normal" | "expiry";
export type XCfg = { name: string; entry: "plan" | "plan-retest" | "orb" | "ema" | "pm-break"; mgmt: Mgmt; strike: 0 | 1; maxTrades: number; stopPct?: number; halfX?: number; fullX?: number; timeMin?: number };
export const XCFGS: XCfg[] = [
  { name: "X0_plan_normal", entry: "plan", mgmt: "normal", strike: 0, maxTrades: 9 },
  { name: "X1_plan+retest_normal", entry: "plan-retest", mgmt: "normal", strike: 0, maxTrades: 9 },
  { name: "X2_plan+retest_expiryMgmt", entry: "plan-retest", mgmt: "expiry", strike: 0, maxTrades: 2 },
  { name: "X3_ORB15_expiryMgmt", entry: "orb", mgmt: "expiry", strike: 0, maxTrades: 1 },
  { name: "X4_EMA20_pullback_expiryMgmt", entry: "ema", mgmt: "expiry", strike: 0, maxTrades: 2 },
  { name: "X5_PM_dayHL_break_expiryMgmt", entry: "pm-break", mgmt: "expiry", strike: 0, maxTrades: 1 },
];
const leg1 = (leg: Min[] | undefined, t: number) => leg?.find((x) => x.t === t) ?? null;

/** Expiry management on the PREMIUM: −30% stop · half at 1.5× · then stop at entry · rest at 2.5× · 40-min time stop if 1.5× not reached · out by 15:15. */
function manageExpiry(leg: Min[], t0: number, e0: number, o: { stopPct?: number; halfX?: number; fullX?: number; timeMin?: number } = {}) {
  const SL = 1 - (o.stopPct ?? 0.3), HX = o.halfX ?? 1.5, FX = o.fullX ?? 2.5, TM = o.timeMin ?? 40;
  let half: number | null = null, exit: number | null = null, res = "OPEN", end = t0;
  for (const m of leg) {
    if (m.t <= t0) continue; end = m.t;
    if (mn(m.t) >= 915) { exit = m.c; res = half != null ? "HALF+TIME" : "TIME 15:15"; break; }
    if (half == null) {
      if (m.l <= SL * e0) { exit = SL * e0; res = "PREM SL"; break; }          // adverse first (conservative)
      if (m.h >= HX * e0) { half = HX * e0; res = "HALF"; }
      else if (m.t - t0 >= TM * 60) { exit = m.c; res = "TIME STOP"; break; }
    }
    if (half != null) {
      if (m.l <= e0) { exit = e0; res = "HALF+BE"; break; }
      if (m.h >= FX * e0) { exit = FX * e0; res = "HALF+FULL"; break; }
    }
  }
  if (exit == null) { exit = leg[leg.length - 1]?.c ?? e0; res = half != null ? "HALF+TIME" : "TIME 15:15"; }
  return { half, exit, res, end };
}
/** The co-pilot's normal management on the INDEX: T1 = half + stop to entry · T2 · 15-min close stop · 15:12. */
function manageNormal(leg: Min[], M: [number, number][], g: Sig) {
  let state = "OPEN", half: number | null = null, exit: number | null = null, end = g.t;
  for (const [t, px] of M) {
    if (t < g.t) continue; const m = mn(t); end = t;
    if (m >= 912) { exit = premAt(leg, t); break; }
    if (state === "OPEN" && g.s * (px - g.t1!) >= 0) { state = "T1"; half = premAt(leg, t); }
    if (state === "T1" && g.t2 != null && g.s * (px - g.t2) >= 0) { state = "T2"; exit = premAt(leg, t); break; }
    if ((m + 1) % 15 === 0) { const sl = state === "T1" ? g.entryIdx : g.stop!; if (g.s * (px - sl) < 0) { state = state === "T1" ? "T1+BE" : "SL"; exit = premAt(leg, t); break; } }
  }
  if (state === "OPEN") state = "TIME"; else if (state === "T1") state = "T1+TIME";
  return { half, exit: exit ?? leg[leg.length - 1]?.c ?? 0, res: state, end };
}

export function run(cfgs = XCFGS) {
  const data: Record<string, DayData[]> = { NIFTY: assemble("2024-10-01", "2026-10-16").days, SENSEX: assembleIndex("SENSEX", "2024-10-01", "2026-10-16") };
  const trades: any[] = [];
  for (const name of ["NIFTY", "SENSEX"] as const) {
    const { step, lot } = IDX[name], days = data[name].filter((d) => d.spot.size >= 300), exp = expiryDays(days, step);
    const mins = days.map((d) => [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][]);
    const b15 = mins.map((m) => barsOf(m, 15)), b5 = mins.map((m) => barsOf(m, 5));
    const daily: Bar[] = mins.map((m) => ({ time: m[0][0], open: m[0][1], high: Math.max(...m.map((x) => x[1])), low: Math.min(...m.map((x) => x[1])), close: m[m.length - 1][1], volume: 0 }));
    const all15: Bar[] = [], atrAt: number[] = [];
    for (let i = 0; i < days.length; i++) { atrAt.push(((atr(all15 as any, 14) as any[]).filter((x) => x != null).slice(-1)[0]) ?? NaN); all15.push(...b15[i]); }
    const expIdx = days.map((d, i) => (exp.has(d.day) ? i : -1)).filter((i) => i >= 10), cutDay = expIdx[Math.floor((expIdx.length * 2) / 3)];
    for (const i of expIdx) {
      const D = days[i].day, a = atrAt[i]; if (!Number.isFinite(a)) continue;
      const B = b15[i], B5 = b5[i], M = mins[i], dly = daily.slice(0, i), pc = dly[dly.length - 1].close, open = { price: B[0].open, time: B[0].time };
      const sigs: Record<string, Sig[]> = {};
      // ---- plan signals (live plan, forward-only), with and without the retest
      const p15 = ([] as Bar[]).concat(...b15.slice(Math.max(0, i - 15), i)), l15 = TV.activeLines(p15 as any, 3), lD = TV.activeLines(dly as any, 2);
      const lines = [l15.seller && !l15.seller.broken ? { label: "15m seller trendline", value: l15.seller.next } : null, l15.buyer && !l15.buyer.broken ? { label: "15m buyer trendline", value: l15.buyer.next } : null, lD.seller && !lD.seller.broken ? { label: "Daily seller trendline", value: lD.seller.next } : null, lD.buyer && !lD.buyer.broken ? { label: "Daily buyer trendline", value: lD.buyer.next } : null].filter(Boolean) as any[];
      const lad = (ref: number) => TV.ladder({ daily: dly as any, sessionDay: D, today: { high: null, low: null }, lines, chain: [], spot: ref, atr: a }).filter((x) => x.kind !== "TODAY");
      const mk = (ref: number) => TV.plans({ levels: lad(ref), spot: ref, ref, atr: a, chain: [], expiry: null, events: [] });
      let st = TV.planInit(pc, mk); const seen = new Set<string>(); sigs.plan = []; sigs["plan-retest"] = [];
      for (let j = 0; j < B.length; j++) {
        st = TV.planStep(st, { open, candles: B.slice(0, j + 1), mk });
        const mc = mn(B[j].time) + 15; if (mc < 570 || mc > 885) continue;
        for (const [p, s] of [[st.pb.bull, 1], [st.pb.bear, -1]] as const) {
          if (!p || B[j].time <= (st.since ?? 0) || (st.pb.bull && st.pb.bear && st.pb.bear.entry >= st.pb.bull.entry)) continue;
          const c = B[j].close, pv = j ? B[j - 1].close : B[0].open;
          if (s * (c - p.entry) < 0 || s * (pv - p.entry) >= 0) continue;
          const key = s + ":" + Math.round(p.trigger); if (seen.has(key)) continue; seen.add(key);
          if (s * (c - p.t1) >= 0) continue;   // MISSED
          const g: Sig = { m: mc, t: B[j].time + 900, s, entryIdx: c, trigger: p.trigger, stop: p.stop, t1: p.t1, t2: p.t2 };
          sigs.plan.push(g);
          const r = B5.find((x) => x.time >= g.t && x.time < g.t + 1800 && (s > 0 ? x.low <= p.trigger + 0.25 * a : x.high >= p.trigger - 0.25 * a) && s * (x.close - p.trigger) > 0);
          if (r) sigs["plan-retest"].push({ ...g, t: r.time + 300, m: mn(r.time) + 5, entryIdx: r.close });
        }
      }
      // ---- X3 opening range (first 15 min): first 5-min CLOSE beyond its high / low, 09:30–11:00
      const orH = B[0].high, orL = B[0].low; sigs.orb = [];
      for (const x of B5) { const m = mn(x.time) + 5; if (m < 570 || m > 660) continue; if (x.close > orH) { sigs.orb.push({ m, t: x.time + 300, s: 1, entryIdx: x.close }); break; } if (x.close < orL) { sigs.orb.push({ m, t: x.time + 300, s: -1, entryIdx: x.close }); break; } }
      // ---- X4 trend pullback to the 5-min EMA20 (10:30–13:30): trend = price vs open and EMA slope; touch within 0.15 ATR, close with the trend
      const e20 = ema(B5.map((x) => x.close), 20) as (number | null)[]; sigs.ema = [];
      for (let k = 21; k < B5.length; k++) {
        const x = B5[k], m = mn(x.time) + 5, e = e20[k], e5 = e20[k - 5]; if (m < 630 || m > 810 || e == null || e5 == null) continue;
        const up = x.close > open.price && e > e5, dn = x.close < open.price && e < e5;
        if (up && x.low <= e + 0.15 * a && x.close > e) sigs.ema.push({ m, t: x.time + 300, s: 1, entryIdx: x.close });
        else if (dn && x.high >= e - 0.15 * a && x.close < e) sigs.ema.push({ m, t: x.time + 300, s: -1, entryIdx: x.close });
      }
      // ---- X5 afternoon break of the day's high / low on a 15-min close (13:00–14:30)
      sigs["pm-break"] = [];
      for (let j = 1; j < B.length; j++) { const mc = mn(B[j].time) + 15; if (mc < 780 || mc > 870) continue; const hi = Math.max(...B.slice(0, j).map((x) => x.high)), lo = Math.min(...B.slice(0, j).map((x) => x.low)); if (B[j].close > hi) { sigs["pm-break"].push({ m: mc, t: B[j].time + 900, s: 1, entryIdx: B[j].close }); break; } if (B[j].close < lo) { sigs["pm-break"].push({ m: mc, t: B[j].time + 900, s: -1, entryIdx: B[j].close }); break; } }
      // ---- trades
      for (const cfg of cfgs) {
        let freeAt = 0, nT = 0;
        for (const g of (sigs[cfg.entry] || []).slice().sort((x, y) => x.m - y.m)) {
          if (nT >= cfg.maxTrades || g.t < freeAt) continue;
          const strike = Math.round(g.entryIdx / step) * step - g.s * cfg.strike * step;   // strike 1 = one step in the money
          const leg = days[i].legs.get(`${strike}${g.s > 0 ? "CE" : "PE"}`), e0 = premAt(leg, g.t);
          if (!leg || e0 == null || e0 <= 0.5) { trades.push({ cfg: cfg.name, idx: name, day: D, dev: i < cutDay, res: "NO-PREMIUM" }); continue; }
          const r = cfg.mgmt === "expiry" ? manageExpiry(leg, g.t, e0, cfg) : manageNormal(leg, M, g);
          const gross = r.half != null ? 0.5 * (r.half - e0) + 0.5 * (r.exit - e0) : r.exit - e0;
          const net = gross - COST(e0) - (r.half != null ? 0.5 * COST(r.half) + 0.5 * COST(r.exit) : COST(r.exit)) - 40 / lot;
          trades.push({ cfg: cfg.name, idx: name, day: D, dev: i < cutDay, time: g.m, side: g.s, res: r.res, e0: Math.round(e0 * 10) / 10, net: Math.round(net * 100) / 100, pct: Math.round((net / e0) * 1000) / 10, rs: Math.round(net * lot) });
          freeAt = r.end + 300; nT++;
        }
      }
    }
  }
  return trades;
}
if (require.main === module) { const t = run(); if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(t)); console.log("rows", t.length); }
