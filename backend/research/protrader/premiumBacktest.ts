// ProTrader premium backtest — the LIVE plan code (planInit / planStep, plans, ladder, levelBreak) replayed on ~2 years of
// real Dhan 1-minute data (rolling-option ATM±3 premiums + spot), with the co-pilot's exact trade rules and REAL option
// premium P&L after costs. Rules are fixed in RESULTS.md before running. Usage: npx tsx premiumBacktest.ts [out.json]
import * as fs from "fs";
import * as TV from "../../premium/traderView";
import * as LB from "../../premium/levelBreak";
import { atr } from "../../indicators";
import { assemble, DayData, Min } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
const IST = 19800, mn = (t: number) => Math.floor(((t + IST) % 86400) / 60);
const COST = (prem: number) => Math.max(0.5, 0.0025 * prem);   // slippage per side, per unit
const IDX = { NIFTY: { step: 50, lot: 75 }, SENSEX: { step: 100, lot: 20 } } as const;
type Cfg = { name: string; range: boolean; premStop: number | null };
const CFGS: Cfg[] = [{ name: "A_before_today", range: false, premStop: null }, { name: "B_live_today", range: true, premStop: null }, { name: "C_live+premStop30", range: true, premStop: 0.7 }];

function bars(minutes: [number, number][], step: number): Bar[] {
  const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const [t, p] of minutes) { const k = Math.floor((mn(t) - 555) / step); if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (mn(t) - 555 - k * step) * 60, open: p, high: p, low: p, close: p, volume: 0 }; key = k; } else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out;
}
const premAt = (leg: Min[] | undefined, t: number) => { if (!leg?.length) return null; let v: number | null = null; for (const m of leg) { if (m.t > t) break; v = m.c; } return v; };

