import fs from "fs";
import path from "path";
import { assemble, istHm, DayData } from "../nifty20/data";
import { runSession, BREAKOUT_CONFIG } from "../../signals/breakoutEngine";
import { breakStates, LevelsAt } from "../../premium/premiumCenter";
import { atr } from "../../indicators";
import { DATA_DIR } from "../../config/dataDir";

// ============================ Premium Prediction Center — step 3 validation (pre-registered, research only) ============================
// npx tsx backend/research/premiumState/run.ts             → DEV + VALIDATION (HOLDOUT closed)
// npx tsx backend/research/premiumState/run.ts --holdout   → opens HOLDOUT once and writes the display file

export const PERIODS = { DEV: ["2024-10-14", "2025-10-31"], VALIDATION: ["2025-11-01", "2026-05-31"], HOLDOUT: ["2026-06-01", "2026-10-12"] } as const;
type P = keyof typeof PERIODS;
const periodOf = (d: string): P | null => (Object.keys(PERIODS) as P[]).find((p) => d >= PERIODS[p][0] && d <= PERIODS[p][1]) || null;
export const HORIZONS = [5, 15, 30] as const;
const OUT = path.join(DATA_DIR, "research-premium-state");
export interface Sample { day: string; period: P; t: number; bull: string; bear: string; side: "CE" | "PE"; h: number; entry: number; exit: number; rise: boolean }
interface C { time: number; open: number; high: number; low: number; close: number; volume: number }

/** 5-minute spot candles per day; time = bar START (as Dhan's), built from 1-minute spot. */
export function bars5(d: DayData): C[] {
  const out: C[] = []; let cur: C | null = null;
  for (const [t, s] of [...d.spot.entries()].sort((a, b) => a[0] - b[0])) {
    const hm = istHm(t); if (hm < "09:15" || hm > "15:29") continue;
    const [h, m] = hm.split(":").map(Number), k = Math.floor((h * 60 + m - 555) / 5), start = t - ((h * 60 + m - 555) % 5) * 60;
    if (!cur || cur.time !== start) { if (cur) out.push(cur); cur = { time: start, open: s, high: s, low: s, close: s, volume: 0 }; void k; }
    else { cur.high = Math.max(cur.high, s); cur.low = Math.min(cur.low, s); cur.close = s; }
  }
  if (cur) out.push(cur);
  return out;
}
function legOpenAt(d: DayData, key: string, t: number, cache: Map<string, Map<number, number>>): number | null {
  let m = cache.get(key);
  if (!m) { m = new Map((d.legs.get(key) || []).map((b) => [b.t, b.o])); cache.set(key, m); }
  const v = m.get(t); return v != null && v > 0 ? v : null;
}

export function collect(days: DayData[]) {
  const per = days.map(bars5), samples: Sample[] = []; let skipped = 0, points = 0;
  for (let di = 4; di < days.length; di++) {
    const d = days[di], period = periodOf(d.day); if (!period || per[di].length < 60) continue;
    const hist = per.slice(di - 4, di + 1).flat(), dayStart = hist.length - per[di].length;
    const res = runSession(hist as any, { intervalSec: 300, sessionDate: d.day });
    const rowByTime = new Map(res.rows.map((r: any) => [r.time, r]));
    const levels: LevelsAt[] = hist.map((_, i) => { const r: any = i > 0 ? rowByTime.get(hist[i - 1].time) : null; return { resistance: r?.resistance?.price ?? null, support: r?.support?.price ?? null }; });
    levels.push((() => { const r: any = rowByTime.get(hist[hist.length - 1].time); return { resistance: r?.resistance?.price ?? null, support: r?.support?.price ?? null }; })());
    const atrS = atr(hist as any, BREAKOUT_CONFIG.atrPeriod), cache = new Map<string, Map<number, number>>();
    for (let j = dayStart; j < hist.length; j++) {
      const closeT = hist[j].time + 300, hm = istHm(closeT);
      if (hm < "09:20" || hm > "15:00") continue;
      const a = atrS[j]; if (a == null) continue;
      const lo = Math.max(0, j + 1 - 12), closed = hist.slice(lo, j + 1), lv = levels.slice(lo, j + 2);   // lv[k] ↔ closed[k]; lv[last] = level known now
      const st = breakStates(closed as any, null, lv, a, BREAKOUT_CONFIG.breakBufferAtr * a);
      points++;
      const atm = Math.round(hist[j].close / 50) * 50;
      for (const side of ["CE", "PE"] as const) for (const h of HORIZONS) {
        const k = `${atm}${side}`, e = legOpenAt(d, k, closeT, cache), x = legOpenAt(d, k, closeT + h * 60, cache);
        if (e == null || x == null) { skipped++; continue; }
        samples.push({ day: d.day, period, t: closeT, bull: st.bull.state, bear: st.bear.state, side, h, entry: e, exit: x, rise: x > e });
      }
    }
  }
  return { samples, skipped, points };
}

