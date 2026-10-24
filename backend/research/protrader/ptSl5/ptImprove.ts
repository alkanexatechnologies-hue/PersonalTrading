// ProTrader: improving the PT logic (owner 2026-10-25: "investigate where the issue is and fine-tune the win rate").
// PT entry = the ATM premium EMA 9 crosses its EMA 21 while the index is past its EMA 21 (emaCrossStudy.run, x.pt).
// Diagnosis (last 15 sessions): the ₹5 stop is 0.45 × NIFTY / 0.12 × SENSEX premium ATR (5m) — inside normal noise; 9 of 25
// NIFTY and 12 of 22 SENSEX stopped trades reached +40 later the same day.
// PRE-REGISTERED variants (chosen on DEV by net P&L per trade with the PESSIMISTIC stop fill; then VAL; TEST once):
//   E0  owner's rule: entry at the signal close, SL −₹5, target +₹40
//   S1  SL = max(₹5, 1 × premium ATR14 of 5m), target +₹40
//   S2  SL = max(₹5, 1 × premium ATR), target 3 × that SL      (NIFTY ≈ −13 / +38)
//   S3  SL = max(₹5, 1.5 × premium ATR), target 3 × that SL
//   P1  S2 exits, but a LIMIT entry at the premium EMA 9 (of the signal candle) within 15 min; no fill = no trade
//   filters on S2: F1 no opposite PT signal in the previous 60 min · F2 index ATR < 1.2 × its 100-candle mean ·
//                  F3 signal between 09:30 and 14:30 · F4 the index signal candle closes in the trade direction
// Exits: first 1-min premium high / low touching SL or target (both in one minute = ambiguous = loss), else 15:25.
// Costs: max(₹0.5, 0.25 %) per side + ₹40 per lot. Stop fill: at the stop (best) and at min(stop, minute close) (pessimistic).
// Research only. Usage: npx tsx ptImprove.ts
import { assemble, DayData, Min } from "../../nifty20/data";
import { assembleIndex } from "../../multiIndex/data";
import { FROM, latestRawDay } from "../dataRange";
import { run } from "../emaCrossStudy";
import { expiryDays } from "../premiumBacktest2";

const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60), hmOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(11, 16);
const COST = (p: number) => Math.max(0.5, 0.0025 * p), LOT = { NIFTY: 75, SENSEX: 20 } as const, STEP = { NIFTY: 50, SENSEX: 100 } as const;
type Bar = { time: number; open: number; high: number; low: number; close: number };
const b5 = (ms: Min[]): Bar[] => { const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const m of ms) { const x = mn(m.t); if (x < 555 || x >= 930) continue; const k = Math.floor((x - 555) / 5);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: m.t - (x - 555 - k * 5) * 60, open: m.o, high: m.h, low: m.l, close: m.c }; key = k; }
    else { cur.high = Math.max(cur.high, m.h); cur.low = Math.min(cur.low, m.l); cur.close = m.c; } }
  if (cur) out.push(cur); return out; };
const ema = (xs: number[], n: number) => { const k = 2 / (n + 1); let v: number | null = null; return xs.map((x) => (v = v == null ? x : x * k + v * (1 - k))); };

type Out = { res: "T" | "SL" | "MISS" | "AMB" | "NOFILL"; net: number; netP: number; win: boolean };
function sim(path: Min[], e: number, sl: number, tg: number, ix: "NIFTY" | "SENSEX"): Out {
  let res: Out["res"] = "MISS", ex = path.length ? path[path.length - 1].c : e, exP = ex;
  for (const m of path) { const hs = m.l <= e - sl, ht = m.h >= e + tg;
    if (hs) { res = ht ? "AMB" : "SL"; ex = e - sl; exP = Math.min(e - sl, m.c); break; }
    if (ht) { res = "T"; ex = exP = e + tg; break; } }
  const f = (x: number) => x - e - COST(e) - COST(x) - 40 / LOT[ix];
  return { res, net: f(ex), netP: f(exP), win: res === "T" };
}