export function run() {
  const data: Record<string, DayData[]> = { NIFTY: assemble(FROM, latestRawDay()).days, SENSEX: assembleIndex("SENSEX", FROM, latestRawDay()) };
  const trades: any[] = [];
  for (const name of ["NIFTY", "SENSEX"] as const) {
    const { step, lot } = IDX[name], days = data[name].filter((d) => d.spot.size >= 300);
    const mins = days.map((d) => [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][]);
    const b15 = mins.map((m) => bars(m, 15)), daily: Bar[] = mins.map((m) => ({ time: m[0][0], open: m[0][1], high: Math.max(...m.map((x) => x[1])), low: Math.min(...m.map((x) => x[1])), close: m[m.length - 1][1], volume: 0 }));
    const all15: Bar[] = [], atrAt: number[] = [];
    for (let i = 0; i < days.length; i++) { const a = (atr(all15 as any, 14) as any[]).filter((x) => x != null).slice(-1)[0]; atrAt.push(a ?? NaN); all15.push(...b15[i]); }
    for (let i = 10; i < days.length; i++) {
      const D = days[i].day, a = atrAt[i]; if (!Number.isFinite(a)) continue;
      const p15 = ([] as Bar[]).concat(...b15.slice(Math.max(0, i - 15), i)), dly = daily.slice(0, i);
      const l15 = TV.activeLines(p15 as any, 3), lD = TV.activeLines(dly as any, 2);
      const lines = [l15.seller && !l15.seller.broken ? { label: "15m seller trendline", value: l15.seller.next } : null, l15.buyer && !l15.buyer.broken ? { label: "15m buyer trendline", value: l15.buyer.next } : null, lD.seller && !lD.seller.broken ? { label: "Daily seller trendline", value: lD.seller.next } : null, lD.buyer && !lD.buyer.broken ? { label: "Daily buyer trendline", value: lD.buyer.next } : null].filter(Boolean) as any[];
      const lad = (ref: number) => TV.ladder({ daily: dly as any, sessionDay: D, today: { high: null, low: null }, lines, chain: [], spot: ref, atr: a }).filter((x) => x.kind !== "TODAY");
      const mk = (ref: number) => TV.plans({ levels: lad(ref), spot: ref, ref, atr: a, chain: [], expiry: null, events: [] });
      const B = b15[i], M = mins[i], pc = dly[dly.length - 1].close, open = { price: B[0].open, time: B[0].time };
      // range day at 10:15 (approved P2): first-hour 15-min breaks of a level both UP and DOWN
      const fh = B.filter((c) => mn(c.time) < 615), br = LB.detectBreaks(fh as any, lad(B[0].open), a);
      const rangeAt = br.some((e) => e.dir === "UP") && br.some((e) => e.dir === "DOWN") ? 615 : null;
      // signals from the live forward-only plan
      let st = TV.planInit(pc, mk); const seen = new Set<string>(), sig: any[] = [];
      for (let j = 0; j < B.length; j++) {
        st = TV.planStep(st, { open, candles: B.slice(0, j + 1), mk });
        const mc = mn(B[j].time) + 15; if (mc < 570 || mc > 885) continue;
        for (const [p, s] of [[st.pb.bull, 1], [st.pb.bear, -1]] as const) {
          if (!p || B[j].time <= (st.since ?? 0)) continue;
          if (st.pb.bull && st.pb.bear && st.pb.bear.entry >= st.pb.bull.entry) continue;   // conflict → stand aside
          const c = B[j].close, pv = j ? B[j - 1].close : B[0].open;
          if (s * (c - p.entry) < 0 || s * (pv - p.entry) >= 0) continue;
          const key = s + ":" + Math.round(p.trigger); if (seen.has(key)) continue; seen.add(key);
          sig.push({ m: mc, t: B[j].time + 900, s, entryIdx: c, stop: p.stop, t1: p.t1, t2: p.t2, label: p.triggerLabel, missed: s * (c - p.t1) >= 0 });
        }
      }
      for (const cfg of CFGS) {
        let freeAt = 0;
        for (const g of sig) {
          if (g.missed) { trades.push({ cfg: cfg.name, idx: name, day: D, i, time: g.m, side: g.s, res: "MISSED" }); continue; }
          if (g.m < freeAt) continue;
          if (cfg.range && rangeAt != null && g.m > rangeAt) { trades.push({ cfg: cfg.name, idx: name, day: D, i, time: g.m, side: g.s, res: "RANGE-SKIP" }); continue; }
          const strike = Math.round(g.entryIdx / step) * step, leg = days[i].legs.get(`${strike}${g.s > 0 ? "CE" : "PE"}`);
          const e0 = premAt(leg, g.t); if (e0 == null || e0 <= 0) { trades.push({ cfg: cfg.name, idx: name, day: D, i, time: g.m, side: g.s, res: "NO-PREMIUM" }); continue; }
          let state = "OPEN", halfP: number | null = null, exitP: number | null = null, exitIdx: number | null = null, endT = 912;
          for (const [t, px] of M) {
            if (t < g.t) continue; const m = mn(t);
            if (m >= 912) { exitP = premAt(leg, t); exitIdx = px; break; }
            const lp = leg!.find((x) => x.t === t);
            if (cfg.premStop && state === "OPEN" && lp && lp.l <= cfg.premStop * e0) { state = "PREM-SL"; exitP = cfg.premStop * e0; exitIdx = px; endT = m; break; }
            if (state === "OPEN" && g.s * (px - g.t1) >= 0) { state = "T1"; halfP = premAt(leg, t); }
            if (state === "T1" && g.t2 != null && g.s * (px - g.t2) >= 0) { state = "T2"; exitP = premAt(leg, t); exitIdx = px; endT = m; break; }
            if ((m + 1) % 15 === 0) {   // a 15-min close
              const sl = state === "T1" ? g.entryIdx : g.stop;
              if (g.s * (px - sl) < 0) { state = state === "T1" ? "T1+BE" : "SL"; exitP = premAt(leg, t); exitIdx = px; endT = m; break; }
            }
          }
          if (exitP == null) { exitP = premAt(leg, M[M.length - 1][0]) ?? e0; exitIdx = M[M.length - 1][1]; }
          if (state === "OPEN") state = "TIME"; else if (state === "T1") state = "T1+TIME";
          const gross = halfP != null ? 0.5 * (halfP - e0) + 0.5 * (exitP - e0) : exitP - e0;
          const net = gross - COST(e0) - (halfP != null ? 0.5 * COST(halfP) + 0.5 * COST(exitP) : COST(exitP)) - 40 / lot;
          trades.push({ cfg: cfg.name, idx: name, day: D, i, n: days.length, time: g.m, side: g.s, res: state, strike, e0: Math.round(e0 * 100) / 100, net: Math.round(net * 100) / 100, pct: Math.round((net / e0) * 1000) / 10, rs: Math.round(net * lot), idxPts: Math.round(g.s * ((exitIdx ?? g.entryIdx) - g.entryIdx)) });
          freeAt = endT + 15;
        }
      }
    }
  }
  return trades;
}
if (require.main === module) { const t = run(); if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(t)); console.log("rows", t.length); }
