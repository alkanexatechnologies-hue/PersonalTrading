import fs from "fs";
import path from "path";
import { assemble, istHm, DayData, Min } from "../nifty20/data";
import { netPoints, expiryFor } from "../nifty20/costs";
import { plans, Level } from "../../premium/traderView";
import { DATA_DIR } from "../../config/dataDir";

// ============================ Early breakout study (pre-registered in PREREGISTRATION.md, research only) ============================
// npx tsx backend/research/earlyBreakout/run.ts [--holdout]

export const PERIODS = { DEV: ["2024-10-14", "2025-10-31"], VALIDATION: ["2025-11-01", "2026-05-31"], HOLDOUT: ["2026-06-01", "2026-10-12"] } as const;
type P = keyof typeof PERIODS;
const periodOf = (d: string): P | null => (Object.keys(PERIODS) as P[]).find((p) => d >= PERIODS[p][0] && d <= PERIODS[p][1]) || null;
const OUT = path.join(DATA_DIR, "research-early-breakout");
const SIGS = ["T15", "E5", "E5P", "BNC"] as const;
type Sig = (typeof SIGS)[number];
interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface Trade { day: string; period: P; sig: Sig; side: "CE" | "PE"; sigTime: number; strike: number; entry: number; exit: number; exitWhy: string; net: number; gross: number; minutes: number; gapFill: boolean }

const minOf = (t: number) => { const [h, m] = istHm(t).split(":").map(Number); return h * 60 + m; };
function spotMinutes(d: DayData) { return [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => minOf(t) >= 555 && minOf(t) <= 929); }
function bars(mins: [number, number][], size: number): Bar[] {
  const out: Bar[] = []; let cur: Bar | null = null;
  for (const [t, p] of mins) { const off = (minOf(t) - 555) % size, start = t - off * 60; if (!cur || cur.time !== start) { if (cur) out.push(cur); cur = { time: start, open: p, high: p, low: p, close: p }; } else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out;
}
function atr14(b: Bar[]) { let a: number | null = null; for (let i = 1; i < b.length; i++) { const tr = Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)); a = a == null ? tr : (a * 13 + tr) / 14; } return a; }
const weekOf = (d: string) => { const t = new Date(d + "T00:00:00Z"), wd = (t.getUTCDay() + 6) % 7; return new Date(t.getTime() - wd * 86400_000).toISOString().slice(0, 10); };

