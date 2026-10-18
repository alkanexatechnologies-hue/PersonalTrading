// ProTrader study: TREND STRUCTURE + LIQUIDITY-SWEEP PULLBACK (owner's trading idea, turned into exact rules — see
// RESULTS_STRUCTURE.md). Replayed on ~2 years of real Dhan 1-minute data with real option premiums after costs.
//  1 Direction: last two confirmed 15-min swings → UP (HH + HL) / DOWN (LH + LL) / none = no trade.
//  2 Sweep: with the trend, a 5-min candle takes the latest confirmed 5-min swing low (high) by > 0.05·ATR5 and CLOSES back
//    above (below) it, while the 15-min structural higher low (lower high) holds → that is the "move-start" candle.
//  3 Entry: price crosses that candle's high (low) within 15 min (S1/S2: the minute it crosses; S3: on a 5-min close beyond).
//  4 Stop: that candle's low (high) − 0.05·ATR5, on touch.
//  5 Target 1 = the latest confirmed 5-min swing high (low) before the pullback, ≥ 0.8× risk away (else skip). At T1 book
//    half, stop → entry, then trail under each new confirmed 5-min higher low (above each lower high). Target 2 = 3× risk.
//  6 Entries 09:45–14:30, max 2 a day per index, one at a time, exit by 15:12.
import * as fs from "fs";
import { confirmedSwings } from "../../premium/premiumCenter";
import { atr, ema } from "../../indicators";
import { assemble, DayData, Min } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { barsOf, premAt, expiryDays } from "./premiumBacktest2";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
const IST = 19800, mn = (t: number) => Math.floor(((t + IST) % 86400) / 60);
const COST = (p: number) => Math.max(0.5, 0.0025 * p);
const IDX = { NIFTY: { step: 50, lot: 75 }, SENSEX: { step: 100, lot: 20 } } as const;
export type SCfg = { name: string; strike: 0 | 1; entry: "cross" | "close"; stopMode?: "candle" | "structure"; emaFilter?: boolean };
export const SCFGS: SCfg[] = [{ name: "S1_ATM_cross", strike: 0, entry: "cross" }, { name: "S2_ITM1_cross", strike: 1, entry: "cross" }, { name: "S3_ATM_close", strike: 0, entry: "close" }];

