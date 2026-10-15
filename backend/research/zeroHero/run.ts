import fs from "fs";
import path from "path";
import { assemble, istHm, DayData, Min } from "../nifty20/data";
import { charges, expiryFor } from "../nifty20/costs";
import { assembleIndex } from "../multiIndex/data";
import { DATA_DIR } from "../../config/dataDir";

// ============================ Zero-hero study (PREREGISTRATION.md, research only) ============================
// npx tsx backend/research/zeroHero/run.ts NIFTY|SENSEX [--holdout <variant>]
const PERIODS = { DEV: ["2024-10-14", "2025-10-31"], VALIDATION: ["2025-11-01", "2026-05-31"], HOLDOUT: ["2026-06-01", "2026-10-12"] } as const;
type P = keyof typeof PERIODS;
const periodOf = (d: string): P | null => (Object.keys(PERIODS) as P[]).find((p) => d >= PERIODS[p][0] && d <= PERIODS[p][1]) || null;
const minOf = (t: number) => { const [h, m] = istHm(t).split(":").map(Number); return h * 60 + m; };
const CFG = { NIFTY: { step: 50, lot: 75 }, SENSEX: { step: 100, lot: 20 } } as const;
type Ix = keyof typeof CFG;
const SIGNALS = ["A", "B"] as const, EXITS = ["HOLD", "SCALE", "STOP50"] as const;
export interface ZTrade { day: string; period: P; v: string; side: "CE" | "PE"; sig: string; strike: number; entry: number; exit: number; multiple: number; net: number; why: string }

/** Expiry-day test: ATM CE+PE time value at 15:20 < 0.08 % of spot. */
export function looksLikeExpiry(d: DayData, step: number): boolean {
  const t = [...d.spot.keys()].find((x) => istHm(x) === "15:20"); if (!t) return false;
  const s = d.spot.get(t)!, k = Math.round(s / step) * step;
  const pc = (side: string) => d.legs.get(`${k}${side}`)?.find((b) => b.t === t)?.c;
  const ce = pc("CE"), pe = pc("PE"); if (ce == null || pe == null) return false;
  const tv = ce + pe - Math.abs(s - k);
  return tv < 0.0008 * s;
}

