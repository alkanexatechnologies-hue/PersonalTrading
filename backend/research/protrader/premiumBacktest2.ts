// ProTrader premium backtest #2 — four pre-registered tests on the same ~2 years of real Dhan premiums (see RESULTS2.md).
// T1 no entries from 14:00 · T2 no entries on the index's own expiry day · T3a retest entry · T3b wider stop · T4 sweep entry.
import * as fs from "fs";
import * as TV from "../../premium/traderView";
import * as LB from "../../premium/levelBreak";
import { atr } from "../../indicators";
import { assemble, DayData, Min } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
const IST = 19800, mn = (t: number) => Math.floor(((t + IST) % 86400) / 60);
const COST = (p: number) => Math.max(0.5, 0.0025 * p);
const IDX = { NIFTY: { step: 50, lot: 75 }, SENSEX: { step: 100, lot: 20 } } as const;
export type Cfg = { name: string; range: boolean; cutoff: number; skipExpiry: boolean; entry: "plan" | "retest" | "sweep"; wideStop: boolean };
const BASE: Cfg = { name: "B_live", range: true, cutoff: 885, skipExpiry: false, entry: "plan", wideStop: false };
const CFGS: Cfg[] = [
  BASE,
  { ...BASE, name: "T1_no_entry_14:00", cutoff: 839 },
  { ...BASE, name: "T2_skip_expiry_day", skipExpiry: true },
  { ...BASE, name: "T3a_retest_entry", entry: "retest" },
  { ...BASE, name: "T3b_wider_stop", wideStop: true },
  { ...BASE, name: "T4_sweep_entry", entry: "sweep", range: false, cutoff: 839 },
  { ...BASE, name: "T1+T2", cutoff: 839, skipExpiry: true },
];
const barsOf = (minutes: [number, number][], step: number): Bar[] => { const out: Bar[] = []; let cur: Bar | null = null, key = -1; for (const [t, p] of minutes) { const k = Math.floor((mn(t) - 555) / step); if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (mn(t) - 555 - k * step) * 60, open: p, high: p, low: p, close: p, volume: 0 }; key = k; } else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } } if (cur) out.push(cur); return out; };
const premAt = (leg: Min[] | undefined, t: number) => { if (!leg?.length) return null; let v: number | null = null; for (const m of leg) { if (m.t > t) break; v = m.c; } return v; };

/** Expiry days read from the data: the ATM straddle at the last minute collapses (< 35% of the index's median close straddle). */
function expiryDays(days: DayData[], step: number) {
  const st = days.map((d) => { const ms = [...d.spot.entries()].sort((a, b) => a[0] - b[0]); const last = ms.filter(([t]) => mn(t) <= 925).pop(); if (!last) return null; const k = Math.round(last[1] / step) * step; const ce = premAt(d.legs.get(`${k}CE`), last[0]), pe = premAt(d.legs.get(`${k}PE`), last[0]); return ce != null && pe != null ? ce + pe : null; });
  const med = [...st.filter((x): x is number => x != null)].sort((a, b) => a - b)[Math.floor(st.filter((x) => x != null).length / 2)];
  return new Set(days.filter((_, i) => st[i] != null && st[i]! < 0.35 * med).map((d) => d.day));
}

