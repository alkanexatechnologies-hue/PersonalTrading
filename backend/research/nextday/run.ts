import fs from "fs";
import path from "path";
import { loadSessions, Session } from "./data";
import { featuresAt, classify, Features, Model, Call } from "./features";
import { outcomeFor, grade, Outcome, Graded } from "./outcomes";
import { ND_DIR } from "./download";
import { assemble } from "../nifty20/data";
import { buildNextDayPick } from "../../nextday/outlook";
import { DEFAULT_SYMBOLS } from "../../config";
import type { Candle } from "../../types";

// ============================ Next-day study — runner (pre-registered, research only) ============================
// npx tsx backend/research/nextday/run.ts            → DEV + VALIDATION + walk-forward (HOLDOUT stays closed)
// npx tsx backend/research/nextday/run.ts --holdout  → also opens HOLDOUT (once, at the end)

export const PERIODS = { DEV: ["2024-10-14", "2025-10-31"], VALIDATION: ["2025-11-01", "2026-05-31"], HOLDOUT: ["2026-06-01", "2026-10-13"] } as const;
type P = keyof typeof PERIODS;
const inP = (d: string, p: P) => d >= PERIODS[p][0] && d <= PERIODS[p][1];
export const K_GRID = [0.1, 0.2, 0.3, 0.4];
const MODELS: Model[] = ["A", "B", "C", "D"];
const OUT = path.join(ND_DIR, "results");
const r1 = (v: number) => Math.round(v * 10) / 10, r2 = (v: number) => Math.round(v * 100) / 100;

export interface Row { f: Features; o: Outcome }
export function wilson(h: number, n: number) {
  if (!n) return [null, null];
  const z = 1.96, p = h / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, w = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [r1((c - w) * 100), r1((c + w) * 100)];
}
export function binomP(h: number, n: number) {   // two-sided vs 50 %, normal approximation with continuity correction
  if (!n) return null;
  const z = (Math.abs(h - n / 2) - 0.5) / Math.sqrt(n / 4), cdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
  return r2(Math.max(0, 2 * (1 - cdf(Math.max(0, z)))) * 100) / 100;
}
function erf(x: number) { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }

