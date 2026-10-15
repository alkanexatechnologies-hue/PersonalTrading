import fs from "fs";
import path from "path";
import { assemble, istHm, DayData, Min } from "../nifty20/data";
import { netPoints, expiryFor } from "../nifty20/costs";
import { DATA_DIR } from "../../config/dataDir";

// ============================ Root breakout study (ROOT_PREREGISTRATION.md, research only) ============================
// npx tsx backend/research/earlyBreakout/root.ts [--holdout <variant>]

export const PERIODS = { DEV: ["2024-10-14", "2025-10-31"], VALIDATION: ["2025-11-01", "2026-05-31"], HOLDOUT: ["2026-06-01", "2026-10-12"] } as const;
type P = keyof typeof PERIODS;
const periodOf = (d: string): P | null => (Object.keys(PERIODS) as P[]).find((p) => d >= PERIODS[p][0] && d <= PERIODS[p][1]) || null;
interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface V { K: number; c: number; trend: boolean; exit: "TGT" | "TRAIL" }
export const VARIANTS: V[] = [];
for (const K of [6, 12]) for (const c of [0.6, 1.0]) for (const trend of [false, true]) for (const exit of ["TGT", "TRAIL"] as const) VARIANTS.push({ K, c, trend, exit });
export const vName = (v: V) => `K${v.K}_c${v.c}_${v.trend ? "TREND" : "ANY"}_${v.exit}`;
export interface Trade { day: string; period: P; v: string; side: "CE" | "PE"; sig: string; net: number; gross: number; why: string; minutes: number }

const minOf = (t: number) => { const [h, m] = istHm(t).split(":").map(Number); return h * 60 + m; };
const mins = (d: DayData) => [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => minOf(t) >= 555 && minOf(t) <= 929) as [number, number][];
function bars(m: [number, number][], size: number): Bar[] {
  const out: Bar[] = []; let cur: Bar | null = null;
  for (const [t, p] of m) { const off = (minOf(t) - 555) % size, start = t - off * 60; if (!cur || cur.time !== start) { if (cur) out.push(cur); cur = { time: start, open: p, high: p, low: p, close: p }; } else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out;
}
const atr14 = (b: Bar[]) => { let a: number | null = null; for (let i = 1; i < b.length; i++) { const tr = Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)); a = a == null ? tr : (a * 13 + tr) / 14; } return a; };
const weekOf = (d: string) => { const t = new Date(d + "T00:00:00Z"), wd = (t.getUTCDay() + 6) % 7; return new Date(t.getTime() - wd * 86400_000).toISOString().slice(0, 10); };
const ema = (v: number[], p: number) => { const k = 2 / (p + 1); const o: number[] = []; let e = v[0]; v.forEach((x, i) => { e = i ? x * k + e * (1 - k) : x; o.push(e); }); return o; };

