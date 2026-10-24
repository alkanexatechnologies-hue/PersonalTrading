// ProTrader FAKE-MOVE GRID SEARCH (owner asked: "all permutations and combinations … accuracy to 80 %", 2026-10-24).
// Every combination of up to 3 trader filters × level source × timeframe × entry style × direction, NIFTY + SENSEX,
// on real Dhan 1-min spot AND option data (ATM CE / PE price, OI, volume), 2024-10-01 → latest.
// Honest scoring so a % cannot be bought with a tiny target: FIXED 1 : 1 reward : risk.
//   stop = the 4-bar sweep extreme (floored at 0.25 × ATR), target = entry ± the same distance,
//   horizon 60 min (5m) / 120 min (15m); WIN = target first; LOSS = stop first; OPEN = neither (scored at the horizon, in R).
//   ACCURACY = WIN ÷ (WIN + LOSS) — coin flip ≈ 50 %; the OPEN share is shown beside it; avg R counts every trade. Same-stop baseline = 1 : 1 entries at every bar close, matched on stop width.
// Selection is done on DEVELOPMENT (first ⅔ of sessions) ONLY, then the chosen rules are read on VALIDATION (last ⅓).
// A rule counts only if it works on BOTH indices (ranked by the weaker index's development edge, n ≥ 60 each).
// Level sources: LIVE (swing points + PDH/PDL + ORB, as the screen) · CANDLE (prev candle H/L) · DAY (day high/low so far)
//   · OWNER (priceActionLevels: 15-min turn clusters / flip zones of the previous 5 sessions).
// Entry: E0 at the confirming close · E1 after a follow-through close beyond the confirming bar.
// Filters (all known at the entry, no look-ahead):
//   strong   confirming bar closes in its top (bottom) 30 %       wick     a sweep bar's rejection wick ≥ 50 % of its range
//   shallow  poke beyond the level ≤ 0.5 ATR                       am / mid / pm   before 11:00 / 11:00–13:30 / after 13:30
//   htf      higher-TF structure (15m for 5m, 1h for 15m) not against   twap   entry on the trade side of the day's average
//   open     entry on the trade side of the day's open            quiet    day range so far < 0.8 × 20-day average range
//   lowvol   ATR ≤ its 100-bar average                            premUp   ATM trade-side premium up AND other side down
//                                                                         over the 4-bar window
//   premHH   trade-side premium closes at a new 4-bar high        write    ATM opposite-side OI up with its premium down
//                                                                         (put writing under a fake-down / call writing)
//   trap     opposite-side option volume in the window ≥ 1.5 × its usual pace   retest   level touched earlier today
//                                                                         (≥ 30 min before, within 0.15 ATR)
import { assemble, DayData, Min } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";
import { detectFakeMoveTF, FakeMoveLevel } from "../../analyst/fakeMove";
import { detectMarketStructure } from "../../liquidity/orderBlock";
import { priceActionLevels } from "./priceActionLevels";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Res = { win: boolean; loss: boolean; r: number; stopPts: number; tOut?: number };
const FEATS = ["strong", "wick", "shallow", "am", "mid", "pm", "htf", "twap", "open", "quiet", "lowvol", "premUp", "premHH", "write", "trap", "retest"] as const;
const SRCS = ["LIVE", "CANDLE", "DAY", "OWNER"] as const;
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const barsN = (mins: [number, number][], n: number): Bar[] => {
  const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const [t, p] of mins) { const m = mn(t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / n);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (m - 555 - k * n) * 60, open: p, high: p, low: p, close: p, volume: 0 }; key = k; }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out;
};
const atr14 = (b: Bar[]) => { if (b.length < 15) return null; let s = 0; for (let i = b.length - 14; i < b.length; i++) s += Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)); return s / 14; };
function group(b: Bar[], sec: number): Bar[] { const out: Bar[] = []; for (const x of b) { const k = x.time - (((x.time + 19800 - 33300) % sec) + sec) % sec; const l = out[out.length - 1]; if (l && l.time === k) { l.high = Math.max(l.high, x.high); l.low = Math.min(l.low, x.low); l.close = x.close; } else out.push({ ...x, time: k }); } return out; }
function score1to1(path: [number, number][], entry: number, stop: number, dir: number, a: number): Res {
  const d = Math.max(dir * (entry - stop), 0.25 * a), s = entry - dir * d, tg = entry + dir * d;
  for (const [t, p] of path) { if (dir * (p - s) <= 0) return { win: false, loss: true, r: -1, stopPts: d / a, tOut: t }; if (dir * (p - tg) >= 0) return { win: true, loss: false, r: 1, stopPts: d / a, tOut: t }; }
  return { win: false, loss: false, r: path.length ? (dir * (path[path.length - 1][1] - entry)) / d : 0, stopPts: d / a, tOut: path.length ? path[path.length - 1][0] : undefined };
}