export function metrics(calls: Call[], rows: Row[]) {
  const g: Graded[] = calls.map((c, i) => grade(c, rows[i].o));
  const cnt = (c: Call) => calls.filter((x) => x === c).length;
  const sig = g.filter((x) => x.o1Hit != null), hits = sig.filter((x) => x.o1Hit).length;
  const bull = g.filter((x) => x.call === "BULLISH" && x.o1Hit != null), bear = g.filter((x) => x.call === "BEARISH" && x.o1Hit != null);
  const ups = rows.map((r, i) => ({ o: r.o.o1, c: calls[i] }));
  const recUp = ups.filter((x) => x.o === "UP"), recDn = ups.filter((x) => x.o === "DOWN");
  const recallUp = recUp.length ? recUp.filter((x) => x.c === "BULLISH").length / recUp.length : null, recallDn = recDn.length ? recDn.filter((x) => x.c === "BEARISH").length / recDn.length : null;
  const precUp = bull.length ? bull.filter((x) => x.o1Hit).length / bull.length : null, precDn = bear.length ? bear.filter((x) => x.o1Hit).length / bear.length : null;
  const o2 = g.filter((x) => x.o2Hit != null), o3 = g.filter((x) => x.o3Hit != null);
  const pnl = g.map((x) => x.pnl).filter((v): v is number => v != null);
  let eq = 0, peak = 0, dd = 0; for (const v of pnl) { eq += v; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  const neu = g.filter((x) => x.neutralHit != null);
  const conf: Record<string, Record<string, number>> = {};
  calls.forEach((c, i) => { const o = rows[i].o.o1 || "FLAT"; conf[c] = conf[c] || {}; conf[c][o] = (conf[c][o] || 0) + 1; });
  return {
    days: calls.length, classes: { BULLISH: cnt("BULLISH"), BEARISH: cnt("BEARISH"), NEUTRAL: cnt("NEUTRAL"), NO_EDGE: cnt("NO_EDGE"), INSUFFICIENT_DATA: cnt("INSUFFICIENT_DATA") },
    coveragePct: calls.length ? r1((sig.length / calls.length) * 100) : 0,
    o1: { n: sig.length, hits, hitPct: sig.length ? r1((hits / sig.length) * 100) : null, ci95: wilson(hits, sig.length), pVs50: binomP(hits, sig.length) },
    bullishPrecisionPct: precUp == null ? null : r1(precUp * 100), bearishPrecisionPct: precDn == null ? null : r1(precDn * 100),
    bullishRecallPct: recallUp == null ? null : r1(recallUp * 100), bearishRecallPct: recallDn == null ? null : r1(recallDn * 100),
    balancedAccuracyPct: precUp != null && precDn != null ? r1(((precUp + precDn) / 2) * 100) : null,
    o2FirstTouch: { n: o2.length, hitPct: o2.length ? r1((o2.filter((x) => x.o2Hit).length / o2.length) * 100) : null },
    o3PrevDayLevel: { n: o3.length, hitPct: o3.length ? r1((o3.filter((x) => x.o3Hit).length / o3.length) * 100) : null },
    o4OpenToClose: { trades: pnl.length, expectancyPts: pnl.length ? r1(pnl.reduce((a, b) => a + b, 0) / pnl.length) : null, totalPts: r1(pnl.reduce((a, b) => a + b, 0)), maxDrawdownPts: r1(dd) },
    neutral: { n: neu.length, hitPct: neu.length ? r1((neu.filter((x) => x.neutralHit).length / neu.length) * 100) : null },
    confusion: conf,
  };
}
/** k from the grid with the best O1 hit rate among calls, needing ≥ 30 % coverage (ties → larger k). */
export function chooseK(rows: Row[], m: Model): number {
  let best = K_GRID[0], bestHit = -1;
  for (const k of K_GRID) {
    const mm = metrics(rows.map((r) => classify(r.f, m, k)), rows);
    if (mm.coveragePct >= 30 && mm.o1.hitPct != null && mm.o1.hitPct >= bestHit) { best = k; bestHit = mm.o1.hitPct; }
  }
  return best;
}
/** Paired day bootstrap of (hit rate X − hit rate A) on the same days; 95 % interval. */
export function pairedDiff(rows: Row[], cx: Call[], ca: Call[], iters = 2000, seed = 11) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rate = (idx: number[], calls: Call[]) => { let n = 0, h = 0; for (const i of idx) { const g = grade(calls[i], rows[i].o); if (g.o1Hit != null) { n++; if (g.o1Hit) h++; } } return n ? h / n : NaN; };
  const all = rows.map((_, i) => i), point = rate(all, cx) - rate(all, ca), ds: number[] = [];
  for (let it = 0; it < iters; it++) { const idx = all.map(() => all[Math.floor(rnd() * all.length)]); const d = rate(idx, cx) - rate(idx, ca); if (Number.isFinite(d)) ds.push(d); }
  ds.sort((a, b) => a - b);
  return { diffPts: r1(point * 100), ci95: [r1(ds[Math.floor(0.025 * ds.length)] * 100), r1(ds[Math.floor(0.975 * ds.length)] * 100)] };
}

