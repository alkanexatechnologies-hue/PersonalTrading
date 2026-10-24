// ProTrader REGIME STUDY (owner's brief, 2026-10-25) — validates research/regime/marketRegime.ts. Research only.
// PRE-REGISTERED:
//  Data      real Dhan 1-min NIFTY + SENSEX spot and ATM option legs → completed 5m / 15m candles (spot has no volume:
//            session TWAP is the VWAP proxy). Periods: DEV 60 % · VAL 20 % · TEST 20 % of sessions, 1 purged at each boundary.
//  Points    every completed 15m candle close 09:45 … 14:30 (forward hour inside the session).
//  Truth     next 60 min of 5m closes: fER = |net| / Σ|5m changes|; TREND_UP if fER ≥ 0.4 and net ≥ +1 × ATR15,
//            TREND_DOWN mirror, CHOP if fER < 0.25, else MIXED. Backward truth (the previous 60 min, same rule) defines trend
//            EPISODES for the detection delay.
//  Metrics   false-trend rate (TRENDING_x not followed by TREND_x), missed trends (TREND_x not called TRENDING_x), chop
//            precision (CHOPPY followed by CHOP), label shares, mean regime duration (15m candles), detection delay of
//            backward trend episodes (candles until TRENDING_x; undetected within the episode = missed).
//  Compared  baseline (close vs EMA21 + 3-candle EMA direction) and one-feature ablations.
//  Applied   the PT signals of emaCrossStudy (premium EMA9×EMA21 trigger, index past EMA21): win % at 1:1 and option net by
//            regime; GATE = CE only in TRENDING_UP, PE only in TRENDING_DOWN, WAIT otherwise. Last 15 sessions first.
import { assemble, DayData, Min } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";
import { expiryDays } from "./premiumBacktest2";
import { run as ptRun } from "./emaCrossStudy";
import { classifyRegime, baselineRegime, REGIME_DEFAULTS, RegimeConfig, Regime, Candle } from "../regime/marketRegime";

const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const bars = (mins: [number, number][], n: number): Candle[] => {
  const out: Candle[] = []; let cur: Candle | null = null, key = -1;
  for (const [t, p] of mins) { const m = mn(t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / n);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (m - 555 - k * n) * 60, open: p, high: p, low: p, close: p }; key = k; }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out;
};
const CFGS: [string, RegimeConfig][] = [
  ["FULL", REGIME_DEFAULTS],
  ["− ER", { ...REGIME_DEFAULTS, use: { ...REGIME_DEFAULTS.use, er: false } }],
  ["− ADX", { ...REGIME_DEFAULTS, use: { ...REGIME_DEFAULTS.use, adx: false } }],
  ["− slope", { ...REGIME_DEFAULTS, use: { ...REGIME_DEFAULTS.use, slope: false } }],
  ["− VWAP crosses", { ...REGIME_DEFAULTS, use: { ...REGIME_DEFAULTS.use, vwap: false } }],
  ["− compression", { ...REGIME_DEFAULTS, use: { ...REGIME_DEFAULTS.use, compression: false } }],
  ["− premium", { ...REGIME_DEFAULTS, usePremium: false }],
];
type Pt = { ix: string; day: string; set: string; T: number; tb: string; exp: boolean; truth: string; back: string; lab: Record<string, Regime> };

