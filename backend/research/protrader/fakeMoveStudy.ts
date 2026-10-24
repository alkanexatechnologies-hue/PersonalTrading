// ProTrader FAKE-MOVE STUDY — how often is Market Command's FAKE-DOWN / FAKE-UP label right? (pre-registered 2026-10-24)
// Runs the LIVE detector (analyst/fakeMove.ts detectFakeMoveTF) on real Dhan 1-min spot data resampled to 5-min,
// ~2 years, NIFTY + SENSEX. Levels = what the live screen feeds it minus OI walls (no OI history):
//   last 6 swing points of the live structure engine (liquidity/orderBlock.ts detectMarketStructure, lookback 3, on the
//   last 120 five-minute bars) + previous-day high / low + opening-range (09:15–09:30) high / low.
// EVENT = the first CONFIRMED fake-down (failed breakdown) / fake-up (failed breakout) per level per day, 09:35–15:00.
// OUTCOME (next 60 min, minute data): entry = the confirming bar's close; stop = the swept extreme (lowest low of the
//   last 4 bars for a fake-down, highest high for a fake-up); target = entry ± 1 × ATR(14, 5-min).
//   RIGHT = target before stop; WRONG = stop first; TIME = neither in 60 min (scored as not right).
// BASELINE = a long (short) at EVERY 5-min close with the same stop distance and the same target (no fake condition).
// Candidate improvements (each judged on DEVELOPMENT ⅔ and VALIDATION ⅓; not tuned):
//   F1 strong reclaim — the confirming bar closes in its top 30 % (fake-down) / bottom 30 % (fake-up) of its range
//   F2 higher-TF agrees — 15-min structure not against the fake direction
//   F3 shallow sweep — the poke beyond the level ≤ 0.5 × ATR
//   F4 not the open — confirmation after 09:45
//   F5 level type — swing levels only / day levels (PDH, PDL, ORB) only
import { assemble } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";
import { detectFakeMoveTF, FakeMoveLevel } from "../../analyst/fakeMove";
import { detectMarketStructure } from "../../liquidity/orderBlock";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const bars5 = (mins: [number, number][]): Bar[] => {
  const out: Bar[] = []; let cur: Bar | null = null, key = -1;
  for (const [t, p] of mins) { const m = mn(t); if (m < 555 || m >= 930) continue; const k = Math.floor((m - 555) / 5);
    if (k !== key || !cur) { if (cur) out.push(cur); cur = { time: t - (m - 555 - k * 5) * 60, open: p, high: p, low: p, close: p, volume: 0 }; key = k; }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; } }
  if (cur) out.push(cur); return out;
};
const atr14 = (b: Bar[]) => { if (b.length < 15) return null; let s = 0; for (let i = b.length - 14; i < b.length; i++) s += Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)); return s / 14; };