function baselines(rows: Row[], sessions: Session[]) {
  const nifty = DEFAULT_SYMBOLS.find((d: any) => d.symbol === "^NSEI")!;
  const byDay = new Map(sessions.map((s, i) => [s.day, i]));
  const always: Call[] = rows.map(() => "BULLISH");
  const prev: Call[] = rows.map((r) => { const i = byDay.get(r.f.day)!; const ch = sessions[i].nifty.c - (sessions[i - 1]?.nifty.c ?? sessions[i].nifty.c); return ch > 0 ? "BULLISH" : ch < 0 ? "BEARISH" : "NEUTRAL"; });
  const pick: Call[] = rows.map((r) => {
    const i = byDay.get(r.f.day)!;
    const daily: Candle[] = sessions.slice(0, i + 1).map((s) => ({ time: Math.floor(Date.parse(s.day + "T10:00:00Z") / 1000), open: s.nifty.o, high: s.nifty.h, low: s.nifty.l, close: s.nifty.c, volume: 0 }));
    const p = buildNextDayPick(nifty as any, daily);
    return !p ? "INSUFFICIENT_DATA" : p.bias === "Bullish" ? "BULLISH" : p.bias === "Bearish" ? "BEARISH" : "NEUTRAL";
  });
  return { ALWAYS_UP: always, PREV_DAY: prev, NEXTDAY_PICK: pick };
}
function splits(rows: Row[], calls: Call[]) {
  const sub = (pred: (r: Row) => boolean) => { const idx = rows.map((r, i) => (pred(r) ? i : -1)).filter((i) => i >= 0); const m = metrics(idx.map((i) => calls[i]), idx.map((i) => rows[i])); return { days: m.days, calls: m.o1.n, hitPct: m.o1.hitPct, ci95: m.o1.ci95 }; };
  return {
    trendUp: sub((r) => r.f.trendUp === true), trendDown: sub((r) => r.f.trendUp === false),
    gapUp: sub((r) => r.o.gapPct > 0.5), gapDown: sub((r) => r.o.gapPct < -0.5), noGap: sub((r) => Math.abs(r.o.gapPct) <= 0.5),
    expiryNear: sub((r) => (r.f.daysToExpiry ?? 9) <= 1), expiryFar: sub((r) => (r.f.daysToExpiry ?? 0) > 1),
    vixLow: sub((r) => (r.f.vix ?? 99) < 14), vixMid: sub((r) => r.f.vix != null && r.f.vix >= 14 && r.f.vix <= 18), vixHigh: sub((r) => (r.f.vix ?? 0) > 18),
  };
}

export function buildRows(sessions: Session[], spot: Map<string, number[]>): Row[] {
  const rows: Row[] = [];
  for (let i = 1; i < sessions.length - 1; i++) {
    // the next row must be the next trading session (guards against a gap in the downloaded files)
    if (Date.parse(sessions[i + 1].day) - Date.parse(sessions[i].day) > 6 * 86400_000) continue;
    const f = featuresAt(sessions.slice(0, i + 1));
    rows.push({ f, o: outcomeFor(sessions[i], sessions[i + 1], f.atr, spot.get(sessions[i + 1].day) || null) });
  }
  return rows;
}

