// ProTrader FAKE-MOVE STUDY #2 — can the FAKE-DOWN / FAKE-UP label reach ~90 % on 5-min or 15-min candles? (2026-10-24)
// Same data, levels and live detector as fakeMoveStudy.ts (detectFakeMoveTF; swing points + PDH/PDL + ORB, no OI history).
// Runs on 5-min AND 15-min candles. Scores every variant on BOTH:
//   right %  — target (1 × ATR of that timeframe) before the stop (the 4-bar sweep extreme)
//   avg R    — RIGHT = +target/stop distance, WRONG = −1, TIME = the move at the horizon / stop distance
//              (a high right % with a negative avg R loses money; that is how a "90 %" signal is usually built)
// Horizon: 60 min on 5-min, 120 min on 15-min. Baseline = an entry at every bar close with the same stop width (0.25-ATR
// buckets) and the same target. DEV = first ⅔ of sessions, VAL = last ⅓. Variants (pre-registered, not tuned):
//   V0 live label — enter at the confirming close
//   V1 follow-through — the NEXT bar closes beyond the confirming bar's high (low for fake-up); enter at that close
//   V2 hold — the next 2 bars both close on the reclaimed side of the level; enter at the 2nd close
//   V3 V1 + day side — the entry is on the trade's side of the day's average price (time-weighted; index volume is 0)
//   V4 V1 + higher TF — 15-min structure (5-min runs) / 1-hour structure (15-min runs) not against
//   T  target sweep on V0 — 0.25 / 0.5 / 1 / 2 × ATR: what a "90 %" target costs in avg R
import { assemble } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";
import { detectFakeMoveTF, FakeMoveLevel } from "../../analyst/fakeMove";
import { detectMarketStructure } from "../../liquidity/orderBlock";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Res = { res: "RIGHT" | "WRONG" | "TIME"; r: number };
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const barsN = (mins: [number, number][], n: number): Bar[] => {
  const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const [t, p] of mins) { const m = mn(t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / n);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (m - 555 - k * n) * 60, open: p, high: p, low: p, close: p, volume: 0 }; key = k; }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out;
};
const atr14 = (b: Bar[]) => { if (b.length < 15) return null; let s = 0; for (let i = b.length - 14; i < b.length; i++) s += Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)); return s / 14; };
const struct = (b: Bar[]) => (b.length >= 10 ? (detectMarketStructure(b as any, 3) as any).currentStructure as string : "—");

function score(path: [number, number][], entry: number, stop: number, target: number, dir: number): Res {
  const risk = dir * (entry - stop); if (risk <= 0) return { res: "WRONG", r: -1 };
  for (const [, p] of path) { if (dir * (p - stop) <= 0) return { res: "WRONG", r: -1 }; if (dir * (p - target) >= 0) return { res: "RIGHT", r: Math.abs(target - entry) / risk }; }
  return { res: "TIME", r: path.length ? (dir * (path[path.length - 1][1] - entry)) / risk : 0 };
}