// ---------------------------------------------------------------- statistics
const r1 = (v: number) => Math.round(v * 10) / 10;
function lcg(seed: number) { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); }
/** Day-block bootstrap 95 % interval of (rate in group − baseline rate), both from the same resampled days. */
export function diffCI(all: Sample[], inGroup: (s: Sample) => boolean, iters = 1000, seed = 5) {
  const byDay = new Map<string, Sample[]>(); for (const s of all) byDay.set(s.day, [...(byDay.get(s.day) || []), s]);
  const days = [...byDay.keys()], rnd = lcg(seed), ds: number[] = [];
  for (let it = 0; it < iters; it++) {
    let gn = 0, gr = 0, bn = 0, br = 0;
    for (let k = 0; k < days.length; k++) for (const s of byDay.get(days[Math.floor(rnd() * days.length)])!) { bn++; if (s.rise) br++; if (inGroup(s)) { gn++; if (s.rise) gr++; } }
    if (gn && bn) ds.push((gr / gn - br / bn) * 100);
  }
  ds.sort((a, b) => a - b);
  return ds.length ? [r1(ds[Math.floor(0.025 * ds.length)]), r1(ds[Math.floor(0.975 * ds.length)])] : [null, null];
}
const rate = (a: Sample[]) => (a.length ? (a.filter((s) => s.rise).length / a.length) * 100 : null);
const brier = (a: Sample[], p: number) => (a.length ? a.reduce((x, s) => x + ((s.rise ? 1 : 0) - p / 100) ** 2, 0) / a.length : null);
const nDays = (a: Sample[]) => new Set(a.map((s) => s.day)).size;