export function run(days: DayData[], variants: V[] = VARIANTS, opt: { step?: number; lot?: number } = {}) {
  const STEP = opt.step ?? 50, ROUND = 2 * STEP;
  const prep = days.map((d) => { const m = mins(d); return { d, m, b5: bars(m, 5), b15: bars(m, 15) }; });
  const out: Trade[] = []; let hist15: Bar[] = [];
  for (let i = 1; i < prep.length; i++) {
    const prev = prep[i - 1]; hist15 = hist15.concat(prev.b15).slice(-400);
    const { d, m, b5, b15 } = prep[i], period = periodOf(d.day);
    if (!period || m.length < 300 || prev.m.length < 300) continue;
    const a = atr14(hist15); if (!a) continue;
    const pH = Math.max(...prev.m.map((x) => x[1])), pL = Math.min(...prev.m.map((x) => x[1])), pC = prev.m[prev.m.length - 1][1], pp = (pH + pL + pC) / 3;
    const hurdles = [pH, pL, pC, 2 * pp - pL, pp + (pH - pL), 2 * pp - pH, pp - (pH - pL)];
    const wk = weekOf(d.day), pw = prep.slice(Math.max(0, i - 10), i).filter((x) => weekOf(x.d.day) < wk), lw = pw.length ? weekOf(pw[pw.length - 1].d.day) : null;
    const pwm = lw ? pw.filter((x) => weekOf(x.d.day) === lw).flatMap((x) => x.m.map((y) => y[1])) : [];
    if (pwm.length) hurdles.push(Math.max(...pwm), Math.min(...pwm));
    for (let r = Math.floor((pC - 3 * a) / ROUND) * ROUND; r <= pC + 3 * a; r += ROUND) hurdles.push(r);
    const nextHurdle = (px: number, dir: number) => { const c = hurdles.filter((h) => dir * (h - px) > 0.05 * a).sort((x, y) => dir * (x - y)); return c[0] ?? null; };
    // 15-min EMA21 slope known at a time t: closed 15-min bars of history + today before t
    const closes15 = hist15.map((b) => b.close);
    const trendAt = (t: number) => { const today = b15.filter((b) => b.time + 900 <= t).map((b) => b.close), e = ema(closes15.concat(today), 21), n = e.length; return n > 3 ? Math.sign(e[n - 1] - e[n - 4]) : 0; };
    const lot = opt.lot ?? (expiryFor(d.day).lot || 75), spotAt = new Map(m), legCache = new Map<string, Map<number, Min>>();
    const leg = (k: string) => { let x = legCache.get(k); if (!x) { x = new Map((d.legs.get(k) || []).map((b) => [b.t, b])); legCache.set(k, x); } return x; };
    const prem = (k: string, t: number, f: "o" | "c") => { const L = leg(k), b = L.get(t); if (b && b[f] > 0) return b[f]; for (let j = 1; j <= 5; j++) { const q = L.get(t - j * 60); if (q && q.c > 0) return q.c; } return null; };
    for (const v of variants) {
      const name = vName(v), count = { CE: 0, PE: 0 }; let busyUntil = 0, usedBase = -1;
      for (let j = v.K; j < b5.length; j++) {
        const sb = b5[j], c = sb.time + 300; if (minOf(c) < 570 || minOf(c) > 870 || c < busyUntil) continue;
        const base = b5.slice(j - v.K, j), hi = Math.max(...base.map((x) => x.high)), lo = Math.min(...base.map((x) => x.low));
        if (hi - lo > v.c * a || usedBase >= j - v.K) continue;
        const dir = sb.close > hi + 0.1 * a ? 1 : sb.close < lo - 0.1 * a ? -1 : 0; if (!dir) continue;
        const side = dir > 0 ? "CE" : "PE"; if (count[side] >= 2) continue;
        if (v.trend && trendAt(c) !== dir) continue;
        const target = nextHurdle(sb.close, dir); if (target == null || dir * (target - sb.close) < a) continue;   // room ≥ 1 ATR
        usedBase = j - 1;
        // simulate
        const s0 = spotAt.get(c - 60) ?? sb.close, k = `${Math.round(s0 / STEP) * STEP}${side}`, e = prem(k, c, "o"); if (e == null) continue;
        let stop = dir > 0 ? lo - 0.05 * a : hi + 0.05 * a, trailOn = false, exit: number | null = null, why = "", tEnd = c;
        for (let t = c; ; t += 60) {
          const mm = minOf(t), px = spotAt.get(t);
          if (mm >= 915 || (v.exit === "TGT" && t - c >= 3600)) { exit = prem(k, t, "o"); why = mm >= 915 ? "15:15" : "60 min"; tEnd = t; break; }
          if (px == null) continue;
          if (v.exit === "TGT" && dir * (px - target) >= 0) { exit = prem(k, t, "c"); why = "target"; tEnd = t; break; }
          if (dir * (px - stop) <= 0) { exit = prem(k, t + 60, "o"); why = trailOn ? "trail" : "stop"; tEnd = t + 60; break; }
          if (v.exit === "TRAIL") {
            if (!trailOn && dir * (px - sb.close) >= 0.5 * a) trailOn = true;
            if (trailOn && (minOf(t + 60) - 555) % 5 === 0) { const pb = b5.filter((b) => b.time + 300 <= t + 60).pop(); if (pb) stop = dir > 0 ? Math.max(stop, pb.low) : Math.min(stop, pb.high); }
          }
        }
        if (exit == null) continue;
        const n = netPoints(e, exit, lot, 1); count[side]++; busyUntil = tEnd;
        out.push({ day: d.day, period, v: name, side, sig: istHm(c), net: n.net, gross: n.gross, why, minutes: Math.round((tEnd - c) / 60) });
      }
    }
  }
  return out;
}
export function stats(ts: Trade[]) {
  const n = ts.length; if (!n) return { n: 0 } as any;
  const tot = ts.reduce((s, t) => s + t.net, 0), w = ts.filter((t) => t.net > 0), gw = w.reduce((s, t) => s + t.net, 0), gl = -ts.filter((t) => t.net <= 0).reduce((s, t) => s + t.net, 0);
  let eq = 0, pk = 0, dd = 0; for (const t of ts) { eq += t.net; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); }
  // day-bootstrap 95 % lower bound of the mean
  const byDay = [...ts.reduce((mm, t) => mm.set(t.day, [...(mm.get(t.day) || []), t.net]), new Map<string, number[]>()).values()];
  let s = 7; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648), means: number[] = [];
  for (let it = 0; it < 1000; it++) { let sum = 0, cnt = 0; for (let k = 0; k < byDay.length; k++) { const dd2 = byDay[Math.floor(rnd() * byDay.length)]; for (const x of dd2) { sum += x; cnt++; } } means.push(sum / cnt); }
  means.sort((x, y) => x - y);
  return { n, winPct: Math.round((w.length / n) * 1000) / 10, avgNet: Math.round((tot / n) * 100) / 100, lb95: Math.round(means[Math.floor(0.05 * means.length)] * 100) / 100, totalNet: Math.round(tot), pf: gl > 0 ? Math.round((gw / gl) * 100) / 100 : null, maxDD: Math.round(dd), exits: ts.reduce((mm: any, t) => ((mm[t.why] = (mm[t.why] || 0) + 1), mm), {}) };
}

