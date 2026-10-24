// ProTrader study (owner's question, 2026-10-25): on Market Command, when the INDEX 5-min close breaks EMA 21 and at
// the same time the ATM OPTION premium's EMA 9 crosses its EMA 21, how often does a trade win?
// Research only — no live logic. Usage: npx tsx emaCrossStudy.ts
//
// PRE-REGISTERED (fixed before any result was seen):
//  Data     real Dhan 1-min NIFTY + SENSEX spot and ATM±3 option legs, FROM → latest; 5-min candles 09:15–15:30.
//           Periods (sessions, chronological): DEV 60 % · VAL 20 % · TEST 20 %, one session purged at each boundary.
//  Index    EMA 21 on continuous 5-min closes (across days, like the chart). BREAK UP = previous close ≤ its EMA 21 and
//           this close > EMA 21; BREAK DOWN = the mirror. Signals from the 09:20 close to the 14:30 close.
//  Premium  ATM strike at the signal (CE for a break up, PE for a break down); 5-min premium candles of that strike, EMA 9
//           and EMA 21 over the previous session (same strike, not across an expiry) + today, like the option chart.
//           S0 same candle: premium EMA 9 crosses above EMA 21 on the SAME 5-min candle as the index break.
//           S2 within 2 candles: the premium cross happened on this candle or one of the 2 before (no look-ahead).
//           SS already above: premium EMA 9 > EMA 21 at the signal close (a state, not a cross).
//           B0 baseline: the index EMA 21 break alone.
//  Trade    entry = the signal 5-min close; stop = beyond the signal candle (its low for up / high for down), at least
//           0.25 × ATR(14, 5m) away; target 1R (2R as a second read); 60 min on 1-min closes.
//           WIN = target first. Win % = wins / all signals (time-outs are not wins); decided % = wins / (wins + stops).
//  Option   buy the ATM CE / PE at the entry minute, sell at the trade's exit minute; ProTrader costs
//           max(0.5, 0.25 % of premium) per side + ₹40 per lot. Second read: a premium-only exit +20 % / −10 % / 60 min.
//  Random   same-stop baseline: a 1R entry at every 5-min close, matched on direction × stop width (0.25 ATR) × time.
import { assemble, DayData, Min } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";
import { expiryDays } from "./premiumBacktest2";

type Bar = { time: number; open: number; high: number; low: number; close: number };
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const IDX = { NIFTY: { step: 50, lot: 75 }, SENSEX: { step: 100, lot: 20 } } as const;
const COST = (p: number) => Math.max(0.5, 0.0025 * p);
const bars5 = (pts: [number, number][]): Bar[] => {
  const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const [t, p] of pts) { const m = mn(t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / 5);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (m - 555 - k * 5) * 60, open: p, high: p, low: p, close: p }; key = k; }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out;
};
const emaSeries = (xs: number[], n: number) => { const k = 2 / (n + 1); let v: number | null = null; return xs.map((x) => (v = v == null ? x : x * k + v * (1 - k))); };

type Out = { win: boolean; stop: boolean; r: number; tOut: number | null; stopAtr: number };
function trade(path: [number, number][], entry: number, stopPx: number, dir: number, a: number, rr: number): Out {
  const d = Math.max(dir * (entry - stopPx), 0.25 * a), s = entry - dir * d, tg = entry + dir * rr * d;
  for (const [t, p] of path) { if (dir * (p - s) <= 0) return { win: false, stop: true, r: -1, tOut: t, stopAtr: d / a }; if (dir * (p - tg) >= 0) return { win: true, stop: false, r: rr, tOut: t, stopAtr: d / a }; }
  return { win: false, stop: false, r: path.length ? dir * (path[path.length - 1][1] - entry) / d : 0, tOut: path.length ? path[path.length - 1][0] : null, stopAtr: d / a };
}