function run(name: string, days: { day: string; spot: Map<number, number> }[]) {
  const ds = days.filter((d) => d.spot.size >= 300), cut = Math.floor((ds.length * 2) / 3), ev: any[] = [], base: any[] = [];
  let hist: Bar[] = [], prevDay: { h: number; l: number } | null = null;
  ds.forEach((d, di) => {
    const mins = [...d.spot.entries()].sort((a, b) => a[0] - b[0]) as [number, number][], B = bars5(mins), set = di < cut ? "DEV" : "VAL";
    const orb = B.filter((b) => mn(b.time) < 570), orbH = orb.length ? Math.max(...orb.map((b) => b.high)) : null, orbL = orb.length ? Math.min(...orb.map((b) => b.low)) : null;
    const seen = new Set<string>();
    for (let i = 0; i < B.length; i++) {
      const m = mn(B[i].time) + 5; if (m < 575 || m > 900) continue;
      const all = hist.concat(B.slice(0, i + 1)), win = all.slice(-120), a = atr14(all.slice(-15)); if (!a) continue;
      const entry = B[i].close, t0 = B[i].time + 300, path = mins.filter(([t]) => t >= t0 && t < t0 + 3600 && mn(t) < 930);
      if (path.length < 20) continue;
      // baseline: same target, a typical stop (the last 4 bars' extreme), long and short
      const lo4 = Math.min(...B.slice(Math.max(0, i - 3), i + 1).map((b) => b.low)), hi4 = Math.max(...B.slice(Math.max(0, i - 3), i + 1).map((b) => b.high));
      base.push({ set, dir: 1, res: score(path, entry, lo4, entry + a, 1), stopPts: (entry - lo4) / a }, { set, dir: -1, res: score(path, entry, hi4, entry - a, -1), stopPts: (hi4 - entry) / a });
      const ms: any = detectMarketStructure(win as any, 3);
      const spot = entry, levels: FakeMoveLevel[] = [];
      const push = (p: number | null, label: string) => { if (p != null && isFinite(p)) levels.push({ price: Math.round(p * 100) / 100, label, side: p >= spot ? "resistance" : "support" }); };
      for (const p of (ms.swingPoints || []).slice(-6)) push(p.price, p.type === "HH" || p.type === "LH" ? "Swing High" : "Swing Low");
      if (prevDay) { push(prevDay.h, "Prev Day High"); push(prevDay.l, "Prev Day Low"); }
      if (m >= 575) { push(orbH, "ORB High"); push(orbL, "ORB Low"); }
      const fm = detectFakeMoveTF({ tfLabel: "5M", candles: B.slice(Math.max(0, i - 40), i + 1), levels });
      if (fm.status !== "CONFIRMED" || fm.level == null) continue;
      const key = `${fm.direction}|${Math.round(fm.level)}`; if (seen.has(key)) continue; seen.add(key);
      const dir = fm.direction === "DOWN" ? 1 : -1, last4 = B.slice(Math.max(0, i - 3), i + 1);
      const stop = dir > 0 ? Math.min(...last4.map((b) => b.low)) : Math.max(...last4.map((b) => b.high));
      const rng = B[i].high - B[i].low || 1, closeLoc = (B[i].close - B[i].low) / rng;
      const poke = dir > 0 ? fm.level - stop : stop - fm.level;
      const s15 = detectMarketStructure(resample15(win) as any, 3).currentStructure as string;
      ev.push({ set, dir, res: score(path, entry, stop, entry + dir * a, dir), level: fm.levelLabel,
        f1: dir > 0 ? closeLoc >= 0.7 : closeLoc <= 0.3, f2: dir > 0 ? s15 !== "Bearish" : s15 !== "Bullish", f3: poke <= 0.5 * a, f4: m > 585,
        swing: /Swing/.test(fm.levelLabel || ""), stopPts: Math.abs(entry - stop) / a });
    }
    hist = hist.concat(B).slice(-400); prevDay = B.length ? { h: Math.max(...B.map((b) => b.high)), l: Math.min(...B.map((b) => b.low)) } : prevDay;
  });
  return { name, sessions: ds.length, ev, base };
}
function resample15(b: Bar[]): Bar[] { const out: Bar[] = []; for (const x of b) { const k = x.time - (((x.time + 19800) % 900)); const l = out[out.length - 1]; if (l && l.time === k) { l.high = Math.max(l.high, x.high); l.low = Math.min(l.low, x.low); l.close = x.close; } else out.push({ ...x, time: k }); } return out; }
function score(path: [number, number][], entry: number, stop: number, target: number, dir: number) {
  if (dir * (entry - stop) <= 0) return "WRONG";
  for (const [, p] of path) { if (dir * (p - stop) <= 0) return "WRONG"; if (dir * (p - target) >= 0) return "RIGHT"; }
  return "TIME";
}

if (require.main === module) {
  const to = latestRawDay(), pct = (r: any[]) => (r.length ? ((r.filter((x) => x.res === "RIGHT").length / r.length) * 100).toFixed(1) + "%" : "—");
  // baseline MATCHED on stop distance (0.25-ATR buckets): a wider stop wins more often by itself
  const bk = (x: number) => Math.min(12, Math.floor(x / 0.25));
  const matched = (r: any[], b: any[]) => { const byB = new Map<number, any[]>(); for (const x of b) { const k = bk(x.stopPts); (byB.get(k) || byB.set(k, []).get(k)!).push(x); }
    let w = 0, n = 0; for (const e of r) { const pool = byB.get(bk(e.stopPts)); if (!pool || pool.length < 30) continue; w += pool.filter((x) => x.res === "RIGHT").length / pool.length; n++; } return n ? ((w / n) * 100).toFixed(1) + "%" : "—"; };
  const line = (lab: string, r: any[], b: any[]) => console.log(`  ${lab.padEnd(34)} n=${String(r.length).padStart(4)}  right ${pct(r).padStart(6)}  wrong ${(r.length ? ((r.filter((x) => x.res === "WRONG").length / r.length) * 100).toFixed(1) : "—").padStart(5)}%  | baseline ${pct(b)} · same-stop baseline ${matched(r, b)}`);
  for (const [name, days] of [["NIFTY", assemble(FROM, to).days], ["SENSEX", assembleIndex("SENSEX", FROM, to)]] as const) {
    const r = run(name, days as any);
    console.log(`\n${name} · ${r.sessions} sessions`);
    for (const set of ["DEV", "VAL"]) for (const dir of [1, -1]) {
      const e = r.ev.filter((x) => x.set === set && x.dir === dir), b = r.base.filter((x) => x.set === set && x.dir === dir), lab = dir > 0 ? "FAKE-DOWN (bullish)" : "FAKE-UP (bearish)";
      line(`${set} ${lab}`, e, b);
      line(`${set}   F1 strong reclaim`, e.filter((x) => x.f1), b);
      line(`${set}   F2 15m not against`, e.filter((x) => x.f2), b);
      line(`${set}   F3 shallow sweep`, e.filter((x) => x.f3), b);
      line(`${set}   F4 after 09:45`, e.filter((x) => x.f4), b);
      line(`${set}   F5a swing levels`, e.filter((x) => x.swing), b);
      line(`${set}   F5b day levels`, e.filter((x) => !x.swing), b);
      line(`${set}   F1+F2+F3`, e.filter((x) => x.f1 && x.f2 && x.f3), b);
    }
  }
  process.exit(0);
}
