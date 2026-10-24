// ProTrader FAKE-MOVE STUDY #3 — CANDLE LEVELS (owner's idea, 2026-10-24): feed the live detector the high / low of a
// reference CANDLE instead of swing / PDH / ORB levels, and score both readings of a break:
//   FAKE   — break of the candle's low (high), then a close back above (below)  → trade the reclaim
//   BREAK  — two closes beyond the candle's low (high) = BREAKDOWN / BREAKOUT_ACCEPTED → trade the break
// Level sets (each run on its own; a level is fixed before the detector's 4-bar window, no look-ahead):
//   L0 live levels (swing points + PDH/PDL + ORB, as studies #1/#2)       — the reference
//   C1 same-timeframe candle — high / low of the candle just before the 4-bar window
//   C2 higher-timeframe candle — the last COMPLETED 15-min candle (5-min runs) / 1-hour candle (15-min runs)
//   C3 day's running high / low — before the 4-bar window
// Scoring as study #2: target 1 × ATR14 of the timeframe; stop: FAKE = the 4-bar sweep extreme, BREAK = the other side
// of the last 2 bars; horizon 60 min (5m) / 120 min (15m); avg R; same-stop baseline; DEV ⅔ / VAL ⅓.
import { assemble } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";
import { detectFakeMoveTF, FakeMoveLevel } from "../../analyst/fakeMove";
import { detectMarketStructure } from "../../liquidity/orderBlock";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Res = { res: "RIGHT" | "WRONG" | "TIME"; r: number; stopPts: number };
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const barsN = (mins: [number, number][], n: number): Bar[] => {
  const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const [t, p] of mins) { const m = mn(t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / n);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (m - 555 - k * n) * 60, open: p, high: p, low: p, close: p, volume: 0 }; key = k; }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out;
};
const atr14 = (b: Bar[]) => { if (b.length < 15) return null; let s = 0; for (let i = b.length - 14; i < b.length; i++) s += Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)); return s / 14; };
function score(path: [number, number][], entry: number, stop: number, target: number, dir: number, a: number): Res {
  const risk = dir * (entry - stop), stopPts = Math.abs(entry - stop) / a; if (risk <= 0) return { res: "WRONG", r: -1, stopPts };
  for (const [, p] of path) { if (dir * (p - stop) <= 0) return { res: "WRONG", r: -1, stopPts }; if (dir * (p - target) >= 0) return { res: "RIGHT", r: Math.abs(target - entry) / risk, stopPts }; }
  return { res: "TIME", r: path.length ? (dir * (path[path.length - 1][1] - entry)) / risk : 0, stopPts };
}
const SETS = ["L0", "C1", "C2", "C3"] as const;

