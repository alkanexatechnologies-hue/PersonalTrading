// ProTrader study: the OWNER's way of marking support / resistance — horizontal lines where price has TURNED several times
// (clusters of confirmed swing highs / lows) and FLIP zones (a cluster that has been both a high and a low) — versus the
// system's formula levels (prev day, pivots, round numbers, prev week). Same 5-minute test rules as the level memory.
// Levels use only the 5 sessions BEFORE each day (no look-ahead). Usage: npx tsx priceActionLevels.ts
import { confirmedSwings } from "../../premium/premiumCenter";
import * as TV from "../../premium/traderView";
import { levelTests, roundLevels, kindStats, MemEvent, MemLevel } from "../../premium/levelMemory";
import { atr } from "../../indicators";
import { assemble } from "../nifty20/data";
import { barsOf } from "./premiumBacktest2";
import { FROM, latestRawDay } from "./dataRange";

const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
/** Owner-style levels: clusters (within 0.2·ATR15) of confirmed 15-min swings from the previous 5 sessions. */
export function priceActionLevels(prev15: any[], a15: number): MemLevel[] {
  const sw = confirmedSwings(prev15 as any, 2).sort((a, b) => a.price - b.price), cl: { p: number[]; hi: number; lo: number }[] = [];
  for (const s of sw) { const c = cl[cl.length - 1]; if (c && s.price - c.p[c.p.length - 1] <= 0.2 * a15) { c.p.push(s.price); s.kind === "HIGH" ? c.hi++ : c.lo++; } else cl.push({ p: [s.price], hi: s.kind === "HIGH" ? 1 : 0, lo: s.kind === "LOW" ? 1 : 0 }); }
  return cl.filter((c) => c.p.length >= 2).map((c) => {
    const price = Math.round((c.p.reduce((a, x) => a + x, 0) / c.p.length) * 100) / 100;
    const kind = c.hi && c.lo ? "PA FLIP" : c.p.length >= 3 ? "PA 3+ touches" : "PA 2 touches";
    return { price, kind, label: `${kind} (${c.hi}H/${c.lo}L)` };
  });
}
if (require.main === module) {
  const days = assemble(FROM, latestRawDay()).days.filter((d) => d.spot.size >= 300);
  const mins = days.map((d) => [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][]);
  const b5 = mins.map((m) => barsOf(m, 5)), b15 = mins.map((m) => barsOf(m, 15));
  const daily = mins.map((m) => ({ time: m[0][0], open: m[0][1], high: Math.max(...m.map((x) => x[1])), low: Math.min(...m.map((x) => x[1])), close: m[m.length - 1][1], volume: 0 }));
  const ev: MemEvent[] = [], cut = Math.floor(days.length * 2 / 3);
  for (let i = 6; i < days.length; i++) {
    const prev5 = ([] as any[]).concat(...b5.slice(i - 2, i)), a5 = (atr(prev5 as any, 14) as (number | null)[]).filter((x) => x != null).pop();
    const p15 = ([] as any[]).concat(...b15.slice(i - 5, i)), a15 = (atr(p15 as any, 14) as (number | null)[]).filter((x) => x != null).pop();
    if (!a5 || !a15) continue;
    const lad = TV.ladder({ daily: daily.slice(0, i) as any, sessionDay: days[i].day, today: { high: null, low: null }, lines: [], chain: [], spot: b5[i][0].open, atr: a5 }).filter((x) => x.kind !== "TODAY");
    const pa = priceActionLevels(p15, a15).filter((x) => Math.abs(x.price - b5[i][0].open) / b5[i][0].open < 0.03);
    for (const e of levelTests(b5[i], [...lad, ...roundLevels(b5[i][0].open, 100), ...pa], a5)) ev.push({ ...e, day: e.day + (i < cut ? "|DEV" : "|VAL") });
  }
  for (const part of ["DEV", "VAL"]) {
    console.log(`\n=== NIFTY ${part === "DEV" ? "development (first ⅔)" : "validation (last ⅓)"} — how often each kind of level HELD (respected or fake break) vs BROKE`);
    for (const k of kindStats(ev.filter((e) => e.day.endsWith(part)))) console.log(" ", (k.kind + " as " + k.role).padEnd(32), "n", String(k.n).padStart(4), "held", k.holdPct + "%");
  }
  process.exit(0);
}