export const GROUPS = [
  ...["NONE", "PRE_BREAKOUT", "CONFIRMED_BREAKOUT", "RETEST_HOLD", "FAILED_BREAKOUT"].map((x) => ({ key: `bull:${x}`, test: (s: Sample) => s.bull === x })),
  ...["NONE", "PRE_BREAKDOWN", "CONFIRMED_BREAKDOWN", "RETEST_FAILURE", "FAILED_BREAKDOWN"].map((x) => ({ key: `bear:${x}`, test: (s: Sample) => s.bear === x })),
];
export function evaluate(samples: Sample[], openHoldout: boolean) {
  const rows: any[] = [];
  for (const side of ["CE", "PE"] as const) for (const h of HORIZONS) {
    const pool = samples.filter((s) => s.side === side && s.h === h), by = (p: P) => pool.filter((s) => s.period === p);
    const base = { DEV: rate(by("DEV")), VALIDATION: rate(by("VALIDATION")), HOLDOUT: openHoldout ? rate(by("HOLDOUT")) : null };
    for (const g of GROUPS) {
      const dev = by("DEV").filter(g.test), val = by("VALIDATION").filter(g.test), hold = openHoldout ? by("HOLDOUT").filter(g.test) : [];
      const pd = rate(dev), pv = rate(val), ph = openHoldout ? rate(hold) : null;
      const ci = dev.length ? diffCI(by("DEV"), g.test) : [null, null];
      const c1 = dev.length >= 100 && val.length >= 50 && nDays(dev) >= 10 && nDays(val) >= 10 && (!openHoldout || (hold.length >= 30 && nDays(hold) >= 10));
      const c2 = pd != null && base.DEV != null && Math.abs(pd - base.DEV) >= 5 && ci[0] != null && (ci[0] > 0 || ci[1]! < 0);
      const sameSide = (p: number | null, b: number | null) => p != null && b != null && pd != null && base.DEV != null && Math.sign(p - b) === Math.sign(pd - base.DEV);
      const c3 = pv != null && Math.abs(pv - pd!) <= 8 && sameSide(pv, base.VALIDATION) && (!openHoldout || (ph != null && Math.abs(ph - pd!) <= 8 && sameSide(ph, base.HOLDOUT)));
      const bDev = openHoldout && pd != null ? brier(hold, pd) : null, bBase = openHoldout && base.DEV != null ? brier(hold, base.DEV) : null;
      const c4 = openHoldout ? bDev != null && bBase != null && bDev < bBase : null;
      const all = [...dev, ...val, ...hold];
      rows.push({ side, h, group: g.key, n: { DEV: dev.length, VALIDATION: val.length, HOLDOUT: openHoldout ? hold.length : null }, days: { DEV: nDays(dev), VALIDATION: nDays(val), HOLDOUT: openHoldout ? nDays(hold) : null },
        risePct: { DEV: pd != null ? r1(pd) : null, VALIDATION: pv != null ? r1(pv) : null, HOLDOUT: ph != null ? r1(ph) : null },
        baselinePct: { DEV: base.DEV != null ? r1(base.DEV) : null, VALIDATION: base.VALIDATION != null ? r1(base.VALIDATION) : null, HOLDOUT: base.HOLDOUT != null ? r1(base.HOLDOUT) : null },
        devDiffCI: ci, brierHoldout: { devRate: bDev, baseline: bBase },
        checks: { sample: c1, differsFromBaseline: c2, stable: c3, brier: c4 },
        validated: openHoldout ? !!(c1 && c2 && c3 && c4) : null,
        allPeriodsRisePct: all.length ? r1(rate(all)!) : null, allN: all.length,
        meanChangePts: all.length ? Math.round((all.reduce((a, s) => a + (s.exit - s.entry), 0) / all.length) * 100) / 100 : null });
    }
  }
  return rows;
}

if (require.main === module) {
  const openHoldout = process.argv.includes("--holdout");
  const { days } = assemble(PERIODS.DEV[0], PERIODS.HOLDOUT[1]);
  const { samples, skipped, points } = collect(days);
  const rows = evaluate(samples, openHoldout);
  const summary = { generated: new Date().toISOString(), holdoutOpened: openHoldout, days: days.length, decisionPoints: points, samples: samples.length, skippedMissingMinute: skipped,
    stateCounts: samples.filter((s) => s.side === "CE" && s.h === 5).reduce((m: any, s) => { m["bull:" + s.bull] = (m["bull:" + s.bull] || 0) + 1; m["bear:" + s.bear] = (m["bear:" + s.bear] || 0) + 1; return m; }, {}),
    validated: openHoldout ? rows.filter((r) => r.validated) : null };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, openHoldout ? "results_with_holdout.json" : "results_dev_val.json"), JSON.stringify({ summary, rows }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  for (const r of rows) console.log(`${r.side} ${String(r.h).padStart(2)}m ${r.group.padEnd(26)} n ${String(r.n.DEV).padStart(5)}/${String(r.n.VALIDATION).padStart(5)}/${String(r.n.HOLDOUT ?? "-").padStart(5)} rise ${r.risePct.DEV}/${r.risePct.VALIDATION}/${r.risePct.HOLDOUT ?? "-"} base ${r.baselinePct.DEV}/${r.baselinePct.VALIDATION}/${r.baselinePct.HOLDOUT ?? "-"} ci ${r.devDiffCI} ${Object.entries(r.checks).map(([k, v]) => (v ? "✓" : v === false ? "✗" : "·") + k).join(" ")}${r.validated ? "  ← VALIDATED" : ""}`);
}