export function run(days: DayData[], tf: 5 | 15, step: number) {
  const ds = days.filter((d) => d.spot.size >= 300), cut = Math.floor((ds.length * 2) / 3), horizon = tf === 5 ? 3600 : 7200;
  const ev: any[] = [], baseOf: Record<string, Res[]> = { "DEV|1": [], "DEV|-1": [], "VAL|1": [], "VAL|-1": [] };
  let hist5: Bar[] = [], histT: Bar[] = [], prevDay: { h: number; l: number } | null = null, atrHist: number[] = [];
  const past15: Bar[][] = [], ranges: number[] = [];
  ds.forEach((d, di) => {
    const mins = [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][];
    if (mins.length < 300) return;
    const set = di < cut ? "DEV" : "VAL", B5 = barsN(mins, 5), B = tf === 5 ? B5 : barsN(mins, 15);
    const legIx = new Map<string, Map<number, Min>>(); for (const [k, arr] of d.legs) legIx.set(k, new Map(arr.map((x) => [x.t, x])));
    const leg = (strike: number, side: "CE" | "PE", t: number) => { const m = legIx.get(`${strike}${side}`); if (!m) return null; for (let k = 0; k < 4; k++) { const x = m.get(t - 60 - k * 60); if (x) return x; } return null; };
    const legSum = (strike: number, side: "CE" | "PE", t0: number, t1: number) => { const m = legIx.get(`${strike}${side}`); if (!m) return 0; let v = 0; for (let t = t0; t < t1; t += 60) v += m.get(t)?.v ?? 0; return v; };
    const prev15 = past15.slice(-5).flat(), a15 = atr14(prev15.slice(-15)), owner = prev15.length >= 50 && a15 ? priceActionLevels(prev15, a15).map((l) => l.price) : [];
    const avgRange = ranges.length >= 10 ? ranges.slice(-20).reduce((s, x) => s + x, 0) / Math.min(20, ranges.length) : null;
    const orb = B5.filter((b) => mn(b.time) < 570), orbH = orb.length ? Math.max(...orb.map((b) => b.high)) : null, orbL = orb.length ? Math.min(...orb.map((b) => b.low)) : null;
    const pathFrom = (t0: number) => mins.filter(([t]) => t >= t0 && t < t0 + horizon);
    const dayOpen = mins[0][1], seen = new Set<string>();
    for (let i = 4; i < B.length - 1; i++) {
      const tEnd = B[i].time + tf * 60, m = mn(tEnd);
      const a = atr14(histT.concat(B.slice(0, i + 1)).slice(-15)); if (!a) continue; atrHist.push(a); if (atrHist.length > 100) atrHist.shift();
      if (m < 575 || m > (tf === 5 ? 900 : 870)) continue;
      const path0 = pathFrom(tEnd); if (path0.length < 20) continue;
      const px = B[i].close, w4 = B.slice(i - 3, i + 1), lo4 = Math.min(...w4.map((b) => b.low)), hi4 = Math.max(...w4.map((b) => b.high));
      baseOf[`${set}|1`].push(score1to1(path0, px, lo4, 1, a)); baseOf[`${set}|-1`].push(score1to1(path0, px, hi4, -1, a));
      const live: [number | null, string][] = [];
      const win5 = hist5.concat(B5.filter((b) => b.time + 300 <= tEnd)).slice(-120);
      for (const p of ((detectMarketStructure(win5 as any, 3) as any).swingPoints || []).slice(-6)) live.push([p.price, p.type === "HH" || p.type === "LH" ? "Swing High" : "Swing Low"]);
      if (prevDay) live.push([prevDay.h, "PDH"], [prevDay.l, "PDL"]);
      live.push([orbH, "ORB High"], [orbL, "ORB Low"]);
      const before = B.slice(0, i - 3);
      const src: Record<string, [number | null, string][]> = {
        LIVE: live, CANDLE: [[B[i - 4].high, "Candle High"], [B[i - 4].low, "Candle Low"]],
        DAY: before.length ? [[Math.max(...before.map((b) => b.high)), "Day High"], [Math.min(...before.map((b) => b.low)), "Day Low"]] : [],
        OWNER: owner.map((p) => [p, "PA"] as [number, string]),
      };
      const candles = B.slice(Math.max(0, i - 40), i + 1);
      let ctx: any = null;   // shared context, computed lazily once per bar
      for (const s of SRCS) {
        const levels: FakeMoveLevel[] = src[s].filter(([p]) => p != null && isFinite(p!)).map(([p, label]) => ({ price: Math.round(p! * 100) / 100, label, side: p! >= px ? "resistance" : "support" }));
        if (!levels.length) continue;
        const fm = detectFakeMoveTF({ tfLabel: `${tf}M`, candles, levels });
        if (fm.status !== "CONFIRMED" || fm.level == null) continue;
        const dir = fm.direction === "DOWN" ? 1 : -1, lvl = fm.level, key = `${s}|${dir}|${Math.round(lvl)}`; if (seen.has(key)) continue; seen.add(key);
        if (!ctx) {
          const tw = mins.filter(([t]) => t < tEnd), twap = tw.reduce((x, [, p]) => x + p, 0) / tw.length, rng = Math.max(...tw.map(([, p]) => p)) - Math.min(...tw.map(([, p]) => p));
          const htfBars = tf === 5 ? group(win5, 900) : group(histT.concat(B.slice(0, i + 1)).slice(-200), 3600);
          const htf = htfBars.length >= 10 ? (detectMarketStructure(htfBars as any, 3) as any).currentStructure : "—";
          const atm = Math.round(px / step) * step, t0 = B[i - 3].time;
          const ce0 = leg(atm, "CE", t0 + 60), ce1 = leg(atm, "CE", tEnd), pe0 = leg(atm, "PE", t0 + 60), pe1 = leg(atm, "PE", tEnd);
          const hiOf = (side: "CE" | "PE") => { const mm = legIx.get(`${atm}${side}`); if (!mm) return null; let h = -Infinity; for (let t = t0; t < tEnd - tf * 60; t += 60) { const x = mm.get(t); if (x) h = Math.max(h, x.h); } return isFinite(h) ? h : null; };
          const pace = (side: "CE" | "PE") => { const win = legSum(atm, side, t0, tEnd) / ((tEnd - t0) / 60), prior = legSum(atm, side, t0 - 3600, t0) / 60; return prior > 0 ? win / prior : null; };
          ctx = { twap, rng, htf, ce0, ce1, pe0, pe1, ceHi: hiOf("CE"), peHi: hiOf("PE"), cePace: pace("CE"), pePace: pace("PE"), atrRatio: a / (atrHist.reduce((x, y) => x + y, 0) / atrHist.length) };
        }
        const conf = B[i], crng = conf.high - conf.low || 1, cl = (conf.close - conf.low) / crng;
        const sweep = dir > 0 ? w4.reduce((x, b) => (b.low < x.low ? b : x)) : w4.reduce((x, b) => (b.high > x.high ? b : x)), srng = sweep.high - sweep.low || 1;
        const wick = dir > 0 ? (Math.min(sweep.open, sweep.close) - sweep.low) / srng : (sweep.high - Math.max(sweep.open, sweep.close)) / srng;
        const poke = dir > 0 ? lvl - lo4 : hi4 - lvl;
        const [my, ot] = dir > 0 ? [[ctx.ce0, ctx.ce1, ctx.ceHi], [ctx.pe0, ctx.pe1]] : [[ctx.pe0, ctx.pe1, ctx.peHi], [ctx.ce0, ctx.ce1]];
        const touchedBefore = mins.some(([t, p]) => t < tEnd - 1800 && t >= B[0].time && Math.abs(p - lvl) <= 0.15 * a);
        const f: Record<string, boolean> = {
          strong: dir > 0 ? cl >= 0.7 : cl <= 0.3, wick: wick >= 0.5, shallow: poke <= 0.5 * a,
          am: m < 660, mid: m >= 660 && m < 810, pm: m >= 810,
          htf: dir > 0 ? ctx.htf !== "Bearish" : ctx.htf !== "Bullish",
          twap: dir * (px - ctx.twap) > 0, open: dir * (px - dayOpen) > 0, quiet: avgRange != null && ctx.rng < 0.8 * avgRange,
          lowvol: ctx.atrRatio <= 1,
          premUp: !!(my[0] && my[1] && ot[0] && ot[1] && my[1].c > my[0].c && ot[1].c < ot[0].c),
          premHH: !!(my[1] && my[2] != null && my[1].c > my[2]),
          write: !!(ot[0] && ot[1] && ot[0].oi != null && ot[1].oi != null && ot[1].oi > ot[0].oi && ot[1].c < ot[0].c),
          trap: (dir > 0 ? ctx.pePace : ctx.cePace) != null && (dir > 0 ? ctx.pePace : ctx.cePace) >= 1.5,
          retest: touchedBefore,
        };
        const nx = B[i + 1], ft = dir > 0 ? nx.close > conf.high : nx.close < conf.low;
        const r0 = score1to1(path0, px, dir > 0 ? lo4 : hi4, dir, a);
        const r1 = ft && dir * (nx.close - (dir > 0 ? lo4 : hi4)) > 0 ? score1to1(pathFrom(nx.time + tf * 60), nx.close, dir > 0 ? lo4 : hi4, dir, a) : null;
        const atm = Math.round(px / step) * step, side = dir > 0 ? "CE" : "PE";
        const prem = (r: Res | null, tIn: number) => { if (!r || r.tOut == null) return null; const a0 = leg(atm, side, tIn), a1 = leg(atm, side, r.tOut + 60); return a0 && a1 && a0.c > 0 ? ((a1.c - a0.c) / a0.c) * 100 : null; };
        ev.push({ set, src: s, dir, f, r0, r1, day: d.day, t: tEnd, lvl, px, stop: dir > 0 ? lo4 : hi4, atr: a, atm, premIn: leg(atm, side, tEnd)?.c ?? null, p0: prem(r0, tEnd), p1: r1 ? prem(r1, nx.time + tf * 60) : null });
      }
    }
    hist5 = hist5.concat(B5).slice(-400); histT = histT.concat(B).slice(-400); past15.push(barsN(mins, 15));
    prevDay = { h: Math.max(...B5.map((b) => b.high)), l: Math.min(...B5.map((b) => b.low)) }; ranges.push(prevDay.h - prevDay.l);
  });
  return { ev, baseOf, sessions: ds.length };
}