export const missed: Record<string, number> = {};
export function runStudy(days: DayData[]) {
  const trades: Trade[] = [], prepared = days.map((d) => { const m = spotMinutes(d); return { d, m, b5: bars(m, 5), b15: bars(m, 15) }; });
  let hist15: Bar[] = [];
  for (let i = 1; i < prepared.length; i++) {
    const prev = prepared[i - 1]; hist15 = hist15.concat(prev.b15).slice(-400);
    const { d, m, b5, b15 } = prepared[i], period = periodOf(d.day);
    if (!period || m.length < 300 || prev.m.length < 300) continue;
    const a = atr14(hist15); if (!a) continue;
    const pH = Math.max(...prev.m.map((x) => x[1])), pL = Math.min(...prev.m.map((x) => x[1])), pC = prev.m[prev.m.length - 1][1];
    const pp = (pH + pL + pC) / 3;
    const levels: Level[] = [
      { price: pH, label: "PDH", kind: "PREV DAY" }, { price: pL, label: "PDL", kind: "PREV DAY" }, { price: pC, label: "PDC", kind: "PREV DAY" },
      { price: 2 * pp - pL, label: "R1", kind: "PIVOT" }, { price: pp + (pH - pL), label: "R2", kind: "PIVOT" }, { price: 2 * pp - pH, label: "S1", kind: "PIVOT" }, { price: pp - (pH - pL), label: "S2", kind: "PIVOT" },
    ];
    const wk = weekOf(d.day), pw = prepared.slice(Math.max(0, i - 10), i).filter((x) => weekOf(x.d.day) < wk), lastWk = pw.length ? weekOf(pw[pw.length - 1].d.day) : null;
    const pwm = lastWk ? pw.filter((x) => weekOf(x.d.day) === lastWk).flatMap((x) => x.m.map((y) => y[1])) : [];
    if (pwm.length) { levels.push({ price: Math.max(...pwm), label: "PWH", kind: "WEEK" }, { price: Math.min(...pwm), label: "PWL", kind: "WEEK" }); }
    levels.sort((x, y) => y.price - x.price);
    const pb = plans({ levels, spot: pC, ref: pC, atr: a, chain: [], expiry: null, events: [] });
    const lot = expiryFor(d.day).lot || 75;
    const spotAt = new Map(m), legCache = new Map<string, Map<number, Min>>();
    const leg = (k: string) => { let x = legCache.get(k); if (!x) { x = new Map((d.legs.get(k) || []).map((b) => [b.t, b])); legCache.set(k, x); } return x; };
    const premAt = (k: string, t: number, field: "o" | "c"): { v: number | null; gap: boolean } => {
      const L = leg(k), b = L.get(t); if (b && b[field] > 0) return { v: b[field], gap: false };
      for (let j = 1; j <= 5; j++) { const p = L.get(t - j * 60); if (p && p.c > 0) return { v: p.c, gap: true }; }
      return { v: null, gap: true };
    };
    const simulate = (sig: Sig, side: "CE" | "PE", sigClose: number, stop: number, target: number) => {
      const s0 = spotAt.get(sigClose - 60) ?? spotAt.get(sigClose); if (s0 == null) return;
      if ((side === "CE" ? 1 : -1) * (s0 - target) >= 0) { missed[sig] = (missed[sig] || 0) + 1; return; }   // live radar: MISSED — never chase
      const strike = Math.round(s0 / 50) * 50, k = `${strike}${side}`;
      const e = premAt(k, sigClose, "o"); if (e.v == null) return;
      const dir = side === "CE" ? 1 : -1; let exit: number | null = null, why = "", gap = e.gap, tEnd = sigClose;
      for (let t = sigClose; ; t += 60) {
        const mm = minOf(t), px = spotAt.get(t);
        if (mm >= 915 || t - sigClose >= 3600) { const x = premAt(k, t, "o"); exit = x.v; gap ||= x.gap; why = mm >= 915 ? "15:15" : "60 min"; tEnd = t; break; }
        if (px == null) continue;
        if (dir * (px - target) >= 0) { const x = premAt(k, t, "c"); exit = x.v; gap ||= x.gap; why = "target"; tEnd = t; break; }
        if (dir * (px - stop) <= 0) { const x = premAt(k, t + 60, "o"); exit = x.v; gap ||= x.gap; why = "stop"; tEnd = t + 60; break; }
      }
      if (exit == null) return;
      const n = netPoints(e.v, exit, lot, 1);
      trades.push({ day: d.day, period, sig, side, sigTime: sigClose, strike, entry: e.v, exit, exitWhy: why, net: n.net, gross: n.gross, minutes: Math.round((tEnd - sigClose) / 60), gapFill: gap });
    };
    const done = new Set<string>();
    const inWindow = (closeT: number) => minOf(closeT) >= 570 && minOf(closeT) <= 870;
    for (const [sd, side, p] of [["bull", "CE", pb.bull], ["bear", "PE", pb.bear]] as const) {
      if (!p) continue; const dir = side === "CE" ? 1 : -1;
      for (const b of b15) { const c = b.time + 900; if (!inWindow(c) || done.has("T15" + sd)) continue; if (dir * (b.close - p.entry) >= 0) { done.add("T15" + sd); simulate("T15", side, c, p.stop, p.t1); } }
      for (const b of b5) {
        const c = b.time + 300; if (!inWindow(c)) continue;
        if (!done.has("E5" + sd) && dir * (b.close - p.entry) >= 0) { done.add("E5" + sd); simulate("E5", side, c, p.stop, p.t1); }
        if (!done.has("E5P" + sd) && dir * (b.close - p.entry) >= 0) {
          const s0 = spotAt.get(c - 60), k = s0 != null ? `${Math.round(s0 / 50) * 50}${side}` : "";
          const L = [...leg(k).values()].filter((x) => x.t < c), recent = L.filter((x) => x.t >= c - 300), before = L.filter((x) => x.t < c - 300);
          if (recent.length && before.length && Math.max(...recent.map((x) => x.h)) > Math.max(...before.map((x) => x.h))) { done.add("E5P" + sd); simulate("E5P", side, c, p.stop, p.t1); }
        }
      }
    }
    // bounce at the opposite plan's trigger: support (bear trigger) → CE, resistance (bull trigger) → PE
    for (const [lvl, side] of [[pb.bear?.trigger, "CE"], [pb.bull?.trigger, "PE"]] as const) {
      if (lvl == null) continue; const dir = side === "CE" ? 1 : -1;
      for (const b of b5) {
        const c = b.time + 300; if (!inWindow(c) || done.has("BNC" + side)) continue;
        const tested = side === "CE" ? b.low <= lvl + 0.15 * a : b.high >= lvl - 0.15 * a, held = dir * (b.close - lvl) >= 0.2 * a;
        if (tested && held) { done.add("BNC" + side); simulate("BNC", side, c, lvl - dir * 0.3 * a, lvl + dir * a); }
      }
    }
  }
  return trades;
}