export function prepare(ix: "NIFTY" | "SENSEX", days: DayData[], step: number) {
  const ds = days.filter((d) => d.spot.size >= 300), N = ds.length, d1 = Math.floor(N * 0.6), d2 = Math.floor(N * 0.8), exp = expiryDays(ds, step);
  const setOf = (i: number) => (i === d1 || i === d2 ? "PURGE" : i < d1 ? "DEV" : i < d2 ? "VAL" : "TEST");
  const c5: Candle[] = [], c15: Candle[] = [], legs = new Map<string, Map<string, Map<number, number>>>(), mins = new Map<string, [number, number][]>();
  for (const d of ds) {
    const m = [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][];
    mins.set(d.day, m); c5.push(...bars(m, 5)); c15.push(...bars(m, 15));
    const L = new Map<string, Map<number, number>>(); for (const [k, arr] of d.legs) L.set(k, new Map(arr.map((x: Min) => [x.t, x.c]))); legs.set(d.day, L);
  }
  const ptr = (arr: Candle[], T: number, tf: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].time + tf <= T) lo = mid + 1; else hi = mid; } return lo; };   // count of completed
  const premAt = (day: string, k: string, t: number) => { const m = legs.get(day)?.get(k); if (!m) return null; for (let j = 1; j <= 4; j++) { const v = m.get(t - 60 * j); if (v != null) return v; } return null; };
  const regimeAt = (day: string, T: number, cfg: RegimeConfig) => {
    const i15 = ptr(c15, T, 900), i5 = ptr(c5, T, 300), w15 = c15.slice(Math.max(0, i15 - 70), i15), w5 = c5.slice(Math.max(0, i5 - 160), i5);
    const last = w5[w5.length - 1]; let prem = null;
    if (last) { const atm = Math.round(last.close / step) * step, ends = w5.slice(-4).map((c) => c.time + 300); prem = { ce: ends.map((e) => premAt(day, `${atm}CE`, e)), pe: ends.map((e) => premAt(day, `${atm}PE`, e)) }; }
    return { r: classifyRegime(w15, w5, T, prem, cfg), b: baselineRegime(w15, T) };
  };
  const truthOf = (m: [number, number][], from: number, to: number, a15: number) => {
    const p = m.filter(([t]) => t >= from && t < to && (t - from) % 300 === 240).map(([, v]) => v);   // 5m closes = the last minute of each 5m
    const s = m.filter(([t]) => t < from).pop()?.[1]; if (s == null || p.length < 10) return "NA";
    const seq = [s, ...p]; let path = 0; for (let i = 1; i < seq.length; i++) path += Math.abs(seq[i] - seq[i - 1]);
    const net = seq[seq.length - 1] - s, er = path ? Math.abs(net) / path : 0;
    return er >= 0.4 && net >= a15 ? "TREND_UP" : er >= 0.4 && net <= -a15 ? "TREND_DOWN" : er < 0.25 ? "CHOP" : "MIXED";
  };
  const points: Pt[] = [];
  ds.forEach((d, di) => {
    const set = setOf(di); if (set === "PURGE") return; const m = mins.get(d.day)!;
    for (let k = 2; k <= 21; k++) {   // 15m closes 09:45 … 14:30
      const T = Math.floor((Date.parse(d.day + "T03:45:00Z")) / 1000) + k * 900, lab: Record<string, Regime> = {};
      let a15 = 0; for (const [name, cfg] of CFGS) { const { r, b } = regimeAt(d.day, T, cfg); lab[name] = r.regime; lab.BASELINE = b; if (name === "FULL") a15 = r.features.atr15 ?? 0; }
      if (!a15) { const i15 = ptr(c15, T, 900), w = c15.slice(Math.max(0, i15 - 15), i15); let s = 0; for (let j = 1; j < w.length; j++) s += Math.max(w[j].high - w[j].low, Math.abs(w[j].high - w[j - 1].close), Math.abs(w[j].low - w[j - 1].close)); a15 = s / Math.max(1, w.length - 1); }
      const mm = mn(T), tb = mm < 645 ? "open 09:45–10:45" : mm < 810 ? "mid 10:45–13:30" : "late 13:30–14:30";
      points.push({ ix, day: d.day, set, T, tb, exp: exp.has(d.day), truth: truthOf(m, T, T + 3600, a15), back: truthOf(m, T - 3600, T, a15), lab });
    }
  });
  return { points, regimeAt, days: ds.map((d) => d.day), setOf: (day: string) => setOf(ds.findIndex((d) => d.day === day)), exp };
}