// FIXED-POINT target (owner, 2026-10-25: "only 30 points"): index +30 pts NIFTY / +100 pts SENSEX (same % move), stop
// beyond the signal candle (≥ 0.25 ATR), 60 min. PREMIUM 30: the ATM option reaches entry + ₹30 before the index stop.
export const PTS = { NIFTY: 30, SENSEX: 100 } as const;
function tradePts(path: [number, number][], entry: number, stopPx: number, dir: number, a: number, pts: number): Out {
  const d = Math.max(dir * (entry - stopPx), 0.25 * a), s = entry - dir * d, tg = entry + dir * pts;
  for (const [t, p] of path) { if (dir * (p - s) <= 0) return { win: false, stop: true, r: -1, tOut: t, stopAtr: d / a }; if (dir * (p - tg) >= 0) return { win: true, stop: false, r: pts / d, tOut: t, stopAtr: d / a }; }
  return { win: false, stop: false, r: path.length ? dir * (path[path.length - 1][1] - entry) / d : 0, tOut: path.length ? path[path.length - 1][0] : null, stopAtr: d / a };
}
interface Sig { ix: string; day: string; set: string; dir: number; tb: string; s0: boolean; s2: boolean; ss: boolean; t1: Out; t2: Out; netPct: number | null; premRule: number | null; tp: Out; tpNet: number | null; p30: { win: boolean; net: number } | null; stopPts: number }