export function runZH(ix: Ix, days: DayData[]) {
  const { step, lot } = CFG[ix], out: ZTrade[] = [];
  let agree = 0, compared = 0;
  for (const d of days) {
    const period = periodOf(d.day); if (!period) continue;
    const heur = looksLikeExpiry(d, step);
    let isExp = heur;
    if (ix === "NIFTY") { const cal = expiryFor(d.day).isExpiryDay; compared++; if (cal === heur) agree++; isExp = cal; }
    if (!isExp) continue;
    const m = [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => minOf(t) >= 555 && minOf(t) <= 929) as [number, number][];
    if (m.length < 300) continue;
    const spotAt = new Map(m), cache = new Map<string, Map<number, Min>>();
    const leg = (k: string) => { let x = cache.get(k); if (!x) { x = new Map((d.legs.get(k) || []).map((b) => [b.t, b])); cache.set(k, x); } return x; };
    const val = (k: string, strike: number, side: "CE" | "PE", t: number, f: "o" | "c") => {
      const b = leg(k).get(t); if (b && b[f] > 0) return b[f];
      const s = spotAt.get(t) ?? [...spotAt.entries()].filter(([x]) => x <= t).pop()?.[1]; if (s == null) return 0;
      return Math.max(0, side === "CE" ? s - strike : strike - s);   // out of the data window → intrinsic (pessimistic)
    };
    // 5-min bars
    const b5: { time: number; high: number; low: number; close: number }[] = [];
    for (const [t, p] of m) { const st = t - ((minOf(t) - 555) % 5) * 60, last = b5[b5.length - 1]; if (!last || last.time !== st) b5.push({ time: st, high: p, low: p, close: p }); else { last.high = Math.max(last.high, p); last.low = Math.min(last.low, p); last.close = p; } }
    for (const sigType of SIGNALS) {
      const fired = new Set<string>();
      for (let j = 1; j < b5.length; j++) {
        const bar = b5[j], c = bar.time + 300; if (minOf(c) < 810 || minOf(c) > 885) continue;
        const prior = b5.slice(0, j), dayHi = Math.max(...prior.map((x) => x.high)), dayLo = Math.min(...prior.map((x) => x.low));
        for (const side of ["CE", "PE"] as const) {
          if (fired.has(side)) continue;
          if (side === "CE" ? !(bar.close > dayHi) : !(bar.close < dayLo)) continue;
          const s0 = spotAt.get(c - 60) ?? bar.close, atm = Math.round(s0 / step) * step, strike = side === "CE" ? atm + 2 * step : atm - 2 * step, k = `${strike}${side}`;
          if (sigType === "B") {
            const oiAt = (t: number) => { for (let q = 0; q <= 5; q++) { const x = leg(k).get(t - q * 60); if (x?.oi != null) return x.oi; } return null; };
            const o1 = oiAt(c - 15 * 60), o2 = oiAt(c - 60); if (o1 == null || o2 == null || !(o2 < o1)) continue;
          }
          const e = leg(k).get(c)?.o; if (!(e! > 0)) continue;
          fired.add(side);
          for (const ex of EXITS) {
            let exitVal = 0, why = "15:20", half: number | null = null;
            for (let t = c; ; t += 60) {
              const mm = minOf(t);
              if (mm >= 920) { exitVal = val(k, strike, side, t, "o"); break; }
              const pc = val(k, strike, side, t, "c");
              if (ex === "SCALE" && half == null && pc >= 3 * e!) half = pc;
              if (ex === "STOP50" && pc <= 0.5 * e!) { exitVal = val(k, strike, side, t + 60, "o"); why = "stop -50%"; break; }
            }
            const gross = half != null ? 0.5 * (half - e!) + 0.5 * (exitVal - e!) : exitVal - e!;
            const slip = 0.5, ch = charges(e! + slip, Math.max(0.05, (half != null ? (half + exitVal) / 2 : exitVal) - slip), lot).total / lot;
            const net = gross - 2 * slip - ch;
            out.push({ day: d.day, period, v: `${sigType}_${ex}`, side, sig: istHm(c), strike, entry: e!, exit: half != null ? (half + exitVal) / 2 : exitVal, multiple: Math.round(((half != null ? (half + exitVal) / 2 : exitVal) / e!) * 100) / 100, net: Math.round(net * 100) / 100, why: half != null ? "half at 3x" : why });
          }
        }
      }
    }
  }
  return { trades: out, calendarAgreement: compared ? Math.round((agree / compared) * 1000) / 10 : null };
}
export function zstats(t: ZTrade[]) {
  const n = t.length; if (!n) return { n: 0 } as any;
  const tot = t.reduce((s, x) => s + x.net, 0); let streak = 0, worst = 0;
  for (const x of t) { streak = x.net <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
  return { n, hit2xPct: Math.round((t.filter((x) => x.multiple >= 2).length / n) * 1000) / 10, winPct: Math.round((t.filter((x) => x.net > 0).length / n) * 1000) / 10, avgNet: Math.round((tot / n) * 100) / 100, totalNet: Math.round(tot), best: Math.max(...t.map((x) => x.net)), worst: Math.min(...t.map((x) => x.net)), longestLosingStreak: worst, avgEntry: Math.round((t.reduce((s, x) => s + x.entry, 0) / n) * 100) / 100 };
}

if (require.main === module) {
  const ix = (process.argv[2] || "NIFTY") as Ix, hi = process.argv.indexOf("--holdout"), hv = hi > 0 ? process.argv[hi + 1] : null;
  const days = ix === "NIFTY" ? assemble("2024-10-14", "2026-10-12").days : assembleIndex("SENSEX", "2024-10-14", "2026-10-12");
  const { trades, calendarAgreement } = runZH(ix, days);
  const vs = [...new Set(trades.map((t) => t.v))].filter((v) => !hv || v === hv);
  const res: any = { index: ix, calendarAgreement, expiryDays: new Set(trades.map((t) => t.day)).size, variants: {} };
  for (const v of vs) { const t = trades.filter((x) => x.v === v); res.variants[v] = { DEV: zstats(t.filter((x) => x.period === "DEV")), VALIDATION: zstats(t.filter((x) => x.period === "VALIDATION")), ...(hv ? { HOLDOUT: zstats(t.filter((x) => x.period === "HOLDOUT")) } : {}) }; }
  const OUT = path.join(DATA_DIR, "research-zero-hero"); fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${ix}${hv ? "_holdout" : ""}.json`), JSON.stringify(res, null, 1));
  fs.writeFileSync(path.join(OUT, `${ix}_trades.csv`), ["day,period,v,side,sig,strike,entry,exit,multiple,net,why"].concat(trades.filter((t) => !hv || t.v === hv).filter((t) => hv || t.period !== "HOLDOUT").map((t) => [t.day, t.period, t.v, t.side, t.sig, t.strike, t.entry, t.exit, t.multiple, t.net, t.why].join(","))).join("\n"));
  console.log(ix, "expiry days with a signal:", res.expiryDays, "| NIFTY calendar vs heuristic agreement %:", calendarAgreement);
  for (const [k, r] of Object.entries<any>(res.variants)) console.log(k.padEnd(10), "DEV", JSON.stringify(r.DEV), "\n           VAL", JSON.stringify(r.VALIDATION), r.HOLDOUT ? "\n           HOLD " + JSON.stringify(r.HOLDOUT) : "");
}
