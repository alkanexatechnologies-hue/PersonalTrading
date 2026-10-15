import fs from "fs";
import path from "path";
import { assemble, istHm, DayData, Min } from "../nifty20/data";
import { netPoints, expiryFor } from "../nifty20/costs";
import { stats } from "./root";
import { DATA_DIR } from "../../config/dataDir";

// ============================ Trend-day detector (TRENDDAY_PREREGISTRATION.md, research only) ============================
// npx tsx backend/research/earlyBreakout/trendday.ts [--holdout <variant>]

const PERIODS = { DEV: ["2024-10-14", "2025-10-31"], VALIDATION: ["2025-11-01", "2026-05-31"], HOLDOUT: ["2026-06-01", "2026-10-12"] } as const;
type P = keyof typeof PERIODS;
const periodOf = (d: string): P | null => (Object.keys(PERIODS) as P[]).find((p) => d >= PERIODS[p][0] && d <= PERIODS[p][1]) || null;
const minOf = (t: number) => { const [h, m] = istHm(t).split(":").map(Number); return h * 60 + m; };
interface Bar { time: number; open: number; high: number; low: number; close: number }
interface V { s: number; T: number; exit: "HOLD" | "TRAIL" }
const VARIANTS: V[] = []; for (const s of [3, 4]) for (const T of [600, 615]) for (const exit of ["HOLD", "TRAIL"] as const) VARIANTS.push({ s, T, exit });
const vName = (v: V) => `s${v.s}_T${Math.floor(v.T / 60)}${String(v.T % 60).padStart(2, "0")}_${v.exit}`;

export interface DayFeat { day: string; period: P; D: number; f1: boolean; f2: boolean; f3: boolean; f4: boolean; score: number; T: number }