export function run(ix: "NIFTY" | "SENSEX", days: DayData[]) {
  const { step, lot } = IDX[ix], ds = days.filter((d) => d.spot.size >= 300), N = ds.length, d1 = Math.floor(N * 0.6), d2 = Math.floor(N * 0.8);
  const exp = expiryDays(ds, step), setOf = (i: number) => (i === d1 || i === d2 ? "PURGE" : i < d1 ? "DEV" : i < d2 ? "VAL" : "TEST");
  const sigs: Sig[] = [], base: { set: string; dir: number; tb: string; sb: number; win: boolean; winPts: boolean; sbP: number }[] = [], sessions: Record<string, number> = { DEV: 0, VAL: 0, TEST: 0, PURGE: 0 };
  let hist: Bar[] = [], prevLegs: Map<string, Bar[]> | null = null, prevWasExpiry = false;
  ds.forEach((d, di) => {
    const set = setOf(di); sessions[set]++;
    const mins = [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][];
    const B = bars5(mins), all = hist.concat(B), off = hist.length, e21 = emaSeries(all.map((b) => b.close), 21);
    // premium 5-min bars per strike/side, today (+ the previous session for the EMA warm-up, never across an expiry)
    const legBars = new Map<string, Bar[]>(); for (const [k, arr] of d.legs) legBars.set(k, bars5(arr.map((x: Min) => [x.t, x.c] as [number, number])));
    const legIx = new Map<string, Map<number, number>>(); for (const [k, arr] of d.legs) legIx.set(k, new Map(arr.map((x: Min) => [x.t, x.c])));
    const premAt = (k: string, t: number) => { const m = legIx.get(k); if (!m) return null; for (let j = 0; j < 4; j++) { const v = m.get(t - 60 - j * 60); if (v != null) return v; } return null; };
    const emaCache = new Map<string, { times: Map<number, number>; e9: number[]; e21: number[] }>();
    const premEma = (k: string) => { if (emaCache.has(k)) return emaCache.get(k)!; const today = legBars.get(k) || [], prev = !prevWasExpiry && prevLegs?.get(k) || [];
      const ser = prev.concat(today), c = ser.map((b) => b.close), o = { times: new Map(ser.map((b, j) => [b.time, j])), e9: emaSeries(c, 9), e21: emaSeries(c, 21) }; emaCache.set(k, o); return o; };
    const pathFrom = (t0: number) => mins.filter(([t]) => t >= t0 && t < t0 + 3600);
    for (let i = 1; i < B.length; i++) {
      const g = off + i, tEnd = B[i].time + 300, m = mn(tEnd); if (m < 560 || m > 870 || g < 30) continue;
      let a = 0; for (let j = g - 13; j <= g; j++) a += Math.max(all[j].high - all[j].low, Math.abs(all[j].high - all[j - 1].close), Math.abs(all[j].low - all[j - 1].close)); a /= 14;
      const path = pathFrom(tEnd); if (path.length < 20 || set === "PURGE") continue;
      const tb = m < 630 ? "09:15-10:30" : m < 720 ? "10:30-12:00" : m < 810 ? "12:00-13:30" : "13:30-14:30", px = B[i].close;
      for (const dir of [1, -1]) { const o = trade(path, px, dir > 0 ? B[i].low : B[i].high, dir, a, 1), q = tradePts(path, px, dir > 0 ? B[i].low : B[i].high, dir, a, PTS[ix]); base.push({ set, dir, tb, sb: Math.min(12, Math.floor(o.stopAtr / 0.25)), win: o.win, winPts: q.win, sbP: Math.min(12, Math.floor(q.stopAtr * a / PTS[ix] / 0.25)) }); }
      const up = all[g - 1].close <= e21[g - 1] && px > e21[g], dn = all[g - 1].close >= e21[g - 1] && px < e21[g]; if (!up && !dn) continue;
      const dir = up ? 1 : -1, atm = Math.round(px / step) * step, key = `${atm}${dir > 0 ? "CE" : "PE"}`, pe = premEma(key), j = pe.times.get(B[i].time);
      const cross = (q: number) => q >= 1 && pe.e9[q - 1] <= pe.e21[q - 1] && pe.e9[q] > pe.e21[q];
      const ok = j != null && j >= 21;
      const s0 = ok && cross(j!), s2 = ok && (cross(j!) || cross(j! - 1) || cross(j! - 2)), ss = ok && pe.e9[j!] > pe.e21[j!];
      const t1 = trade(path, px, dir > 0 ? B[i].low : B[i].high, dir, a, 1), t2 = trade(path, px, dir > 0 ? B[i].low : B[i].high, dir, a, 2);
      const e0 = premAt(key, tEnd), e1 = t1.tOut != null ? premAt(key, t1.tOut + 60) : null;
      const net = e0 != null && e1 != null ? e1 - e0 - COST(e0) - COST(e1) - 40 / lot : null;
      // premium-only exit: +20 % / −10 % on the option's own 1-min closes, else the 60-min close
      let premRule: number | null = null;
      if (e0 != null) { const m2 = legIx.get(key)!; let exitP: number | null = null; for (let t = tEnd; t < tEnd + 3600 && mn(t) < 930; t += 60) { const v = m2.get(t); if (v == null) continue; exitP = v; if (v >= e0 * 1.2 || v <= e0 * 0.9) break; }
        if (exitP != null) premRule = ((exitP - e0 - COST(e0) - COST(exitP) - 40 / lot) / e0) * 100; }
      const tp = tradePts(path, px, dir > 0 ? B[i].low : B[i].high, dir, a, PTS[ix]), q1 = tp.tOut != null ? premAt(key, tp.tOut + 60) : null;
      const tpNet = e0 != null && q1 != null ? ((q1 - e0 - COST(e0) - COST(q1) - 40 / lot) / e0) * 100 : null;
      // premium +₹30 before the index stop (or 60 min); exit price = +30 on a win, else the premium at the stop / 60 min
      let p30: { win: boolean; net: number } | null = null;
      if (e0 != null) { const m2 = legIx.get(key)!, stopT = t1.stop ? t1.tOut! : tEnd + 3600; let exitP: number | null = null, won = false;
        for (let t = tEnd; t < tEnd + 3600 && mn(t) < 930; t += 60) { const v = m2.get(t); if (v != null) exitP = v; if (v != null && v >= e0 + 30) { won = true; exitP = e0 + 30; break; } if (t >= stopT) break; }
        if (exitP != null) p30 = { win: won, net: exitP - e0 - COST(e0) - COST(exitP) - 40 / lot }; }
      sigs.push({ ix, day: d.day, set, dir, tb, s0, s2, ss, t1, t2, netPct: net != null && e0 ? (net / e0) * 100 : null, premRule, tp, tpNet, p30, stopPts: tp.stopAtr * a });
    }
    hist = all.slice(-200); prevLegs = legBars; prevWasExpiry = exp.has(d.day);
  });
  return { sigs, base, sessions };
}