export function stats(ts: Trade[]) {
  const n = ts.length; if (!n) return { n: 0 };
  const w = ts.filter((t) => t.net > 0), l = ts.filter((t) => t.net <= 0), tot = ts.reduce((s, t) => s + t.net, 0);
  let eq = 0, pk = 0, dd = 0; for (const t of ts) { eq += t.net; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); }
  const gw = w.reduce((s, t) => s + t.net, 0), gl = -l.reduce((s, t) => s + t.net, 0);
  return { n, winPct: Math.round((w.length / n) * 1000) / 10, avgNet: Math.round((tot / n) * 100) / 100, totalNet: Math.round(tot * 10) / 10, pf: gl > 0 ? Math.round((gw / gl) * 100) / 100 : null, maxDD: Math.round(dd * 10) / 10,
    exits: ts.reduce((m: any, t) => ((m[t.exitWhy] = (m[t.exitWhy] || 0) + 1), m), {}), gapFillPct: Math.round((ts.filter((t) => t.gapFill).length / n) * 1000) / 10 };
}

if (require.main === module) {
  const open = process.argv.includes("--holdout");
  const { days } = assemble(PERIODS.DEV[0], PERIODS.HOLDOUT[1]);
  const all = runStudy(days); console.log("skipped as MISSED (already beyond T1):", JSON.stringify(missed));
  const periods: P[] = open ? ["DEV", "VALIDATION", "HOLDOUT"] : ["DEV", "VALIDATION"];
  const res: any = { generated: new Date().toISOString(), holdoutOpened: open, days: days.length, missedSkipped: missed, periods: {} };
  for (const p of periods) {
    res.periods[p] = {};
    for (const s of SIGS) for (const side of ["CE", "PE", "ALL"] as const) {
      const ts = all.filter((t) => t.period === p && t.sig === s && (side === "ALL" || t.side === side));
      res.periods[p][`${s}_${side}`] = stats(ts);
    }
    // earliness and false-early vs T15 (same day + side)
    const t15 = new Map(all.filter((t) => t.period === p && t.sig === "T15").map((t) => [`${t.day}|${t.side}`, t]));
    const e5 = all.filter((t) => t.period === p && t.sig === "E5");
    const earlier = e5.map((t) => { const b = t15.get(`${t.day}|${t.side}`); return b ? (b.sigTime - t.sigTime) / 60 : null; }).filter((x): x is number => x != null).sort((x, y) => x - y);
    res.periods[p].E5_vs_T15 = { medianMinutesEarlier: earlier.length ? earlier[Math.floor(earlier.length / 2)] : null, falseEarly: e5.filter((t) => !t15.has(`${t.day}|${t.side}`)).length, falseEarlyNet: stats(e5.filter((t) => !t15.has(`${t.day}|${t.side}`))) };
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, open ? "results_with_holdout.json" : "results_dev_val.json"), JSON.stringify(res, null, 1));
  fs.writeFileSync(path.join(OUT, "trades.csv"), ["day,period,sig,side,sigTime,strike,entry,exit,exitWhy,gross,net,minutes,gapFill"].concat(all.map((t) => [t.day, t.period, t.sig, t.side, istHm(t.sigTime), t.strike, t.entry, t.exit, t.exitWhy, t.gross, t.net, t.minutes, t.gapFill].join(","))).join("\n"));
  for (const p of periods) { console.log(`\n== ${p}`); for (const [k, v] of Object.entries<any>(res.periods[p])) console.log(k.padEnd(12), JSON.stringify(v)); }
}