if (require.main === module) {
  const openHoldout = process.argv.includes("--holdout");
  const sessions = loadSessions();
  console.log(`sessions ${sessions.length}: ${sessions[0]?.day} → ${sessions[sessions.length - 1]?.day}`);
  const spot = new Map<string, number[]>();
  for (const d of assemble("2024-10-14", "2026-10-12").days) spot.set(d.day, [...d.spot.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]));
  const all = buildRows(sessions, spot);
  const per = (p: P) => all.filter((r) => inP(r.f.day, p));
  const dev = per("DEV"), val = per("VALIDATION"), hold = per("HOLDOUT");
  const ks = Object.fromEntries(MODELS.map((m) => [m, chooseK(dev, m)])) as Record<Model, number>;
  const periods: P[] = openHoldout ? ["DEV", "VALIDATION", "HOLDOUT"] : ["DEV", "VALIDATION"];
  const res: any = { generated: new Date().toISOString(), holdoutOpened: openHoldout, kFromDev: ks, data: {
    sessions: sessions.length, first: sessions[0]?.day, last: sessions[sessions.length - 1]?.day,
    rows: all.length, insufficientPremium: all.filter((r) => r.f.insufficientPremium).length,
    o2Sources: all.reduce((m: any, r) => ((m[r.o.o2Source + ":" + r.o.o2] = (m[r.o.o2Source + ":" + r.o.o2] || 0) + 1), m), {}),
    upDaysPct: r1((all.filter((r) => r.o.o1 === "UP").length / all.filter((r) => r.o.o1).length) * 100) }, periods: {} };
  for (const p of periods) {
    const rows = per(p), b = baselines(rows, sessions), out: any = {};
    for (const m of MODELS) out[`MODEL_${m}`] = { k: ks[m], ...metrics(rows.map((r) => classify(r.f, m, ks[m])), rows), splits: splits(rows, rows.map((r) => classify(r.f, m, ks[m]))) };
    for (const [name, calls] of Object.entries(b)) out[name] = metrics(calls, rows);
    res.periods[p] = out;
  }
  // premium adds value? paired vs model A on VALIDATION (+ HOLDOUT when opened)
  const evalRows = openHoldout ? [...val, ...hold] : val;
  res.pairedVsA = Object.fromEntries((["B", "C", "D"] as Model[]).map((m) => [m, pairedDiff(evalRows, evalRows.map((r) => classify(r.f, m, ks[m])), evalRows.map((r) => classify(r.f, "A", ks.A)))]));
  // walk-forward: quarters from 2025-11; k from all earlier days only
  const qs: [string, string][] = [];
  for (let y = 2025, q = 4; ; q++) { if (q > 4) { q = 1; y++; } const s = `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`, e = `${y}-${String(q * 3).padStart(2, "0")}-31`; if (s > (openHoldout ? PERIODS.HOLDOUT[1] : PERIODS.VALIDATION[1])) break; qs.push([s < "2025-11-01" ? "2025-11-01" : s, e > (openHoldout ? PERIODS.HOLDOUT[1] : PERIODS.VALIDATION[1]) ? (openHoldout ? PERIODS.HOLDOUT[1] : PERIODS.VALIDATION[1]) : e]); }
  res.walkForward = Object.fromEntries(MODELS.map((m) => {
    const calls: Call[] = [], rows: Row[] = [];
    for (const [s, e] of qs) { const train = all.filter((r) => r.f.day < s), test = all.filter((r) => r.f.day >= s && r.f.day <= e); const k = chooseK(train, m); for (const r of test) { calls.push(classify(r.f, m, k)); rows.push(r); } }
    const mm = metrics(calls, rows); return [m, { days: mm.days, calls: mm.o1.n, hitPct: mm.o1.hitPct, ci95: mm.o1.ci95, expectancyPts: mm.o4OpenToClose.expectancyPts }];
  }));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, openHoldout ? "results_with_holdout.json" : "results_dev_val.json"), JSON.stringify(res, null, 1));
  fs.writeFileSync(path.join(OUT, "features.csv"), ["day,close,atm,expiry,dte,atr,a1,a2,a3,A,b1,b2,B,d1,d2,Dx,nCE,nPE,o1,chg,o2,gapPct"].concat(all.map((r) => [r.f.day, r.f.close, r.f.atm, r.f.expiry, r.f.daysToExpiry, r.f.atr && r2(r.f.atr), r2(r.f.a1), r.f.a2, r.f.a3, r2(r.f.A), r.f.b1 != null ? r2(r.f.b1) : "", r.f.b2 != null ? r2(r.f.b2) : "", r.f.B != null ? r2(r.f.B) : "", r.f.d1 != null ? r2(r.f.d1) : "", r.f.d2 != null ? r2(r.f.d2) : "", r.f.Dx != null ? r2(r.f.Dx) : "", r.f.nCE, r.f.nPE, r.o.o1 || "", r2(r.o.chg), r.o.o2, r2(r.o.gapPct)].join(","))).join("\n"));
  console.log(JSON.stringify({ k: ks, data: res.data, pairedVsA: res.pairedVsA, walkForward: res.walkForward }, null, 1));
  for (const p of periods) { console.log(`\n== ${p}`); for (const [n, m] of Object.entries<any>(res.periods[p])) console.log(n.padEnd(14), `days ${m.days} calls ${m.o1.n} (${m.coveragePct}%) hit ${m.o1.hitPct}% ci ${m.o1.ci95} p ${m.o1.pVs50} | bull ${m.bullishPrecisionPct} bear ${m.bearishPrecisionPct} | O2 ${m.o2FirstTouch.hitPct} O3 ${m.o3PrevDayLevel.hitPct} | O4 exp ${m.o4OpenToClose.expectancyPts} tot ${m.o4OpenToClose.totalPts} dd ${m.o4OpenToClose.maxDrawdownPts} | neutral ${m.neutral.hitPct} (${m.neutral.n})`); }
}