function run(days: { day: string; spot: Map<number, number> }[], tf: 5 | 15) {
  const ds = days.filter((d) => d.spot.size >= 300), cut = Math.floor((ds.length * 2) / 3), horizon = tf === 5 ? 3600 : 7200, htf = tf === 5 ? 15 : 60;
  const ev: any[] = [], base: any[] = [];
  let hist5: Bar[] = [], histT: Bar[] = [], prevDay: { h: number; l: number } | null = null;
  ds.forEach((d, di) => {
    const mins = [...d.spot.entries()].sort((a, b) => a[0] - b[0]) as [number, number][], set = di < cut ? "DEV" : "VAL";
    const B5 = barsN(mins, 5), B = tf === 5 ? B5 : barsN(mins, 15), H = barsN(mins, htf);
    const orb = B5.filter((b) => mn(b.time) < 570), orbH = orb.length ? Math.max(...orb.map((b) => b.high)) : null, orbL = orb.length ? Math.min(...orb.map((b) => b.low)) : null;
    const pathFrom = (t0: number) => mins.filter(([t]) => t >= t0 && t < t0 + horizon && mn(t) < 930);
    const seen = new Set<string>();
    for (let i = 4; i < B.length; i++) {
      const tEnd = B[i].time + tf * 60, m = mn(tEnd); if (m < 575 || m > (tf === 5 ? 900 : 870)) continue;
      const a = atr14(histT.concat(B.slice(0, i + 1)).slice(-15)); if (!a) continue;
      const path = pathFrom(tEnd); if (path.length < 20) continue;
      const px = B[i].close, last4 = B.slice(i - 3, i + 1), lo4 = Math.min(...last4.map((b) => b.low)), hi4 = Math.max(...last4.map((b) => b.high));
      const lo2 = Math.min(B[i].low, B[i - 1].low), hi2 = Math.max(B[i].high, B[i - 1].high);
      base.push({ set, dir: 1, ...score(path, px, lo4, px + a, 1, a) }, { set, dir: -1, ...score(path, px, hi4, px - a, -1, a) },
        { set, dir: 1, ...score(path, px, lo2, px + a, 1, a) }, { set, dir: -1, ...score(path, px, hi2, px - a, -1, a) });
      const lv: Record<string, [number | null, string][]> = { L0: [], C1: [], C2: [], C3: [] };
      const win5 = hist5.concat(B5.filter((b) => b.time + 300 <= tEnd)).slice(-120);
      for (const p of ((detectMarketStructure(win5 as any, 3) as any).swingPoints || []).slice(-6)) lv.L0.push([p.price, p.type === "HH" || p.type === "LH" ? "Swing High" : "Swing Low"]);
      if (prevDay) lv.L0.push([prevDay.h, "PDH"], [prevDay.l, "PDL"]);
      lv.L0.push([orbH, "ORB High"], [orbL, "ORB Low"]);
      const ref = B[i - 4]; lv.C1.push([ref.high, "Candle High"], [ref.low, "Candle Low"]);
      const winStart = B[i - 3].time, hDone = H.filter((h) => h.time + htf * 60 <= winStart).pop();
      if (hDone) lv.C2.push([hDone.high, `${htf}m Candle High`], [hDone.low, `${htf}m Candle Low`]);
      const before = B.slice(0, i - 3); if (before.length) lv.C3.push([Math.max(...before.map((b) => b.high)), "Day High"], [Math.min(...before.map((b) => b.low)), "Day Low"]);
      for (const ls of SETS) {
        const levels: FakeMoveLevel[] = lv[ls].filter(([p]) => p != null && isFinite(p!)).map(([p, label]) => ({ price: Math.round(p! * 100) / 100, label, side: p! >= px ? "resistance" : "support" }));
        if (!levels.length) continue;
        const fm = detectFakeMoveTF({ tfLabel: `${tf}M`, candles: B.slice(Math.max(0, i - 40), i + 1), levels });
        // BREAK needs the level's ROLE as its side (a high = resistance, a low = support): with side = "which side of the
        // spot", an accepted break flips the level to the other side and the detector can never report it (live does that)
        const byRole: FakeMoveLevel[] = levels.map((l) => ({ ...l, side: /High|PDH/.test(l.label) ? "resistance" : "support" }));
        const fb = detectFakeMoveTF({ tfLabel: `${tf}M`, candles: B.slice(Math.max(0, i - 40), i + 1), levels: byRole });
        const hits: ["FAKE" | "BREAK", number, number][] = [];
        if (fm.status === "CONFIRMED" && fm.level != null) hits.push(["FAKE", fm.direction === "DOWN" ? 1 : -1, fm.level]);
        if (fb.breakoutState === "BREAKDOWN_ACCEPTED" && fb.level != null) hits.push(["BREAK", -1, fb.level]);
        if (fb.breakoutState === "BREAKOUT_ACCEPTED" && fb.level != null) hits.push(["BREAK", 1, fb.level]);
        for (const [kind, dir, lvl] of hits) {
          const key = `${ls}|${kind}|${dir}|${Math.round(lvl)}`; if (seen.has(key)) continue; seen.add(key);
          const stop = kind === "FAKE" ? (dir > 0 ? lo4 : hi4) : (dir > 0 ? lo2 : hi2);
          ev.push({ set, ls, kind, dir, ...score(path, px, stop, px + dir * a, dir, a) });
        }
      }
    }
    hist5 = hist5.concat(B5).slice(-400); histT = histT.concat(B).slice(-400);
    prevDay = B5.length ? { h: Math.max(...B5.map((b) => b.high)), l: Math.min(...B5.map((b) => b.low)) } : prevDay;
  });
  return { sessions: ds.length, ev, base };
}

if (require.main === module) {
  const to = latestRawDay(), bk = (x: number) => Math.min(12, Math.floor(x / 0.25));
  const stat = (r: Res[]) => r.length ? `n=${String(r.length).padStart(5)}  right ${((r.filter((x) => x.res === "RIGHT").length / r.length) * 100).toFixed(1).padStart(5)}%  avg ${(r.reduce((s, x) => s + x.r, 0) / r.length).toFixed(2).padStart(5)}R` : "n=    0".padEnd(38);
  const matched = (r: Res[], b: Res[]) => { const byB = new Map<number, Res[]>(); for (const x of b) { const k = bk(x.stopPts); (byB.get(k) || byB.set(k, []).get(k)!).push(x); }
    let w = 0, R = 0, n = 0; for (const e of r) { const pool = byB.get(bk(e.stopPts)); if (!pool || pool.length < 30) continue; w += pool.filter((x) => x.res === "RIGHT").length / pool.length; R += pool.reduce((s, x) => s + x.r, 0) / pool.length; n++; }
    return n ? `${((w / n) * 100).toFixed(1)}% / ${(R / n).toFixed(2)}R` : "—"; };
  const name = { L0: "live levels", C1: "prev candle H/L", C2: "higher-TF candle H/L", C3: "day high/low" } as Record<string, string>;
  for (const [ix, days] of [["NIFTY", assemble(FROM, to).days], ["SENSEX", assembleIndex("SENSEX", FROM, to)]] as const) for (const tf of [5, 15] as const) {
    const r = run(days as any, tf);
    console.log(`\n${ix} · ${tf}-min candles · ${r.sessions} sessions`);
    for (const set of ["DEV", "VAL"]) for (const kind of ["FAKE", "BREAK"]) for (const dir of [1, -1]) for (const ls of SETS) {
      const e = r.ev.filter((x) => x.set === set && x.kind === kind && x.dir === dir && x.ls === ls), b = r.base.filter((x) => x.set === set && x.dir === dir);
      const lab = `${set} ${kind === "FAKE" ? (dir > 0 ? "FAKE-DOWN" : "FAKE-UP") : dir > 0 ? "BREAK-UP" : "BREAK-DOWN"} · ${name[ls]}`;
      console.log(`  ${lab.padEnd(40)} ${stat(e)}  | same-stop baseline ${matched(e, b)}`);
    }
  }
  process.exit(0);
}
