// ProTrader 3× STUDY — how often did an option premium really TRIPLE (and double) before 15:20 the same day?
// Real Dhan 1-minute premiums (rolling ATM ± 3, nearest weekly), NIFTY + SENSEX, ~2 years. At every half hour 09:30 … 14:30,
// each strike's premium p (the minute's close) is checked against the highest premium after that minute until 15:20:
// HIT3 = high ≥ 3p, HIT2 = high ≥ 2p. Buckets: side · steps out of the money (−3 … +3; negative = in the money) · time ·
// the index's own expiry day or not. A strike that runs far in the money leaves the ATM ± 3 window, so its later bars can be
// missing — that can only UNDER-count a hit (conservative). Writes data/research-triple/<INDEX>.json. Usage: npx tsx tripleStudy.ts
import fs from "fs";
import path from "path";
import { assemble, DayData } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";
import { expiryDays } from "./premiumBacktest2";
import { DATA_DIR } from "../../config/dataDir";
import { featuresFrom } from "./openingStudy";
import { gap7 } from "../../premium/nextDayMap";

const OUT = path.join(DATA_DIR, "research-triple");
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
export const TIMES = [570, 600, 630, 660, 690, 720, 750, 780, 810, 840, 870];   // 09:30 … 14:30
export interface Cell { n: number; hit3: number; hit2: number }
export function tripleCells(days: DayData[], step: number, dev?: Set<string>) {
  const ds = days.filter((d) => d.spot.size >= 300), exp = expiryDays(ds, step), cells: Record<string, Cell> = {};
  for (const d of ds) {
    const isExp = exp.has(d.day), spot = [...d.spot.entries()].sort((a, b) => a[0] - b[0]);
    for (const T of TIMES) {
      const s = spot.filter(([t]) => mn(t) <= T).pop(); if (!s) continue;
      const atm = Math.round(s[1] / step) * step;
      for (const side of ["CE", "PE"] as const) for (let rel = -3; rel <= 3; rel++) {
        const k = atm + rel * step, bars = d.legs.get(`${k}${side}`); if (!bars?.length) continue;
        const at = bars.filter((b) => mn(b.t) <= T).pop(); if (!at || mn(at.t) < T - 2 || !(at.c > 0.5)) continue;   // a price at that minute (≥ ₹0.5)
        const later = bars.filter((b) => mn(b.t) > T && mn(b.t) <= 920); if (!later.length) continue;
        const hi = Math.max(...later.map((b) => b.h)), otm = side === "CE" ? rel : -rel;
        const key = `${side}|${otm}|${T}|${isExp ? "E" : "N"}`, c = (cells[key] = cells[key] || { n: 0, hit3: 0, hit2: 0 });
        c.n++; if (hi >= 3 * at.c) c.hit3++; if (hi >= 2 * at.c) c.hit2++;
      }
    }
  }
  return cells;
}
/** 3× BY EXPIRY: the same contract (strike + side inside one expiry week) followed from 09:30 / 12:30 of a day to 15:20 of its expiry
 *  day. Bucket: side · steps OTM · trading days left to expiry (0 = expiry day) · decision time. */