const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");
function metrics(P: Pt[], name: string) {
  const L = (p: Pt) => p.lab[name], tr = P.filter((p) => L(p) === "TRENDING_UP" || L(p) === "TRENDING_DOWN");
  const good = tr.filter((p) => (L(p) === "TRENDING_UP" ? p.truth === "TREND_UP" : p.truth === "TREND_DOWN")).length;
  const opp = tr.filter((p) => (L(p) === "TRENDING_UP" ? p.truth === "TREND_DOWN" : p.truth === "TREND_UP")).length;
  const realT = P.filter((p) => p.truth === "TREND_UP" || p.truth === "TREND_DOWN"), missed = realT.filter((p) => L(p) !== (p.truth === "TREND_UP" ? "TRENDING_UP" : "TRENDING_DOWN")).length;
  const ch = P.filter((p) => L(p) === "CHOPPY"), chOk = ch.filter((p) => p.truth === "CHOP").length, chTrend = ch.filter((p) => p.truth.startsWith("TREND")).length;
  const share = (r: string) => pct(P.filter((p) => L(p) === r).length, P.length);
  // durations: runs of the same label inside a day
  let runs = 0, len = 0; const byDay = new Map<string, Pt[]>(); for (const p of P) (byDay.get(p.ix + p.day) || byDay.set(p.ix + p.day, []).get(p.ix + p.day)!).push(p);
  for (const ps of byDay.values()) { let prev = ""; for (const p of ps) { if (L(p) !== prev) runs++; len++; prev = L(p); } }
  // detection delay of backward trend episodes
  const delays: number[] = []; let eps = 0, det = 0;
  for (const ps of byDay.values()) for (let i = 0; i < ps.length; i++) {
    const b = ps[i].back; if (!b.startsWith("TREND") || (i > 0 && ps[i - 1].back === b)) continue;
    eps++; const want = b === "TREND_UP" ? "TRENDING_UP" : "TRENDING_DOWN"; let j = i, hit = -1;
    while (j < ps.length && (j === i || ps[j].back === b || j - i <= 2)) { if (L(ps[j]) === want) { hit = j - i; break; } j++; if (j - i > 4) break; }
    if (hit >= 0) { det++; delays.push(hit); }
  }
  delays.sort((a, b) => a - b);
  return { n: P.length, trendCalls: tr.length, trendRight: pct(good, tr.length), trendOpposite: pct(opp, tr.length), falseTrend: pct(tr.length - good, tr.length),
    realTrends: realT.length, missed: pct(missed, realT.length), chopCalls: ch.length, chopRight: pct(chOk, ch.length), chopThenTrend: pct(chTrend, ch.length),
    shares: `CHOP ${share("CHOPPY")} · UP ${share("TRENDING_UP")} · DOWN ${share("TRENDING_DOWN")} · COMP ${share("COMPRESSION")} · TRANS ${share("TRANSITION")} · UNKNOWN ${share("UNKNOWN_DATA")}`,
    duration: (len / Math.max(1, runs)).toFixed(2), episodes: eps, detected: pct(det, eps), delayMedian: delays.length ? delays[Math.floor(delays.length / 2)] : null };
}
const show = (lab: string, m: ReturnType<typeof metrics>) =>
  console.log(`  ${lab.padEnd(26)} trend calls ${String(m.trendCalls).padStart(4)} · right ${m.trendRight.padStart(6)} · false ${m.falseTrend.padStart(6)} (opposite ${m.trendOpposite}) · missed trends ${m.missed} of ${m.realTrends} · chop calls ${m.chopCalls} right ${m.chopRight} (then trend ${m.chopThenTrend}) · run ${m.duration} · episodes ${m.episodes} detected ${m.detected} delay ${m.delayMedian ?? "—"}`);