export function run(cfgs = CFGS) {
  const data: Record<string, DayData[]> = { NIFTY: assemble("2024-10-01", "2026-10-16").days, SENSEX: assembleIndex("SENSEX", "2024-10-01", "2026-10-16") };
  const trades: any[] = [], expiries: Record<string, string[]> = {};
  for (const name of ["NIFTY", "SENSEX"] as const) {
    const { step, lot } = IDX[name], days = data[name].filter((d) => d.spot.size >= 300), exp = expiryDays(days, step); expiries[name] = [...exp];
    const mins = days.map((d) => [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][]);
    const b15 = mins.map((m) => barsOf(m, 15)), b5 = mins.map((m) => barsOf(m, 5)), daily: Bar[] = mins.map((m) => ({ time: m[0][0], open: m[0][1], high: Math.max(...m.map((x) => x[1])), low: Math.min(...m.map((x) => x[1])), close: m[m.length - 1][1], volume: 0 }));
    const all15: Bar[] = [], atrAt: number[] = [];
    for (let i = 0; i < days.length; i++) { atrAt.push(((atr(all15 as any, 14) as any[]).filter((x) => x != null).slice(-1)[0]) ?? NaN); all15.push(...b15[i]); }
    for (let i = 10; i < days.length; i++) {
      const D = days[i].day, a = atrAt[i]; if (!Number.isFinite(a)) continue;
      const p15 = ([] as Bar[]).concat(...b15.slice(Math.max(0, i - 15), i)), dly = daily.slice(0, i);
      const l15 = TV.activeLines(p15 as any, 3), lD = TV.activeLines(dly as any, 2);
      const lines = [l15.seller && !l15.seller.broken ? { label: "15m seller trendline", value: l15.seller.next } : null, l15.buyer && !l15.buyer.broken ? { label: "15m buyer trendline", value: l15.buyer.next } : null, lD.seller && !lD.seller.broken ? { label: "Daily seller trendline", value: lD.seller.next } : null, lD.buyer && !lD.buyer.broken ? { label: "Daily buyer trendline", value: lD.buyer.next } : null].filter(Boolean) as any[];
      const lad = (ref: number) => TV.ladder({ daily: dly as any, sessionDay: D, today: { high: null, low: null }, lines, chain: [], spot: ref, atr: a }).filter((x) => x.kind !== "TODAY");
      const mk = (ref: number) => TV.plans({ levels: lad(ref), spot: ref, ref, atr: a, chain: [], expiry: null, events: [] });
      const B = b15[i], B5 = b5[i], M = mins[i], pc = dly[dly.length - 1].close, open = { price: B[0].open, time: B[0].time };
      const fh = B.filter((c) => mn(c.time) < 615), br = LB.detectBreaks(fh as any, lad(B[0].open), a);
      const rangeAt = br.some((e) => e.dir === "UP") && br.some((e) => e.dir === "DOWN") ? 615 : null;
      // ---- plan signals (live forward-only plan)
      let st = TV.planInit(pc, mk); const seen = new Set<string>(), planSig: any[] = [];
      for (let j = 0; j < B.length; j++) {
        st = TV.planStep(st, { open, candles: B.slice(0, j + 1), mk });
        const mc = mn(B[j].time) + 15; if (mc < 570 || mc > 885) continue;
        for (const [p, s] of [[st.pb.bull, 1], [st.pb.bear, -1]] as const) {
          if (!p || B[j].time <= (st.since ?? 0)) continue;
          if (st.pb.bull && st.pb.bear && st.pb.bear.entry >= st.pb.bull.entry) continue;
          const c = B[j].close, pv = j ? B[j - 1].close : B[0].open;
          if (s * (c - p.entry) < 0 || s * (pv - p.entry) >= 0) continue;
          const key = s + ":" + Math.round(p.trigger); if (seen.has(key)) continue; seen.add(key);
          planSig.push({ m: mc, t: B[j].time + 900, s, entryIdx: c, trigger: p.trigger, stop: p.stop, t1: p.t1, t2: p.t2, missed: s * (c - p.t1) >= 0, stopTf: 15 });
        }
      }
      // ---- sweep signals (T4): a 5-min candle trades through a ladder level and closes back inside
      const sweepSig: any[] = [];
      if (cfgs.some((c) => c.entry === "sweep")) {
        const lv = lad(pc), used = new Set<string>();
        for (const c of B5) {
          const m = mn(c.time) + 5; if (m < 570 || m > 839) continue;
          for (const l of lv) {
            const tol = 0.05 * a;
            const bull = c.low < l.price - tol && c.close > l.price && c.open > l.price - a, bear = c.high > l.price + tol && c.close < l.price && c.open < l.price + a;
            if (!bull && !bear) continue;
            const s = bull ? 1 : -1, key = s + ":" + Math.round(l.price); if (used.has(key)) continue; used.add(key);
            const beyond = lv.filter((x) => s * (x.price - c.close) >= 0.5 * a).sort((x, y) => s * (x.price - y.price));
            const t1 = beyond[0]?.price ?? c.close + s * a, t2 = beyond.find((x) => s * (x.price - t1) >= 0.5 * a)?.price ?? null;
            sweepSig.push({ m, t: c.time + 300, s, entryIdx: c.close, trigger: l.price, stop: s > 0 ? c.low - 0.1 * a : c.high + 0.1 * a, t1, t2, missed: false, stopTf: 5 });
          }
        }
      }
      for (const cfg of cfgs) {
        if (cfg.skipExpiry && exp.has(D)) { trades.push({ cfg: cfg.name, idx: name, day: D, i, n: days.length, res: "EXPIRY-SKIP" }); continue; }
        let freeAt = 0;
        const sigs = (cfg.entry === "sweep" ? sweepSig : planSig).slice().sort((x, y) => x.m - y.m);
        for (const g0 of sigs) {
          let g = { ...g0 };
          if (g.missed) { trades.push({ cfg: cfg.name, idx: name, day: D, i, n: days.length, res: "MISSED" }); continue; }
          if (cfg.entry === "retest") {   // wait ≤ 30 min for a pullback to the broken level that a 5-min close holds
            const r = B5.find((c) => c.time >= g.t && c.time < g.t + 1800 && (g.s > 0 ? c.low <= g.trigger + 0.25 * a : c.high >= g.trigger - 0.25 * a) && g.s * (c.close - g.trigger) > 0);
            if (!r) { trades.push({ cfg: cfg.name, idx: name, day: D, i, n: days.length, res: "NO-RETEST" }); continue; }
            g = { ...g, t: r.time + 300, m: mn(r.time) + 5, entryIdx: r.close };
          }
          if (cfg.wideStop) g.stop = g.trigger - g.s * 0.75 * a;
          if (g.m < freeAt || g.m > cfg.cutoff) continue;
          if (cfg.range && rangeAt != null && g.m > rangeAt) { trades.push({ cfg: cfg.name, idx: name, day: D, i, n: days.length, res: "RANGE-SKIP" }); continue; }
          const strike = Math.round(g.entryIdx / step) * step, leg = days[i].legs.get(`${strike}${g.s > 0 ? "CE" : "PE"}`), e0 = premAt(leg, g.t);
          if (e0 == null || e0 <= 0) { trades.push({ cfg: cfg.name, idx: name, day: D, i, n: days.length, res: "NO-PREMIUM" }); continue; }
          let state = "OPEN", halfP: number | null = null, exitP: number | null = null, endT = 912;
          for (const [t, px] of M) {
            if (t < g.t) continue; const m = mn(t);
            if (m >= 912) { exitP = premAt(leg, t); break; }
            if (state === "OPEN" && g.s * (px - g.t1) >= 0) { state = "T1"; halfP = premAt(leg, t); }
            if (state === "T1" && g.t2 != null && g.s * (px - g.t2) >= 0) { state = "T2"; exitP = premAt(leg, t); endT = m; break; }
            if ((m + 1) % g.stopTf === 0) { const sl = state === "T1" ? g.entryIdx : g.stop; if (g.s * (px - sl) < 0) { state = state === "T1" ? "T1+BE" : "SL"; exitP = premAt(leg, t); endT = m; break; } }
          }
          if (exitP == null) exitP = premAt(leg, M[M.length - 1][0]) ?? e0;
          if (state === "OPEN") state = "TIME"; else if (state === "T1") state = "T1+TIME";
          const gross = halfP != null ? 0.5 * (halfP - e0) + 0.5 * (exitP - e0) : exitP - e0;
          const net = gross - COST(e0) - (halfP != null ? 0.5 * COST(halfP) + 0.5 * COST(exitP) : COST(exitP)) - 40 / lot;
          trades.push({ cfg: cfg.name, idx: name, day: D, i, n: days.length, time: g.m, side: g.s, res: state, net: Math.round(net * 100) / 100, pct: Math.round((net / e0) * 1000) / 10, rs: Math.round(net * lot), exp: exp.has(D) });
          freeAt = endT + 15;
        }
      }
    }
  }
  return { trades, expiries };
}
if (require.main === module) { const r = run(); if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(r)); console.log("rows", r.trades.length, "expiry days", Object.entries(r.expiries).map(([k, v]) => k + ":" + v.length + " (e.g. " + v.slice(-4).join(",") + ")").join(" | ")); }
