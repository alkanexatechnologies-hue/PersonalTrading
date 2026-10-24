// ProTrader FAKE-MOVE STUDY #4 — CANDLE FAKE AT A SUPPORT / RESISTANCE LEVEL (owner's idea, 2026-10-24).
// Event = a candle-level fake (study #3 C1: the high / low of the candle before the detector's 4-bar window is swept and
// reclaimed — live detectFakeMoveTF). Confluence variants (pre-registered, distance d = 0.3 × ATR of the timeframe;
// 0.15 × ATR reported as the tight check):
//   K0 candle fake alone                                         — the reference (study #3)
//   K1 the swept candle level is within d of a LIVE S/R level      (swing points + PDH/PDL + ORB, as the screen)
//   K2 the swept candle level is within d of an OWNER S/R level    (priceActionLevels: clusters of 15-min swings of the
//      previous 5 sessions, flip zones — the owner's method, no look-ahead)
//   K3 the same candle also confirms the LIVE-level fake in the same direction (both labels at once)
//   K4 K1 or K2 at the tight distance (0.15 × ATR)
// Scoring as studies #2/#3: target 1 × ATR, stop = 4-bar sweep extreme, 60 min (5m) / 120 min (15m), same-stop baseline,
// avg R, DEV ⅔ / VAL ⅓, NIFTY + SENSEX.
import { assemble } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";
import { detectFakeMoveTF, FakeMoveLevel } from "../../analyst/fakeMove";
import { detectMarketStructure } from "../../liquidity/orderBlock";
import { priceActionLevels } from "./priceActionLevels";

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
const toLevels = (ps: [number | null, string][], px: number): FakeMoveLevel[] =>
  ps.filter(([p]) => p != null && isFinite(p!)).map(([p, label]) => ({ price: Math.round(p! * 100) / 100, label, side: p! >= px ? "resistance" : "support" }));

function run(days: { day: string; spot: Map<number, number> }[], tf: 5 | 15) {
  const ds = days.filter((d) => d.spot.size >= 300), cut = Math.floor((ds.length * 2) / 3), horizon = tf === 5 ? 3600 : 7200;
  const ev: any[] = [], base: Res[][] = [[], []];
  const baseOf: Record<string, Record<number, Res[]>> = { DEV: { 1: [], [-1]: [] }, VAL: { 1: [], [-1]: [] } };
  let hist5: Bar[] = [], histT: Bar[] = [], prevDay: { h: number; l: number } | null = null; const past15: Bar[][] = [];
  ds.forEach((d, di) => {
    const mins = [...d.spot.entries()].sort((a, b) => a[0] - b[0]) as [number, number][], set = di < cut ? "DEV" : "VAL";
    const B5 = barsN(mins, 5), B = tf === 5 ? B5 : barsN(mins, 15);
    const prev15 = past15.slice(-5).flat(), a15 = atr14(prev15.slice(-15)), owner = prev15.length >= 50 && a15 ? priceActionLevels(prev15, a15).map((l) => l.price) : [];
    const orb = B5.filter((b) => mn(b.time) < 570), orbH = orb.length ? Math.max(...orb.map((b) => b.high)) : null, orbL = orb.length ? Math.min(...orb.map((b) => b.low)) : null;
    const pathFrom = (t0: number) => mins.filter(([t]) => t >= t0 && t < t0 + horizon && mn(t) < 930);
    const seen = new Set<string>();
    for (let i = 4; i < B.length; i++) {
      const tEnd = B[i].time + tf * 60, m = mn(tEnd); if (m < 575 || m > (tf === 5 ? 900 : 870)) continue;
      const a = atr14(histT.concat(B.slice(0, i + 1)).slice(-15)); if (!a) continue;
      const path = pathFrom(tEnd); if (path.length < 20) continue;
      const px = B[i].close, last4 = B.slice(i - 3, i + 1), lo4 = Math.min(...last4.map((b) => b.low)), hi4 = Math.max(...last4.map((b) => b.high));
      baseOf[set][1].push(score(path, px, lo4, px + a, 1, a)); baseOf[set][-1].push(score(path, px, hi4, px - a, -1, a));
      const ref = B[i - 4], candles = B.slice(Math.max(0, i - 40), i + 1);
      const fc = detectFakeMoveTF({ tfLabel: `${tf}M`, candles, levels: toLevels([[ref.high, "Candle High"], [ref.low, "Candle Low"]], px) });
      if (fc.status !== "CONFIRMED" || fc.level == null) continue;
      const dir = fc.direction === "DOWN" ? 1 : -1, key = `${dir}|${Math.round(fc.level)}`; if (seen.has(key)) continue; seen.add(key);
      const live: [number | null, string][] = [];
      const win5 = hist5.concat(B5.filter((b) => b.time + 300 <= tEnd)).slice(-120);
      for (const p of ((detectMarketStructure(win5 as any, 3) as any).swingPoints || []).slice(-6)) live.push([p.price, p.type === "HH" || p.type === "LH" ? "Swing High" : "Swing Low"]);
      if (prevDay) live.push([prevDay.h, "PDH"], [prevDay.l, "PDL"]);
      live.push([orbH, "ORB High"], [orbL, "ORB Low"]);
      const near = (ps: number[], k: number) => ps.some((p) => Math.abs(p - fc.level!) <= k * a);
      const livePs = live.filter(([p]) => p != null).map(([p]) => p!);
      const fl = detectFakeMoveTF({ tfLabel: `${tf}M`, candles, levels: toLevels(live, px) });
      ev.push({ set, dir, ...score(path, px, dir > 0 ? lo4 : hi4, px + dir * a, dir, a),
        k1: near(livePs, 0.3), k2: near(owner, 0.3), k3: fl.status === "CONFIRMED" && (fl.direction === "DOWN" ? 1 : -1) === dir,
        k4: near(livePs, 0.15) || near(owner, 0.15) });
    }
    hist5 = hist5.concat(B5).slice(-400); histT = histT.concat(B).slice(-400); past15.push(barsN(mins, 15));
    prevDay = B5.length ? { h: Math.max(...B5.map((b) => b.high)), l: Math.min(...B5.map((b) => b.low)) } : prevDay;
  });
  void base; return { sessions: ds.length, ev, baseOf };
}

