// Backtest of support / resistance BREAK candles on 5-min and 15-min, with the SAME detector and candle grading as the live
// alerts (backend/premium/levelBreak.ts). Levels = the plan ladder known before each session (prev day H/L/C, pivots,
// prev week H/L; no OI walls — no historical chain). Usage: npx tsx backend/research/levelBreaks/run.ts <dir> [out.json]
import * as fs from "fs";
import * as TV from "../../premium/traderView";
import { detectBreaks, breakOutcome } from "../../premium/levelBreak";
import { atr } from "../../indicators";

type C = { time: number; open: number; high: number; low: number; close: number; volume: number };
const day = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
const mn = (t: number) => { const d = new Date((t + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const agg = (bs: C[], stepMin: number): C[] => { const out: C[] = []; let cur: C | null = null, key = -1; for (const b of bs) { const k = Math.floor((mn(b.time) - 555) / stepMin); if (k !== key || !cur) { if (cur) out.push(cur); cur = { ...b }; key = k; } else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; } } if (cur) out.push(cur); return out; };
const [dir, outFile] = [process.argv[2], process.argv[3]];
const stats: Record<string, { n: number; ft: number; failed: number; stalled: number; mfe: number; mae: number }> = {};
const add = (k: string, o: ReturnType<typeof breakOutcome>, a: number) => { const s = (stats[k] = stats[k] || { n: 0, ft: 0, failed: 0, stalled: 0, mfe: 0, mae: 0 }); s.n++; if (o.res === "FOLLOW-THROUGH") s.ft++; else if (o.res === "FAILED") s.failed++; else s.stalled++; s.mfe += o.mfe / a; s.mae += o.mae / a; };
let sessions = 0, from = "", to = "";
for (const name of ["NIFTY", "SENSEX"]) {
  const raw: C[] = JSON.parse(fs.readFileSync(`${dir}/${name}.json`, "utf8")).filter((b: C) => mn(b.time) < 915);   // trader's day ends 15:15
  const by = new Map<string, C[]>(); for (const b of raw) { const d = day(b.time); if (!by.has(d)) by.set(d, []); by.get(d)!.push(b); }
  const days = [...by.keys()].sort().filter((d) => by.get(d)!.length >= 66);
  sessions = days.length; from = days[0]; to = days[days.length - 1];
  const daily = days.map((d) => { const bs = by.get(d)!; return { time: bs[0].time, open: bs[0].open, high: Math.max(...bs.map((b) => b.high)), low: Math.min(...bs.map((b) => b.low)), close: bs[bs.length - 1].close, volume: 0 }; });
  for (const [tf, step, horizon] of [["5m", 5, 12], ["15m", 15, 8]] as const) {
    const allBars = days.flatMap((d) => agg(by.get(d)!, step)), atrs = atr(allBars as any, 14) as (number | null)[];
    const atrAt = (t: number) => { const i = allBars.findIndex((b) => b.time === t); for (let j = i; j >= 0; j--) if (atrs[j] != null) return atrs[j]!; return null; };
    for (let i = 5; i < days.length; i++) {
      const bars = agg(by.get(days[i])!, step), a0 = atrAt(bars[0].time); if (!a0) continue;
      const levels = TV.ladder({ daily: daily.slice(0, i) as any, sessionDay: days[i], today: { high: null, low: null }, lines: [], chain: [], spot: bars[0].open, atr: a0 }).filter((l) => l.kind !== "TODAY");
      for (const e of detectBreaks(bars, levels, a0)) {
        const a = atrAt(e.bar.time) ?? a0, o = breakOutcome(bars, e.index, e.level.price, e.dir, a, horizon);
        for (const k of [`${tf}|${e.dir}|${e.q.grade}`, `${tf}|${e.dir}|ALL`, `${tf}|${e.dir}|${e.q.grade}|${e.level.kind}`, `${name}|${tf}|${e.dir}|${e.q.grade}`]) add(k, o, a);
      }
    }
  }
}
const rows = Object.fromEntries(Object.entries(stats).sort().map(([k, s]) => [k, { n: s.n, ft: s.ft, failed: s.failed, stalled: s.stalled, ftPct: Math.round((s.ft / s.n) * 100), avgMfeAtr: Math.round((s.mfe / s.n) * 100) / 100, avgMaeAtr: Math.round((s.mae / s.n) * 100) / 100 }]));
const out = { generatedAt: new Date().toISOString(), sessions, from, to, note: "NIFTY + SENSEX pooled; levels = prev day H/L/C, pivots, prev week H/L (no OI walls); FOLLOW-THROUGH = 1 ATR beyond the break close before a close back across the level (5m: 12 bars, 15m: 8 bars)", rows };
if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
for (const [k, r] of Object.entries(rows)) if (k.split("|").length === 3) console.log(k.padEnd(22), `n ${String(r.n).padStart(3)} · follow-through ${r.ft} (${r.ftPct}%) · failed ${r.failed} · stalled ${r.stalled} · avg best ${r.avgMfeAtr} ATR vs worst ${r.avgMaeAtr} ATR`);
console.log(`${sessions} sessions ${from} → ${to}`);
