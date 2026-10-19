// Build the LEVEL MEMORY from the ~2 years of real Dhan 1-minute data (NIFTY first, then SENSEX): every test of every level
// known before the day (plan ladder: prev day / pivots / prev week / trendlines, + round numbers) on 5-minute candles.
// OI walls are not in the history (no historical chain) — the daily 15:40 job adds them from today on.
// Usage: npx tsx levelMemoryBackfill.ts → data/level-memory/<INDEX>.json
import fs from "fs";
import path from "path";
import * as TV from "../../premium/traderView";
import { levelTests, roundLevels, MemEvent } from "../../premium/levelMemory";
import { atr } from "../../indicators";
import { assemble, DayData } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { barsOf } from "./premiumBacktest2";
import { FROM, latestRawDay } from "./dataRange";
import { DATA_DIR } from "../../config/dataDir";

const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
const OUT = path.join(DATA_DIR, "level-memory");
export function buildIndex(name: "NIFTY" | "SENSEX", days: DayData[], roundStep: number): MemEvent[] {
  const ds = days.filter((d) => d.spot.size >= 300);
  const mins = ds.map((d) => [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][]);
  const b5 = mins.map((m) => barsOf(m, 5)), b15 = mins.map((m) => barsOf(m, 15));
  const daily = mins.map((m) => ({ time: m[0][0], open: m[0][1], high: Math.max(...m.map((x) => x[1])), low: Math.min(...m.map((x) => x[1])), close: m[m.length - 1][1], volume: 0 }));
  const out: MemEvent[] = [];
  for (let i = 6; i < ds.length; i++) {
    const prev5 = ([] as any[]).concat(...b5.slice(i - 2, i)), a5 = (atr(prev5 as any, 14) as (number | null)[]).filter((x) => x != null).pop(); if (!a5) continue;
    const p15 = ([] as any[]).concat(...b15.slice(Math.max(0, i - 15), i)), dly = daily.slice(0, i), l15 = TV.activeLines(p15 as any, 3), lD = TV.activeLines(dly as any, 2);
    const lines = [l15.seller && !l15.seller.broken ? { label: "15m seller trendline", value: l15.seller.next } : null, l15.buyer && !l15.buyer.broken ? { label: "15m buyer trendline", value: l15.buyer.next } : null, lD.seller && !lD.seller.broken ? { label: "Daily seller trendline", value: lD.seller.next } : null, lD.buyer && !lD.buyer.broken ? { label: "Daily buyer trendline", value: lD.buyer.next } : null].filter(Boolean) as any[];
    const lad = TV.ladder({ daily: dly as any, sessionDay: ds[i].day, today: { high: null, low: null }, lines, chain: [], spot: b5[i][0].open, atr: a5 }).filter((x) => x.kind !== "TODAY");
    out.push(...levelTests(b5[i], [...lad, ...roundLevels(b5[i][0].open, roundStep)], a5));
  }
  return out;
}
if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  const to = latestRawDay();
  for (const [name, days, step] of [["NIFTY", assemble(FROM, to).days, 100], ["SENSEX", assembleIndex("SENSEX", FROM, to), 500]] as const) {
    const ev = buildIndex(name, days, step);
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ index: name, updatedAt: new Date().toISOString(), lastDay: ev.length ? ev[ev.length - 1].day : null, roundStep: step, events: ev }));
    console.log(name, "tests", ev.length, "days", new Set(ev.map((e) => e.day)).size, "to", ev.length ? ev[ev.length - 1].day : "-");
  }
  process.exit(0);
}