if (require.main === module) {
  const to = latestRawDay();
  const prep = { NIFTY: prepare("NIFTY", assemble(FROM, to).days, 50), SENSEX: prepare("SENSEX", assembleIndex("SENSEX", FROM, to), 100) };
  const all = [...prep.NIFTY.points, ...prep.SENSEX.points];
  const base = (P: Pt[]) => ({ up: pct(P.filter((p) => p.truth === "TREND_UP").length, P.length), dn: pct(P.filter((p) => p.truth === "TREND_DOWN").length, P.length), ch: pct(P.filter((p) => p.truth === "CHOP").length, P.length) });
  console.log(`REGIME STUDY · data ${FROM} → ${to} · ${all.length} evaluation points (15m closes 09:45–14:30)`);

  // ---------------- PT signals by regime: LAST 15 SESSIONS FIRST ----------------
  const pt: Record<string, any[]> = {};
  for (const [ix, days] of [["NIFTY", assemble(FROM, to).days], ["SENSEX", assembleIndex("SENSEX", FROM, to)]] as const) pt[ix] = ptRun(ix as any, days as any).sigs.filter((x: any) => x.pt);
  const tag = (ix: "NIFTY" | "SENSEX", x: any) => prep[ix].regimeAt(x.day, x.t, REGIME_DEFAULTS).r.regime;
  const gate = (r: string, dir: number) => (r === "TRENDING_UP" && dir > 0) || (r === "TRENDING_DOWN" && dir < 0);
  const ptLine = (lab: string, xs: any[]) => { const n = xs.length, w = xs.filter((x) => x.t1.win).length, nets = xs.filter((x) => x.netPct != null);
    console.log(`    ${lab.padEnd(34)} ${String(n).padStart(4)} signals · win ${pct(w, n).padStart(6)} · stop ${pct(xs.filter((x) => x.t1.stop).length, n).padStart(6)} · option net ${nets.length ? (nets.reduce((a, x) => a + x.netPct, 0) / nets.length).toFixed(1) + "%" : "—"}`); };
  for (const [title, pick] of [["LAST 15 SESSIONS", (ix: "NIFTY" | "SENSEX", x: any) => prep[ix].days.slice(-15).includes(x.day)], ["DEV", (ix: any, x: any) => prep[ix as "NIFTY"].setOf(x.day) === "DEV"], ["VAL", (ix: any, x: any) => prep[ix as "NIFTY"].setOf(x.day) === "VAL"], ["TEST (untouched)", (ix: any, x: any) => prep[ix as "NIFTY"].setOf(x.day) === "TEST"]] as const) {
    console.log(`\nPT SIGNALS BY REGIME · ${title}`);
    for (const ix of ["NIFTY", "SENSEX"] as const) {
      const xs = pt[ix].filter((x) => pick(ix, x)).map((x) => ({ ...x, reg: tag(ix, x) }));
      console.log(`  ${ix}`); ptLine("all PT signals", xs);
      for (const r of ["TRENDING_UP", "TRENDING_DOWN", "CHOPPY", "TRANSITION", "COMPRESSION", "UNKNOWN_DATA"]) { const g = xs.filter((x) => x.reg === r); if (g.length) ptLine(`in ${r}`, g); }
      ptLine("GATE: CE in UP / PE in DOWN only", xs.filter((x) => gate(x.reg, x.dir)));
      ptLine("signals the gate turns into WAIT", xs.filter((x) => !gate(x.reg, x.dir)));
      ptLine("CHOPPY removed only", xs.filter((x) => x.reg !== "CHOPPY"));
      if (title === "LAST 15 SESSIONS") for (const x of xs) console.log(`      ${x.day} ${new Date((x.t - 300 + 19800) * 1000).toISOString().slice(11, 16)} ${x.dir > 0 ? "CE" : "PE"} ${x.t1.win ? "WIN " : x.t1.stop ? "STOP" : "TIME"} · regime ${x.reg}${gate(x.reg, x.dir) ? "" : " → WAIT"}`);
    }
  }

  // ---------------- classification quality ----------------
  for (const set of ["DEV", "VAL", "TEST"]) {
    const P = all.filter((p) => p.set === set), b = base(P);
    console.log(`\nCLASSIFICATION · ${set} · ${P.length} points · forward truth: TREND_UP ${b.up} · TREND_DOWN ${b.dn} · CHOP ${b.ch}`);
    show("BASELINE (EMA21)", metrics(P, "BASELINE"));
    for (const [name] of CFGS) show(name === "FULL" ? "FULL detector" : `ablation ${name}`, metrics(P, name));
    console.log(`  label shares (FULL): ${metrics(P, "FULL").shares}`);
  }
  console.log(`\nBY INDEX AND SESSION TYPE (FULL detector, all periods)`);
  for (const [lab, f] of [["NIFTY", (p: Pt) => p.ix === "NIFTY"], ["SENSEX", (p: Pt) => p.ix === "SENSEX"], ["open 09:45–10:45", (p: Pt) => p.tb.startsWith("open")], ["mid 10:45–13:30", (p: Pt) => p.tb.startsWith("mid")], ["late 13:30–14:30", (p: Pt) => p.tb.startsWith("late")], ["expiry days", (p: Pt) => p.exp], ["other days", (p: Pt) => !p.exp]] as const)
    show(lab, metrics(all.filter(f), "FULL"));
  process.exit(0);
}