if (require.main === module) {
  const hi = process.argv.indexOf("--holdout"), holdoutV = hi > 0 ? process.argv[hi + 1] : null;
  const { days } = assemble(PERIODS.DEV[0], PERIODS.HOLDOUT[1]);
  const vs = holdoutV ? VARIANTS.filter((v) => vName(v) === holdoutV) : VARIANTS;
  const all = run(days, vs), res: any = { generated: new Date().toISOString(), holdout: holdoutV, variants: {} };
  for (const v of vs) {
    const name = vName(v), mine = all.filter((t) => t.v === name);
    res.variants[name] = { DEV: stats(mine.filter((t) => t.period === "DEV")), VALIDATION: stats(mine.filter((t) => t.period === "VALIDATION")), ...(holdoutV ? { HOLDOUT: stats(mine.filter((t) => t.period === "HOLDOUT")) } : {}) };
  }
  const OUT = path.join(DATA_DIR, "research-early-breakout"); fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, holdoutV ? "root_holdout.json" : "root_dev_val.json"), JSON.stringify(res, null, 1));
  const rows = Object.entries<any>(res.variants).sort((x, y) => (y[1].DEV.avgNet ?? -99) - (x[1].DEV.avgNet ?? -99));
  for (const [k, r] of rows) console.log(k.padEnd(24), "DEV", JSON.stringify({ n: r.DEV.n, win: r.DEV.winPct, avg: r.DEV.avgNet, lb: r.DEV.lb95, pf: r.DEV.pf, dd: r.DEV.maxDD }), "| VAL", JSON.stringify({ n: r.VALIDATION.n, win: r.VALIDATION.winPct, avg: r.VALIDATION.avgNet, lb: r.VALIDATION.lb95, pf: r.VALIDATION.pf }), r.HOLDOUT ? "| HOLD " + JSON.stringify(r.HOLDOUT) : "");
}