export function analyse(days: DayData[], variants = VARIANTS) {
  const trades: any[] = [], feats: DayFeat[] = []; let hist15: Bar[] = [];
  const prepared = days.map((d) => {
    const m = [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => minOf(t) >= 555 && minOf(t) <= 929) as [number, number][];
    const b15: Bar[] = []; let cur: Bar | null = null;
    for (const [t, p] of m) { const off = (minOf(t) - 555) % 15, st = t - off * 60; if (!cur || cur.time !== st) { if (cur) b15.push(cur); cur = { time: st, open: p, high: p, low: p, close: p }; } else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
    if (cur) b15.push(cur);
    return { d, m, b15 };
  });
  for (let i = 1; i < prepared.length; i++) {
    const prev = prepared[i - 1]; hist15 = hist15.concat(prev.b15).slice(-400);
    const { d, m, b15 } = prepared[i], period = periodOf(d.day);
    if (!period || m.length < 300 || prev.m.length < 300) continue;
    let a: number | null = null; for (let k = 1; k < hist15.length; k++) { const b = hist15[k], q = hist15[k - 1]; const tr = Math.max(b.high - b.low, Math.abs(b.high - q.close), Math.abs(b.low - q.close)); a = a == null ? tr : (a * 13 + tr) / 14; }
    if (!a) continue;
    const pC = prev.m[prev.m.length - 1][1], open = m[0][1], spotAt = new Map(m);
    const or = m.filter(([t]) => minOf(t) < 570), orH = Math.max(...or.map((x) => x[1])), orL = Math.min(...or.map((x) => x[1]));
    const lot = expiryFor(d.day).lot || 75, cache = new Map<string, Map<number, Min>>();
    const leg = (k: string) => { let x = cache.get(k); if (!x) { x = new Map((d.legs.get(k) || []).map((b) => [b.t, b])); cache.set(k, x); } return x; };
    const prem = (k: string, t: number, f: "o" | "c") => { const L = leg(k), b = L.get(t); if (b && b[f] > 0) return b[f]; for (let j = 1; j <= 5; j++) { const q = L.get(t - j * 60); if (q && q.c > 0) return q.c; } return null; };
    const oiAt = (k: string, t: number) => { const L = leg(k); for (let j = 0; j <= 5; j++) { const q = L.get(t - j * 60); if (q && q.oi != null) return q.oi; } return null; };
    const featAt = (Tm: number): DayFeat | null => {
      const row = m.find(([t]) => minOf(t) === Tm - 1); if (!row) return null;
      const tT = row[0] + 60, px = row[1], D = Math.sign(px - pC); if (!D) return null;
      const gap = open / pC - 1, f1 = Math.abs(gap) >= 0.0015 && Math.sign(gap) === D;
      const f2 = D > 0 ? px > orH : px < orL;
      const upto = m.filter(([t]) => t < tT), twap = upto.reduce((s, x) => s + x[1], 0) / upto.length, f3 = D * (px - twap) > 0;
      const t0 = m.find(([t]) => minOf(t) === 560)?.[0];
      let dPE = 0, dCE = 0;
      if (t0) for (let k = Math.round((px - 150) / 50) * 50; k <= px + 150; k += 50) {
        for (const side of ["CE", "PE"] as const) { const o1 = oiAt(`${k}${side}`, t0), o2 = oiAt(`${k}${side}`, tT - 60); if (o1 != null && o2 != null) { if (side === "CE") dCE += o2 - o1; else dPE += o2 - o1; } }
      }
      const f4 = D * (dPE - dCE) > 0;
      return { day: d.day, period, D, f1, f2, f3, f4, score: +f1 + +f2 + +f3 + +f4, T: tT };
    };
    for (const Tm of [600, 615]) { const f = featAt(Tm); if (f && Tm === 600) feats.push(f); if (!f) continue;
      for (const v of variants.filter((x) => x.T === Tm)) {
        if (f.score < v.s) continue;
        const side = f.D > 0 ? "CE" : "PE", s0 = spotAt.get(f.T - 60)!, k = `${Math.round(s0 / 50) * 50}${side}`, e = prem(k, f.T, "o"); if (e == null) continue;
        let stop = s0 - f.D * a, trail = false, exit: number | null = null, why = "", tEnd = f.T;
        for (let t = f.T; ; t += 60) {
          const mm = minOf(t), px = spotAt.get(t);
          if ((v.exit === "HOLD" && mm >= 900) || mm >= 915) { exit = prem(k, t, "o"); why = "time"; tEnd = t; break; }
          if (px == null) continue;
          if (f.D * (px - stop) <= 0) { exit = prem(k, t + 60, "o"); why = trail ? "trail" : "stop"; tEnd = t + 60; break; }
          if (v.exit === "TRAIL") {
            if (!trail && f.D * (px - s0) >= 0.5 * a) trail = true;
            if (trail && (mm + 1 - 555) % 15 === 0) { const pb = b15.filter((b) => b.time + 900 <= t + 60).pop(); if (pb) stop = f.D > 0 ? Math.max(stop, pb.low) : Math.min(stop, pb.high); }
          }
        }
        if (exit == null) continue;
        const n = netPoints(e, exit, lot, 1);
        trades.push({ day: d.day, period, v: vName(v), side, net: n.net, gross: n.gross, why, minutes: Math.round((tEnd - f.T) / 60), score: f.score });
      }
    }
  }
  return { trades, feats };
}

if (require.main === module) {
  const hi = process.argv.indexOf("--holdout"), hv = hi > 0 ? process.argv[hi + 1] : null;
  const { days } = assemble(PERIODS.DEV[0], PERIODS.HOLDOUT[1]);
  const vs = hv ? VARIANTS.filter((v) => vName(v) === hv) : VARIANTS;
  const { trades, feats } = analyse(days, vs);
  const res: any = { generated: new Date().toISOString(), holdout: hv, variants: {}, stayOut: {}, scoreDistribution: {} };
  for (const v of vs) { const n = vName(v), t = trades.filter((x) => x.v === n); res.variants[n] = { DEV: stats(t.filter((x) => x.period === "DEV")), VALIDATION: stats(t.filter((x) => x.period === "VALIDATION")), ...(hv ? { HOLDOUT: stats(t.filter((x) => x.period === "HOLDOUT")) } : {}) }; }
  for (const p of ["DEV", "VALIDATION"] as const) res.scoreDistribution[p] = [0, 1, 2, 3, 4].map((s) => feats.filter((f) => f.period === p && f.score === s).length);
  // stay-out check: earlier breakout trades split by detector agreement at 10:00
  const tf = path.join(DATA_DIR, "research-early-breakout", "trades.csv");
  if (fs.existsSync(tf)) {
    const L = fs.readFileSync(tf, "utf8").trim().split("\n"), h = L[0].split(","), rows = L.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [h[i], v])));
    const fd = new Map(feats.map((f) => [f.day, f]));
    for (const p of ["DEV", "VALIDATION"]) for (const sig of ["T15", "E5"]) {
      const rs = rows.filter((r: any) => r.period === p && r.sig === sig);
      const agree = rs.filter((r: any) => { const f = fd.get(r.day); return f && f.score >= 3 && (r.side === "CE" ? 1 : -1) === f.D; });
      const rest = rs.filter((r: any) => !agree.includes(r));
      const st2 = (x: any[]) => ({ n: x.length, avgNet: x.length ? Math.round((x.reduce((s, r) => s + Number(r.net), 0) / x.length) * 100) / 100 : null, winPct: x.length ? Math.round((x.filter((r) => Number(r.net) > 0).length / x.length) * 1000) / 10 : null });
      res.stayOut[`${p}_${sig}`] = { detectorAgrees: st2(agree), other: st2(rest) };
    }
  }
  const OUT = path.join(DATA_DIR, "research-early-breakout"); fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, hv ? "trendday_holdout.json" : "trendday_dev_val.json"), JSON.stringify(res, null, 1));
  for (const [k, r] of Object.entries<any>(res.variants)) console.log(k.padEnd(18), "DEV", JSON.stringify({ n: r.DEV.n, win: r.DEV.winPct, avg: r.DEV.avgNet, lb: r.DEV.lb95, pf: r.DEV.pf, dd: r.DEV.maxDD, ex: r.DEV.exits }), "| VAL", JSON.stringify({ n: r.VALIDATION.n, win: r.VALIDATION.winPct, avg: r.VALIDATION.avgNet, lb: r.VALIDATION.lb95, pf: r.VALIDATION.pf }), r.HOLDOUT ? "| HOLD " + JSON.stringify(r.HOLDOUT) : "");
  console.log("score distribution at 10:00 (0..4):", JSON.stringify(res.scoreDistribution));
  console.log("stay-out:", JSON.stringify(res.stayOut));
}