if (require.main === module) {
  const to = latestRawDay(), bk = (x: number) => Math.min(12, Math.floor(x / 0.25));
  const stat = (r: Res[]) => r.length ? `n=${String(r.length).padStart(5)}  right ${((r.filter((x) => x.res === "RIGHT").length / r.length) * 100).toFixed(1).padStart(5)}%  avg ${(r.reduce((s, x) => s + x.r, 0) / r.length).toFixed(2).padStart(5)}R` : "n=    0".padEnd(38);
  const matched = (r: Res[], b: Res[]) => { const byB = new Map<number, Res[]>(); for (const x of b) { const k = bk(x.stopPts); (byB.get(k) || byB.set(k, []).get(k)!).push(x); }
    let w = 0, R = 0, n = 0; for (const e of r) { const pool = byB.get(bk(e.stopPts)); if (!pool || pool.length < 30) continue; w += pool.filter((x) => x.res === "RIGHT").length / pool.length; R += pool.reduce((s, x) => s + x.r, 0) / pool.length; n++; }
    return n ? `${((w / n) * 100).toFixed(1)}% / ${(R / n).toFixed(2)}R` : "—"; };
  const V: [string, (x: any) => boolean][] = [["K0 candle fake alone", () => true], ["K1 at live S/R (0.3 ATR)", (x) => x.k1], ["K2 at owner S/R (0.3 ATR)", (x) => x.k2],
    ["K3 + live-level fake same bar", (x) => x.k3], ["K4 any S/R tight (0.15 ATR)", (x) => x.k4], ["K1 and K2 both", (x) => x.k1 && x.k2]];
  for (const [ix, days] of [["NIFTY", assemble(FROM, to).days], ["SENSEX", assembleIndex("SENSEX", FROM, to)]] as const) for (const tf of [5, 15] as const) {
    const r = run(days as any, tf);
    console.log(`\n${ix} · ${tf}-min candles · ${r.sessions} sessions`);
    for (const set of ["DEV", "VAL"]) for (const dir of [1, -1]) for (const [lab, f] of V) {
      const e = r.ev.filter((x) => x.set === set && x.dir === dir && f(x));
      console.log(`  ${`${set} ${dir > 0 ? "FAKE-DOWN" : "FAKE-UP"} · ${lab}`.padEnd(46)} ${stat(e)}  | same-stop baseline ${matched(e, r.baseOf[set][dir])}`);
    }
  }
  process.exit(0);
}