const wilson = (k: number, n: number) => { if (!n) return [NaN, NaN]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [((c - h) / d) * 100, ((c + h) / d) * 100]; };
const boot = (xs: { day: string; v: number }[]) => { if (xs.length < 5) return [NaN, NaN]; const g = new Map<string, number[]>(); for (const x of xs) (g.get(x.day) || g.set(x.day, []).get(x.day)!).push(x.v); const ds = [...g.values()];
  let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); const ms: number[] = [];
  for (let k = 0; k < 1000; k++) { let s = 0, n = 0; for (let j = 0; j < ds.length; j++) for (const v of ds[Math.floor(rnd() * ds.length)]) { s += v; n++; } ms.push(s / n); } ms.sort((a, b) => a - b); return [ms[25], ms[974]]; };
const f1 = (x: number) => (isFinite(x) ? x.toFixed(1) : "—");

if (require.main === module) {
  const to = latestRawDay(), R = { NIFTY: run("NIFTY", assemble(FROM, to).days), SENSEX: run("SENSEX", assembleIndex("SENSEX", FROM, to)) };
  const bIx = new Map<string, number>(); { const acc = new Map<string, [number, number]>(); for (const r of Object.values(R)) for (const b of r.base) { const k = `${b.set}|${b.dir}|${b.tb}|${b.sb}`, v = acc.get(k) || [0, 0]; v[0] += b.win ? 1 : 0; v[1]++; acc.set(k, v); } for (const [k, [w, n]] of acc) if (n >= 30) bIx.set(k, w / n); }
  const line = (lab: string, xs: Sig[], sess: number) => {
    const n = xs.length; if (!n) return console.log(`  ${lab.padEnd(30)} n     0`);
    const w = xs.filter((x) => x.t1.win).length, st = xs.filter((x) => x.t1.stop).length, w2 = xs.filter((x) => x.t2.win).length, ci = wilson(w, n);
    let bw = 0, bn = 0; for (const x of xs) { const v = bIx.get(`${x.set}|${x.dir}|${x.tb}|${Math.min(12, Math.floor(x.t1.stopAtr / 0.25))}`); if (v != null) { bw += v; bn++; } }
    const nets = xs.filter((x) => x.netPct != null).map((x) => ({ day: x.day, v: x.netPct! })), pr = xs.filter((x) => x.premRule != null).map((x) => ({ day: x.day, v: x.premRule! }));
    const mean = (a: { v: number }[]) => (a.length ? a.reduce((s, x) => s + x.v, 0) / a.length : NaN), nc = boot(nets), pc = boot(pr);
    console.log(`  ${lab.padEnd(30)} n ${String(n).padStart(5)} (${(n / sess).toFixed(2)}/session) | WIN 1:1 ${f1((w / n) * 100)}% [${f1(ci[0])}–${f1(ci[1])}] · decided ${f1((w / (w + st)) * 100)}% · random same stop ${f1((bw / bn) * 100)}% | WIN 2:1 ${f1((w2 / n) * 100)}% | option net ${f1(mean(nets))}% [${f1(nc[0])}–${f1(nc[1])}], option wins ${f1((nets.filter((x) => x.v > 0).length / nets.length) * 100)}% | premium +20/−10 net ${f1(mean(pr))}% [${f1(pc[0])}–${f1(pc[1])}], wins ${f1((pr.filter((x) => x.v > 0).length / pr.length) * 100)}%`);
  };
  const bP = new Map<string, number>(); { const acc = new Map<string, [number, number]>(); for (const [ixn, r] of Object.entries(R)) for (const b of r.base) { const k = `${ixn}|${b.set}|${b.dir}|${b.tb}|${b.sbP}`, v = acc.get(k) || [0, 0]; v[0] += b.winPts ? 1 : 0; v[1]++; acc.set(k, v); } for (const [k, [w, n]] of acc) if (n >= 30) bP.set(k, w / n); }
  const linePts = (lab: string, xs: Sig[]) => {
    const n = xs.length; if (!n) return console.log(`  ${lab.padEnd(34)} n     0`);
    const w = xs.filter((x) => x.tp.win).length, st = xs.filter((x) => x.tp.stop).length, ci = wilson(w, n);
    let bw = 0, bn = 0; for (const x of xs) { const v = bP.get(`${x.ix}|${x.set}|${x.dir}|${x.tb}|${Math.min(12, Math.floor(x.stopPts / PTS[x.ix as "NIFTY"] / 0.25))}`); if (v != null) { bw += v; bn++; } }
    const nets = xs.filter((x) => x.tpNet != null).map((x) => ({ day: x.day, v: x.tpNet! })), nc = boot(nets), med = [...xs.map((x) => x.stopPts)].sort((p, q) => p - q)[Math.floor(n / 2)];
    const p3 = xs.filter((x) => x.p30), p3w = p3.filter((x) => x.p30!.win).length, p3net = p3.length ? p3.reduce((s, x) => s + x.p30!.net, 0) / p3.length : NaN, p3ci = wilson(p3w, p3.length);
    console.log(`  ${lab.padEnd(34)} n ${String(n).padStart(5)} | INDEX +pts first ${f1((w / n) * 100)}% [${f1(ci[0])}–${f1(ci[1])}] · stop first ${f1((st / n) * 100)}% · random same stop ${f1((bw / bn) * 100)}% · median stop ${Math.round(med)} pts | option net ${f1(nets.length ? nets.reduce((s, x) => s + x.v, 0) / nets.length : NaN)}% [${f1(nc[0])}–${f1(nc[1])}] | PREMIUM +₹30 first ${f1((p3w / p3.length) * 100)}% [${f1(p3ci[0])}–${f1(p3ci[1])}] · net ₹${f1(p3net)}/unit`);
  };
  console.log(`\nFIXED TARGET: index +${PTS.NIFTY} pts NIFTY / +${PTS.SENSEX} pts SENSEX, or premium +₹30, stop beyond the signal candle, 60 min`);
  for (const set of ["DEV", "VAL", "TEST", "ALL"]) for (const ix of ["NIFTY", "SENSEX"] as const) {
    const xs = R[ix].sigs.filter((x) => set === "ALL" || x.set === set);
    console.log(` ${set} ${ix}`);
    linePts("index EMA21 break alone", xs); linePts("+ premium cross same candle", xs.filter((x) => x.s0)); linePts("+ premium EMA9 above EMA21", xs.filter((x) => x.ss));
  }
  console.log(`Data ${FROM} → ${to}`);
  for (const set of ["DEV", "VAL", "TEST"]) {
    console.log(`\n${set}  (sessions: NIFTY ${R.NIFTY.sessions[set]}, SENSEX ${R.SENSEX.sessions[set]})`);
    for (const ix of ["NIFTY", "SENSEX", "BOTH"] as const) {
      const all = ix === "BOTH" ? [...R.NIFTY.sigs, ...R.SENSEX.sigs] : R[ix].sigs, sess = ix === "BOTH" ? R.NIFTY.sessions[set] + R.SENSEX.sessions[set] : R[ix].sessions[set], xs = all.filter((x) => x.set === set);
      console.log(` ${ix}`);
      line("B0 index EMA21 break alone", xs, sess);
      line("S0 + premium cross same candle", xs.filter((x) => x.s0), sess);
      line("S2 + premium cross ≤ 2 candles", xs.filter((x) => x.s2), sess);
      line("SS + premium EMA9 above EMA21", xs.filter((x) => x.ss), sess);
      if (ix === "BOTH") for (const dir of [1, -1]) line(`  S0 ${dir > 0 ? "break UP (CE)" : "break DOWN (PE)"}`, xs.filter((x) => x.s0 && x.dir === dir), sess);
    }
  }
  process.exit(0);
}