if (require.main === module) {
  const to = latestRawDay(), bk = (x: number) => Math.min(12, Math.floor(x / 0.25));
  const combos: string[][] = [[]];
  for (let a = 0; a < FEATS.length; a++) { combos.push([FEATS[a]]); for (let b = a + 1; b < FEATS.length; b++) { combos.push([FEATS[a], FEATS[b]]); for (let c = b + 1; c < FEATS.length; c++) combos.push([FEATS[a], FEATS[b], FEATS[c]]); } }
  const pools: Record<string, Map<number, number>> = {};
  const poolOf = (b: Res[]) => { const m = new Map<number, [number, number]>(); for (const x of b) { const k = bk(x.stopPts), v = m.get(k) || [0, 0]; if (!x.win && !x.loss) continue; v[0] += x.win ? 1 : 0; v[1]++; m.set(k, v); } const out = new Map<number, number>(); for (const [k, [w, n]] of m) if (n >= 30) out.set(k, w / n); return out; };
  const statOf = (r: Res[], pool: Map<number, number>) => { if (!r.length) return null; let w = 0, l = 0, R = 0, bw = 0, bn = 0; for (const x of r) { w += x.win ? 1 : 0; l += x.loss ? 1 : 0; R += x.r; const p = pool.get(bk(x.stopPts)); if (p != null) { bw += p; bn++; } } return { n: r.length, win: w + l ? (w / (w + l)) * 100 : NaN, open: ((r.length - w - l) / r.length) * 100, avgR: R / r.length, base: bn ? (bw / bn) * 100 : NaN }; };
  const data: Record<string, any> = {};
  for (const [ix, days, step] of [["NIFTY", assemble(FROM, to).days, 50], ["SENSEX", assembleIndex("SENSEX", FROM, to), 100]] as const) for (const tf of [5, 15] as const) {
    const r = run(days as DayData[], tf, step); data[`${ix}|${tf}`] = r;
    for (const k of Object.keys(r.baseOf)) pools[`${ix}|${tf}|${k}`] = poolOf(r.baseOf[k]);
    console.error(`${ix} ${tf}m: ${r.sessions} sessions, ${r.ev.length} events`);
  }
  type Row = { rule: string; dev: any[]; val: any[] };
  const rows: Row[] = []; let tested = 0;
  for (const tf of [5, 15]) for (const s of SRCS) for (const dir of [1, -1]) for (const e of ["r0", "r1"]) for (const c of combos) {
    const dev: any[] = [], val: any[] = [];
    for (const ix of ["NIFTY", "SENSEX"]) {
      const ev = data[`${ix}|${tf}`].ev.filter((x: any) => x.src === s && x.dir === dir && x[e] && c.every((k) => x.f[k]));
      dev.push(statOf(ev.filter((x: any) => x.set === "DEV").map((x: any) => x[e]), pools[`${ix}|${tf}|DEV|${dir}`]));
      val.push(statOf(ev.filter((x: any) => x.set === "VAL").map((x: any) => x[e]), pools[`${ix}|${tf}|VAL|${dir}`]));
    }
    tested++;
    if (dev.every((x) => x && x.n >= 60)) rows.push({ rule: `${tf}m ${dir > 0 ? "FAKE-DOWN" : "FAKE-UP"} ${s} ${e === "r0" ? "E0" : "E1"} ${c.length ? c.join("+") : "(no filter)"}`, dev, val });
  }
  const edge = (x: any) => (x ? x.win - x.base : NaN), minEdge = (a: any[]) => Math.min(edge(a[0]), edge(a[1]));
  const fmt = (x: any) => (x ? `${x.win.toFixed(1)}% (b ${x.base.toFixed(1)}) n${x.n} open ${x.open.toFixed(0)}% ${x.avgR >= 0 ? "+" : ""}${x.avgR.toFixed(2)}R` : "—");
  console.log(`Rules tested: ${tested} · with n ≥ 60 on both indices in development: ${rows.length}`);
  const hi = [...rows].sort((p, q) => Math.max(q.dev[0].win, q.dev[1].win) - Math.max(p.dev[0].win, p.dev[1].win)).slice(0, 5);
  console.log(`\nHIGHEST DEVELOPMENT WIN % (either index) — and what happened next (validation):`);
  for (const r of hi) console.log(`  ${r.rule}\n     DEV  NIFTY ${fmt(r.dev[0])} | SENSEX ${fmt(r.dev[1])}\n     VAL  NIFTY ${fmt(r.val[0])} | SENSEX ${fmt(r.val[1])}`);
  const top = [...rows].sort((p, q) => minEdge(q.dev) - minEdge(p.dev)).slice(0, 25);
  console.log(`\nTOP 25 BY DEVELOPMENT EDGE (weaker index), read on VALIDATION:`);
  for (const r of top) console.log(`  ${r.rule}\n     DEV  NIFTY ${fmt(r.dev[0])} | SENSEX ${fmt(r.dev[1])}\n     VAL  NIFTY ${fmt(r.val[0])} | SENSEX ${fmt(r.val[1])}`);
  const ok = top.filter((r) => r.val.every((x) => x && x.n >= 20 && x.win - x.base >= 3));
  console.log(`\nOf the top 25, held on validation (both indices ≥ +3 points over baseline, n ≥ 20): ${ok.length}`);
  const pairs = rows.filter((r) => r.val.every((x) => x && isFinite(x.win)) && r.dev.every((x) => isFinite(x.win))).map((r) => [(edge(r.dev[0]) + edge(r.dev[1])) / 2, (edge(r.val[0]) + edge(r.val[1])) / 2]);
  const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length, my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  const cov = pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0), vx = pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0), vy = pairs.reduce((s, p) => s + (p[1] - my) ** 2, 0);
  console.log(`Correlation of development edge with validation edge over ${pairs.length} rules: ${(cov / Math.sqrt(vx * vy)).toFixed(2)} (≈ 0 → the development winners were luck)`);
  const v80 = rows.filter((r) => r.val.some((x) => x && x.n >= 30 && x.win >= 80));
  console.log(`Rules at ≥ 80 % in validation on either index (n ≥ 30): ${v80.length}; on both: ${rows.filter((r) => r.val.every((x) => x && x.n >= 30 && x.win >= 80)).length}`);
  const bestFeat = FEATS.map((f) => { const ok2 = (r: Row) => r.val.every((x) => x && isFinite(x.win - x.base)) && r.dev.every((x) => isFinite(x.win - x.base)); const rs = rows.filter((r) => ok2(r) && r.rule.split(" ").pop()!.split("+").includes(f)); const dv = rs.reduce((s, r) => s + (edge(r.dev[0]) + edge(r.dev[1])) / 2, 0) / (rs.length || 1); const vl = rs.filter((r) => r.val.every((x) => x)).reduce((s, r) => s + (edge(r.val[0]) + edge(r.val[1])) / 2, 0) / (rs.filter((r) => r.val.every((x) => x)).length || 1); return { f, n: rs.length, dv, vl }; });
  console.log(`\nAverage edge of rules containing each filter (development → validation, points over baseline):`);
  for (const b of bestFeat.sort((p, q) => q.vl - p.vl)) console.log(`  ${b.f.padEnd(8)} rules ${String(b.n).padStart(5)}  ${b.dv >= 0 ? "+" : ""}${b.dv.toFixed(1)} → ${b.vl >= 0 ? "+" : ""}${b.vl.toFixed(1)}`);
  // FOCUS: the family that held on validation — owner-level fakes with opposite-side writing and an earlier touch.
  // Both directions, both timeframes, both entries; validation split into halves; ATM option premium P&L (% of premium).
  console.log(`\nFOCUS — fake at OWNER S/R + opposite-side writing + retest (premium P&L = ATM trade-side option, % of premium):`);
  for (const tf of [5, 15]) for (const dir of [1, -1]) for (const e of ["r0", "r1"]) for (const extra of [[], ["premHH"], ["strong"]] as string[][]) {
    const c = ["write", "retest", ...extra], out: string[] = [];
    for (const ix of ["NIFTY", "SENSEX"]) {
      const all = data[`${ix}|${tf}`].ev.filter((x: any) => x.src === "OWNER" && x.dir === dir && x[e] && c.every((k) => x.f[k]));
      const valDays = [...new Set(all.filter((x: any) => x.set === "VAL").map((x: any) => x.day))].sort() as string[], mid = valDays[Math.floor(valDays.length / 2)];
      const part = (xs: any[], k: string) => { const s = statOf(xs.map((x) => x[e]), pools[`${ix}|${tf}|${k}|${dir}`]); const pk = e === "r0" ? "p0" : "p1", pp = xs.map((x) => x[pk]).filter((v: any) => v != null);
        return s ? `${isFinite(s.win) ? s.win.toFixed(0) : "—"}%/b${isFinite(s.base) ? s.base.toFixed(0) : "—"} n${s.n} ${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(2)}R prem ${pp.length ? (pp.reduce((a: number, v: number) => a + v, 0) / pp.length).toFixed(1) + "%" : "—"}` : "—"; };
      const dev = all.filter((x: any) => x.set === "DEV"), v = all.filter((x: any) => x.set === "VAL");
      out.push(`${ix}: DEV ${part(dev, "DEV")} | VAL-1 ${part(v.filter((x: any) => x.day < mid), "VAL")} | VAL-2 ${part(v.filter((x: any) => x.day >= mid), "VAL")}`);
    }
    console.log(`  ${tf}m ${dir > 0 ? "FAKE-DOWN" : "FAKE-UP"} ${e === "r0" ? "E0" : "E1"} ${c.join("+")}\n     ${out.join("\n     ")}`);
  }
  process.exit(0);
}