function run(days: { day: string; spot: Map<number, number> }[], tf: 5 | 15) {
  const ds = days.filter((d) => d.spot.size >= 300), cut = Math.floor((ds.length * 2) / 3), horizon = tf === 5 ? 3600 : 7200;
  const ev: any[] = [], base: any[] = [];
  let hist5: Bar[] = [], histT: Bar[] = [], prevDay: { h: number; l: number } | null = null;
  ds.forEach((d, di) => {
    const mins = [...d.spot.entries()].sort((a, b) => a[0] - b[0]) as [number, number][], set = di < cut ? "DEV" : "VAL";
    const B5 = barsN(mins, 5), B = tf === 5 ? B5 : barsN(mins, 15);
    const orb = B5.filter((b) => mn(b.time) < 570), orbH = orb.length ? Math.max(...orb.map((b) => b.high)) : null, orbL = orb.length ? Math.min(...orb.map((b) => b.low)) : null;
    const pathFrom = (t0: number) => mins.filter(([t]) => t >= t0 && t < t0 + horizon && mn(t) < 930);
    const avgTo = (t1: number) => { let s = 0, n = 0; for (const [t, p] of mins) { if (t >= t1) break; s += p; n++; } return n ? s / n : null; };
    const seen = new Set<string>();
    for (let i = 0; i < B.length; i++) {
      const tEnd = B[i].time + tf * 60, m = mn(tEnd); if (m < 575 || m > (tf === 5 ? 900 : 870)) continue;
      const allT = histT.concat(B.slice(0, i + 1)), a = atr14(allT.slice(-15)); if (!a) continue;
      const lastN = B.slice(Math.max(0, i - 3), i + 1), lo4 = Math.min(...lastN.map((b) => b.low)), hi4 = Math.max(...lastN.map((b) => b.high));
      const p0 = pathFrom(tEnd); if (p0.length < 20) continue;
      base.push({ set, dir: 1, ...score(p0, B[i].close, lo4, B[i].close + a, 1), stopPts: (B[i].close - lo4) / a },
        { set, dir: -1, ...score(p0, B[i].close, hi4, B[i].close - a, -1), stopPts: (hi4 - B[i].close) / a });
      // levels exactly as the live screen builds them, from the 5-min structure at this moment
      const win5 = hist5.concat(B5.filter((b) => b.time + 300 <= tEnd)).slice(-120), spot = B[i].close, levels: FakeMoveLevel[] = [];
      const push = (p: number | null, label: string) => { if (p != null && isFinite(p)) levels.push({ price: Math.round(p * 100) / 100, label, side: p >= spot ? "resistance" : "support" }); };
      for (const p of ((detectMarketStructure(win5 as any, 3) as any).swingPoints || []).slice(-6)) push(p.price, p.type === "HH" || p.type === "LH" ? "Swing High" : "Swing Low");
      if (prevDay) { push(prevDay.h, "Prev Day High"); push(prevDay.l, "Prev Day Low"); }
      push(orbH, "ORB High"); push(orbL, "ORB Low");
      const fm = detectFakeMoveTF({ tfLabel: `${tf}M`, candles: B.slice(Math.max(0, i - 40), i + 1), levels });
      if (fm.status !== "CONFIRMED" || fm.level == null) continue;
      const key = `${fm.direction}|${Math.round(fm.level)}`; if (seen.has(key)) continue; seen.add(key);
      const dir = fm.direction === "DOWN" ? 1 : -1, stop = dir > 0 ? lo4 : hi4, lvl = fm.level;
      const e: any = { set, dir, level: fm.levelLabel };
      const sc = (entryBar: number, mult = 1) => { const eb = B[entryBar], t = eb.time + tf * 60, px = eb.close;
        return { ...score(pathFrom(t), px, stop, px + dir * mult * a, dir), stopPts: Math.abs(px - stop) / a }; };
      e.v0 = sc(i);
      for (const k of [0.25, 0.5, 2]) e["t" + k] = sc(i, k);
      const nx = B[i + 1], nx2 = B[i + 2];
      const ft = nx && (dir > 0 ? nx.close > B[i].high : nx.close < B[i].low) && dir * (nx.close - stop) > 0;
      if (ft && pathFrom(nx.time + tf * 60).length >= 20) {
        e.v1 = sc(i + 1);
        const av = avgTo(nx.time + tf * 60); e.v3 = av != null && dir * (nx.close - av) > 0;
        const hi = tf === 5 ? struct(histT15(hist5, B5, nx.time + 300)) : struct(hourBars(histT, B, nx.time + tf * 60));
        e.v4 = dir > 0 ? hi !== "Bearish" : hi !== "Bullish";
      }
      const hold = nx && nx2 && [nx, nx2].every((b) => dir * (b.close - lvl) > 0) && dir * (nx2.close - stop) > 0;
      if (hold && pathFrom(nx2.time + tf * 60).length >= 20) e.v2 = sc(i + 2);
      ev.push(e);
    }
    hist5 = hist5.concat(B5).slice(-400); histT = histT.concat(B).slice(-400);
    prevDay = B5.length ? { h: Math.max(...B5.map((b) => b.high)), l: Math.min(...B5.map((b) => b.low)) } : prevDay;
  });
  return { sessions: ds.length, ev, base };
}
// 15-min bars from the 5-min history up to t (higher-TF check for 5-min runs)
function histT15(hist5: Bar[], today5: Bar[], t: number): Bar[] { return group(hist5.concat(today5.filter((b) => b.time + 300 <= t)).slice(-240), 900); }
// 1-hour bars from the 15-min history up to t (higher-TF check for 15-min runs)
function hourBars(histT: Bar[], today: Bar[], t: number): Bar[] { return group(histT.concat(today.filter((b) => b.time + 900 <= t)).slice(-200), 3600); }
function group(b: Bar[], sec: number): Bar[] { const out: Bar[] = []; for (const x of b) { const k = x.time - ((x.time + 19800 - 33300) % sec + sec) % sec; const l = out[out.length - 1]; if (l && l.time === k) { l.high = Math.max(l.high, x.high); l.low = Math.min(l.low, x.low); l.close = x.close; } else out.push({ ...x, time: k }); } return out; }