export function toExpiryCells(days: DayData[], step: number) {
  const ds = days.filter((d) => d.spot.size >= 300), exp = [...expiryDays(ds, step)].sort(), cells: Record<string, Cell> = {};
  const weekOf = (day: string) => exp.find((e) => e >= day) ?? null;
  const byWeek = new Map<string, DayData[]>(); for (const d of ds) { const w = weekOf(d.day); if (w) (byWeek.get(w) || byWeek.set(w, []).get(w)!).push(d); }
  for (const [w, wd] of byWeek) {
    wd.sort((a, b) => a.day.localeCompare(b.day));
    for (let i = 0; i < wd.length; i++) {
      const d = wd[i], dte = wd.length - 1 - i, spot = [...d.spot.entries()].sort((a, b) => a[0] - b[0]);
      for (const T of [570, 750]) {
        const s = spot.filter(([t]) => mn(t) <= T).pop(); if (!s) continue;
        const atm = Math.round(s[1] / step) * step;
        for (const side of ["CE", "PE"] as const) for (let rel = -3; rel <= 3; rel++) {
          const key0 = `${atm + rel * step}${side}`, bars = d.legs.get(key0); if (!bars?.length) continue;
          const at = bars.filter((b) => mn(b.t) <= T).pop(); if (!at || mn(at.t) < T - 2 || !(at.c > 0.5)) continue;
          let hi = 0; for (let j = i; j < wd.length; j++) for (const b of wd[j].legs.get(key0) || []) if ((j > i || mn(b.t) > T) && mn(b.t) <= 920) hi = Math.max(hi, b.h);
          if (!hi) continue;
          const otm = side === "CE" ? rel : -rel, key = `${side}|${otm}|${Math.min(dte, 4)}|${T}`, c = (cells[key] = cells[key] || { n: 0, hit3: 0, hit2: 0 });
          c.n++; if (hi >= 3 * at.c) c.hit3++; if (hi >= 2 * at.c) c.hit2++;
        }
      }
    }
    void w;
  }
  return cells;
}
/** 3× odds by OPENING GAP group (gap7 of that day's open vs the previous close, in daily ATR), from 09:30: same day and by expiry. */
export function gapCells(days: DayData[], step: number, gapOf: Map<string, string>) {
  const ds = days.filter((d) => d.spot.size >= 300), exp = [...expiryDays(ds, step)].sort(), cells: Record<string, { n: number; same3: number; exp3: number; exp2: number }> = {};
  const weekOf = (day: string) => exp.find((e) => e >= day) ?? null, byWeek = new Map<string, DayData[]>();
  for (const d of ds) { const w = weekOf(d.day); if (w) (byWeek.get(w) || byWeek.set(w, []).get(w)!).push(d); }
  for (const [, wd] of byWeek) { wd.sort((a, b) => a.day.localeCompare(b.day));
    for (let i = 0; i < wd.length; i++) { const d = wd[i], g = gapOf.get(d.day); if (!g) continue;
      const s = [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) <= 570).pop(); if (!s) continue; const atm = Math.round(s[1] / step) * step;
      for (const side of ["CE", "PE"] as const) for (let rel = -3; rel <= 3; rel++) {
        const k = `${atm + rel * step}${side}`, bars = d.legs.get(k); if (!bars) continue; const at = bars.filter((b) => mn(b.t) <= 570).pop(); if (!at || mn(at.t) < 568 || at.c < 0.5) continue;
        let sameHi = 0, expHi = 0; for (let q = i; q < wd.length; q++) for (const b of wd[q].legs.get(k) || []) if ((q > i || mn(b.t) > 570) && mn(b.t) <= 920) { expHi = Math.max(expHi, b.h); if (q === i) sameHi = Math.max(sameHi, b.h); }
        const otm = side === "CE" ? rel : -rel, key = `${side}|${otm}|${g}`, c = (cells[key] = cells[key] || { n: 0, same3: 0, exp3: 0, exp2: 0 });
        c.n++; if (sameHi >= 3 * at.c) c.same3++; if (expHi >= 3 * at.c) c.exp3++; if (expHi >= 2 * at.c) c.exp2++;
      } } }
  return cells;
}
if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  const to = latestRawDay();
  for (const [name, days, step] of [["NIFTY", assemble(FROM, to).days, 50], ["SENSEX", assembleIndex("SENSEX", FROM, to), 100]] as const) {
    const ds = days.filter((d) => d.spot.size >= 300), cut = Math.floor((ds.length * 2) / 3);
    const all = tripleCells(ds, step), dev = tripleCells(ds.slice(0, cut), step), val = tripleCells(ds.slice(cut), step), expiry = toExpiryCells(ds, step);
    // the opening gap of each day (Dhan 5-min + official daily, saved by openingStudy.ts) → gap-matched 3× odds
    let gap: Record<string, any> = {};
    try { const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "research-nextday", `dhan5m_${name}.json`), "utf8")); const gapOf = new Map(featuresFrom(j.c5, j.d1).map((f) => [f.day, gap7((f.open - f.pdc) / f.atr)] as [string, string])); gap = gapCells(ds, step, gapOf); } catch { gap = {}; }
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ index: name, from: ds[0].day, to: ds[ds.length - 1].day, sessions: ds.length, step, times: TIMES, cells: all, dev, val, expiry, gap, generatedAt: new Date().toISOString(),
      method: "real Dhan 1-min premiums: share of strikes whose premium reached 3x (2x) of its price at that half hour before 15:20 the same day" }));
    const sum = (f: (k: string) => boolean, c = all) => Object.entries(c).filter(([k]) => f(k)).reduce((a, [, v]) => ({ n: a.n + v.n, hit3: a.hit3 + v.hit3, hit2: a.hit2 + v.hit2 }), { n: 0, hit3: 0, hit2: 0 });
    const pc = (x: Cell) => `n ${x.n} · 3× ${((x.hit3 / Math.max(1, x.n)) * 100).toFixed(1)}% · 2× ${((x.hit2 / Math.max(1, x.n)) * 100).toFixed(1)}%`;
    console.log(`\n${name} ${ds[0].day}→${ds[ds.length - 1].day} (${ds.length} sessions)`);
    for (const e of ["N", "E"]) for (const otm of [-1, 0, 1, 2, 3]) console.log(`  ${e === "E" ? "EXPIRY " : "normal "} ${otm > 0 ? otm + " OTM" : otm < 0 ? -otm + " ITM" : "ATM  "}  all day: ${pc(sum((k) => k.endsWith("|" + e) && k.split("|")[1] === String(otm)))}`);
    for (const dte of [4, 3, 2, 1]) for (const otm of [0, 1, 2, 3]) { const c = Object.entries(expiry).filter(([k]) => { const p = k.split("|"); return p[1] === String(otm) && p[2] === String(dte) && p[3] === "570"; }).reduce((a, [, v]) => ({ n: a.n + v.n, hit3: a.hit3 + v.hit3, hit2: a.hit2 + v.hit2 }), { n: 0, hit3: 0, hit2: 0 }); console.log(`  BY EXPIRY from 09:30, ${dte}d left, ${otm ? otm + " OTM" : "ATM  "}: ${pc(c)}`); }
    for (const T of [570, 690, 810, 870]) console.log(`  EXPIRY 2-3 OTM at ${Math.floor(T / 60)}:${String(T % 60).padStart(2, "0")}: ${pc(sum((k) => { const p = k.split("|"); return p[3] === "E" && ["2", "3"].includes(p[1]) && p[2] === String(T); }))}`);
  }
  process.exit(0);
}