export function run(cfgs = SCFGS) {
  const data: Record<string, DayData[]> = { NIFTY: assemble("2024-10-01", "2026-10-16").days, SENSEX: assembleIndex("SENSEX", "2024-10-01", "2026-10-16") };
  const trades: any[] = [];
  for (const name of ["NIFTY", "SENSEX"] as const) {
    const { step, lot } = IDX[name], days = data[name].filter((d) => d.spot.size >= 300), exp = expiryDays(days, step);
    const mins = days.map((d) => [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][]);
    const b15 = mins.map((m) => barsOf(m, 15)), b5 = mins.map((m) => barsOf(m, 5));
    const cut = Math.floor(days.length * 2 / 3);
    for (let i = 3; i < days.length; i++) {
      const D = days[i].day, M = mins[i];
      // context = yesterday + today, so the structure exists from the open
      const c15 = [...b15[i - 1], ...b15[i]], c5 = [...b5[i - 1], ...b5[i]], first5 = b5[i - 1].length, first15 = b15[i - 1].length;
      const s15 = confirmedSwings(c15 as any, 2), s5 = confirmedSwings(c5 as any, 2);
      const a5s = atr([...b5[i - 2], ...c5] as any, 14) as (number | null)[], off = b5[i - 2].length;
      // signals: the move-start candle and its levels
      const sig: any[] = [], e15 = ema(c15.map((c) => c.close), 20) as (number | null)[];
      for (let j = first5; j < c5.length; j++) {
        const x = c5[j], m = mn(x.time) + 5; if (m < 585 || m > 870) continue;
        const a = a5s[off + j]; if (a == null) continue;
        const k15 = first15 + Math.floor((mn(x.time) - 555) / 15) - 1;   // last 15-min bar closed before this 5-min bar
        const sw15 = s15.filter((s) => s.index + 2 <= k15), H = sw15.filter((s) => s.kind === "HIGH"), L = sw15.filter((s) => s.kind === "LOW");
        if (H.length < 2 || L.length < 2) continue;
        const up = H[H.length - 1].price > H[H.length - 2].price && L[L.length - 1].price > L[L.length - 2].price;
        const dn = H[H.length - 1].price < H[H.length - 2].price && L[L.length - 1].price < L[L.length - 2].price;
        if (!up && !dn) continue;
        const sw5 = s5.filter((s) => s.index + 2 <= j - 1), lo5 = sw5.filter((s) => s.kind === "LOW").pop(), hi5 = sw5.filter((s) => s.kind === "HIGH").pop();
        const e = e15[k15], e3 = e15[k15 - 3], emaUp = e != null && e3 != null && c15[k15].close > e && e > e3, emaDn = e != null && e3 != null && c15[k15].close < e && e < e3;
        if (up && lo5 && hi5 && x.low < lo5.price - 0.05 * a && x.close > lo5.price && x.low > L[L.length - 1].price) sig.push({ j, s: 1, R: x, a, t1: hi5.price, lvl: lo5.price, struct: L[L.length - 1].price, emaOk: emaUp });
        if (dn && hi5 && lo5 && x.high > hi5.price + 0.05 * a && x.close < hi5.price && x.high < H[H.length - 1].price) sig.push({ j, s: -1, R: x, a, t1: lo5.price, lvl: hi5.price, struct: H[H.length - 1].price, emaOk: emaDn });
      }
      for (const cfg of cfgs) {
        let freeAt = 0, nT = 0;
        for (const g of sig) {
          if (nT >= 2) break;
          if (cfg.emaFilter && !g.emaOk) continue;
          const s = g.s, R = g.R, a = g.a, rEnd = R.time + 300;
          if (rEnd < freeAt) continue;
          // entry: cross of the move-start candle's high (low) within 15 min
          let tE: number | null = null, pE: number | null = null;
          if (cfg.entry === "cross") { for (const [t, px] of M) { if (t < rEnd) continue; if (t >= rEnd + 900) break; if (s * (px - (s > 0 ? R.high : R.low)) > 0) { tE = t; pE = px; break; } } }
          else { for (const y of c5.slice(g.j + 1, g.j + 4)) if (s * (y.close - (s > 0 ? R.high : R.low)) > 0) { tE = y.time + 300; pE = y.close; break; } }
          if (tE == null || pE == null || mn(tE) > 870) continue;
          const stop = cfg.stopMode === "structure" ? g.struct - s * 0.05 * a : s > 0 ? R.low - 0.05 * a : R.high + 0.05 * a, risk = Math.abs(pE - stop);
          if (!(risk > 0) || s * (g.t1 - pE) < 0.8 * risk) { trades.push({ cfg: cfg.name, idx: name, day: D, dev: i < cut, exp: exp.has(D), res: "NO-ROOM" }); continue; }
          const t2 = pE + s * 3 * risk;
          const strike = Math.round(pE / step) * step - s * cfg.strike * step, leg = days[i].legs.get(`${strike}${s > 0 ? "CE" : "PE"}`), e0 = premAt(leg, tE);
          if (!leg || e0 == null || e0 <= 0.5) { trades.push({ cfg: cfg.name, idx: name, day: D, dev: i < cut, exp: exp.has(D), res: "NO-PREMIUM" }); continue; }
          // management on the index (touch), trail under new confirmed 5-min swings after T1
          let st = "OPEN", sl = stop, half: number | null = null, exit: number | null = null, end = tE;
          for (const [t, px] of M) {
            if (t <= tE) continue; end = t;
            if (mn(t) >= 912) { exit = premAt(leg, t); break; }
            if (s * (px - sl) <= 0) { exit = premAt(leg, t); st = st === "OPEN" ? "SL" : st === "T1" ? "T1+TRAIL" : st; break; }
            if (st === "OPEN" && s * (px - g.t1) >= 0) { st = "T1"; half = premAt(leg, t); sl = pE; }
            if (st === "T1") {
              if (s * (px - t2) >= 0) { st = "T2"; exit = premAt(leg, t); break; }
              const jn = c5.findIndex((y) => y.time + 300 > t) - 1;   // last closed 5-min bar
              const tr = s5.filter((w) => w.index + 2 <= jn && w.index > g.j && w.kind === (s > 0 ? "LOW" : "HIGH")).pop();
              if (tr && s * (tr.price - sl) > 0) sl = tr.price;
            }
          }
          if (exit == null) exit = premAt(leg, M[M.length - 1][0]) ?? e0;
          if (st === "OPEN") st = "TIME"; else if (st === "T1") st = "T1+TIME";
          const gross = half != null ? 0.5 * (half - e0) + 0.5 * (exit - e0) : exit - e0;
          const net = gross - COST(e0) - (half != null ? 0.5 * COST(half) + 0.5 * COST(exit) : COST(exit)) - 40 / lot;
          trades.push({ cfg: cfg.name, idx: name, day: D, dev: i < cut, exp: exp.has(D), time: mn(tE), side: s, res: st, e0: Math.round(e0 * 10) / 10, net: Math.round(net * 100) / 100, pct: Math.round((net / e0) * 1000) / 10, rs: Math.round(net * lot), riskPts: Math.round(risk) });
          freeAt = end + 60; nT++;
        }
      }
    }
  }
  return trades;
}
if (require.main === module) { const t = run(); if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(t)); console.log("rows", t.length); }