if (require.main === module) {
  const to = latestRawDay(), all: any[] = [];
  for (const [ix, days] of [["NIFTY", assemble(FROM, to).days], ["SENSEX", assembleIndex("SENSEX", FROM, to)]] as const) {
    const ds = (days as DayData[]).filter((d) => d.spot.size >= 300), byDay = new Map(ds.map((d, i) => [d.day, i])), exp = expiryDays(ds, STEP[ix]), last15 = new Set(ds.slice(-15).map((d) => d.day));
    const sigs = run(ix, days as DayData[]).sigs.filter((s: any) => s.pt);
    for (const x of sigs) {
      const di = byDay.get(x.day)!, D = ds[di], spot = [...D.spot.entries()].sort((a, b) => a[0] - b[0]);
      const s0 = spot.filter(([t]) => t < x.t).pop()?.[1]; if (s0 == null) continue;
      const key = `${Math.round(s0 / STEP[ix]) * STEP[ix]}${x.dir > 0 ? "CE" : "PE"}`, leg = [...(D.legs.get(key) || [])].sort((a, b) => a.t - b.t);
      const prev = di > 0 && !exp.has(ds[di - 1].day) ? [...(ds[di - 1].legs.get(key) || [])].sort((a, b) => a.t - b.t) : [];
      const bars = b5(prev).concat(b5(leg)).filter((b) => b.time + 300 <= x.t); if (bars.length < 15) continue;
      const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close))).slice(-14), patr = tr.reduce((a, b) => a + b, 0) / tr.length;
      const eIn = leg.filter((m) => m.t < x.t).pop(); if (!eIn) continue;
      const e = eIn.c, path = leg.filter((m) => m.t >= x.t && mn(m.t) <= 925), e9 = ema(bars.map((b) => b.close), 9)[bars.length - 1];
      const c0 = spot.filter(([t]) => t >= x.t - 300 && t < x.t), idxCandleDir = c0.length ? Math.sign(c0[c0.length - 1][1] - c0[0][1]) : 0;
      const s1 = Math.max(5, patr), s15 = Math.max(5, 1.5 * patr);
      const v: Record<string, Out> = { E0: sim(path, e, 5, 40, ix), S1: sim(path, e, s1, 40, ix), S2: sim(path, e, s1, 3 * s1, ix), S3: sim(path, e, s15, 3 * s15, ix) };
      // P1: limit at the premium EMA 9 within 15 minutes, S2 exits from the fill
      const win15 = path.filter((m) => m.t < x.t + 900), fill = win15.find((m) => m.l <= e9);
      if (fill && e9 > 0) { const fp = Math.min(e9, fill.o); v.P1 = sim(path.filter((m) => m.t > fill.t), fp, s1, 3 * s1, ix); } else v.P1 = { res: "NOFILL", net: 0, netP: 0, win: false };
      all.push({ ix, day: x.day, set: x.set, last15: last15.has(x.day), t: x.t, dir: x.dir, atrX: x.atrX, m: mn(x.t - 300), idxDir: idxCandleDir, v, patr });
    }
  }
  // flips: an opposite PT signal of the same index earlier the same day within 60 minutes
  for (const x of all) x.flip = all.some((y) => y.ix === x.ix && y.day === x.day && y.dir !== x.dir && y.t < x.t && x.t - y.t <= 3600);
  const F: Record<string, (x: any) => boolean> = { F1: (x) => !x.flip, F2: (x) => x.atrX < 1.2, F3: (x) => x.m >= 570 && x.m <= 870, F4: (x) => x.idxDir === x.dir };
  const line = (xs: any[], k: string) => { const o = xs.map((x) => x.v[k]).filter((r: Out) => r.res !== "NOFILL"), n = o.length; if (!n) return "n 0";
    const c = (r: string) => o.filter((x: Out) => x.res === r).length, sum = (f: (x: Out) => number) => o.reduce((a: number, x: Out) => a + f(x), 0);
    return `n ${String(n).padStart(4)} · WIN ${((c("T") / n) * 100).toFixed(1).padStart(5)}% · SL ${(((c("SL") + c("AMB")) / n) * 100).toFixed(1).padStart(5)}% · miss ${((c("MISS") / n) * 100).toFixed(1).padStart(4)}% · net/trade ₹${(sum((x) => x.net) / n).toFixed(2).padStart(6)} best / ₹${(sum((x) => x.netP) / n).toFixed(2).padStart(6)} pessimistic${xs.some((x) => x.v[k].res === "NOFILL") ? ` · no fill ${xs.filter((x) => x.v[k].res === "NOFILL").length}` : ""}`; };
  const variants: [string, string, (x: any) => boolean][] = [["E0 owner (SL 5 / T 40)", "E0", () => true], ["S1 SL 1×pATR / T 40", "S1", () => true], ["S2 SL 1×pATR / T 3×SL", "S2", () => true], ["S3 SL 1.5×pATR / T 3×SL", "S3", () => true], ["P1 pullback limit + S2", "P1", () => true],
    ["S2 + F1 no flip", "S2", F.F1], ["S2 + F2 ATR < 1.2", "S2", F.F2], ["S2 + F3 09:30–14:30", "S2", F.F3], ["S2 + F4 index candle agrees", "S2", F.F4], ["S2 + F1+F2", "S2", (x) => F.F1(x) && F.F2(x)], ["S2 + F1+F2+F3+F4", "S2", (x) => F.F1(x) && F.F2(x) && F.F3(x) && F.F4(x)],
    ["P1 + F1+F2", "P1", (x) => F.F1(x) && F.F2(x)]];
  for (const [title, pick] of [["LAST 15 SESSIONS", (x: any) => x.last15], ["DEV", (x: any) => x.set === "DEV"], ["VAL", (x: any) => x.set === "VAL"], ["TEST (untouched)", (x: any) => x.set === "TEST"]] as const) {
    console.log(`\n=== ${title} ===`);
    for (const ix of ["NIFTY", "SENSEX"]) { console.log(` ${ix}`); for (const [lab, k, f] of variants) console.log(`   ${lab.padEnd(30)} ${line(all.filter((x) => x.ix === ix && pick(x) && f(x)), k)}`); }
  }
  const pa = (ix: string) => { const xs = all.filter((x) => x.ix === ix); return (xs.reduce((a, x) => a + x.patr, 0) / xs.length).toFixed(1); };
  console.log(`\npremium ATR(5m) average over all signals: NIFTY ₹${pa("NIFTY")} · SENSEX ₹${pa("SENSEX")}`);
  void hmOf; process.exit(0);
}