if (require.main === module) {
  const to = latestRawDay(), bk = (x: number) => Math.min(12, Math.floor(x / 0.25));
  const stat = (r: Res[]) => r.length ? { n: r.length, right: (r.filter((x) => x.res === "RIGHT").length / r.length) * 100, avgR: r.reduce((s, x) => s + x.r, 0) / r.length } : null;
  const matched = (r: any[], b: any[]) => { const byB = new Map<number, any[]>(); for (const x of b) { const k = bk(x.stopPts); (byB.get(k) || byB.set(k, []).get(k)!).push(x); }
    let w = 0, R = 0, n = 0; for (const e of r) { const pool = byB.get(bk(e.stopPts)); if (!pool || pool.length < 30) continue; w += pool.filter((x) => x.res === "RIGHT").length / pool.length; R += pool.reduce((s, x) => s + x.r, 0) / pool.length; n++; }
    return n ? `${((w / n) * 100).toFixed(1)}% / ${(R / n).toFixed(2)}R` : "—"; };
  const line = (lab: string, r: any[], b: any[]) => { const s = stat(r); console.log(`  ${lab.padEnd(30)} ${s ? `n=${String(s.n).padStart(4)}  right ${s.right.toFixed(1).padStart(5)}%  avg ${s.avgR.toFixed(2).padStart(5)}R` : "n=   0".padEnd(36)}  | same-stop baseline ${matched(r, b)}`); };
  for (const [name, days] of [["NIFTY", assemble(FROM, to).days], ["SENSEX", assembleIndex("SENSEX", FROM, to)]] as const) for (const tf of [5, 15] as const) {
    const r = run(days as any, tf);
    console.log(`\n${name} · ${tf}-min candles · ${r.sessions} sessions`);
    for (const set of ["DEV", "VAL"]) for (const dir of [1, -1]) {
      const e = r.ev.filter((x) => x.set === set && x.dir === dir), b = r.base.filter((x) => x.set === set && x.dir === dir), lab = `${set} ${dir > 0 ? "FAKE-DOWN" : "FAKE-UP"}`;
      line(`${lab} V0 live`, e.map((x) => x.v0), b);
      line(`${lab} V1 follow-through`, e.filter((x) => x.v1).map((x) => x.v1), b);
      line(`${lab} V2 hold 2 bars`, e.filter((x) => x.v2).map((x) => x.v2), b);
      line(`${lab} V3 V1 + day side`, e.filter((x) => x.v1 && x.v3).map((x) => x.v1), b);
      line(`${lab} V4 V1 + higher TF`, e.filter((x) => x.v1 && x.v4).map((x) => x.v1), b);
      line(`${lab} V3+V4`, e.filter((x) => x.v1 && x.v3 && x.v4).map((x) => x.v1), b);
      for (const k of ["0.25", "0.5", "2"]) { const rr = e.map((x) => x["t" + k]); const s = stat(rr); if (s) console.log(`  ${(lab + " target " + k + "×ATR").padEnd(30)} n=${String(s.n).padStart(4)}  right ${s.right.toFixed(1).padStart(5)}%  avg ${s.avgR.toFixed(2).padStart(5)}R`); }
    }
  }
  process.exit(0);
}
