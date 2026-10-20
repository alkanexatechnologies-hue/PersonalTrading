// ProTrader OPENING STUDY for the Next-Day Map: from ~2 years of real Dhan 1-minute spot (NIFTY, SENSEX) — gap odds by how
// the last day closed, first-5-minute fall-back / travel, the 09:30 stand → rest of the day, and post-09:30 turns.
// Writes data/research-nextday/<INDEX>.json (read by /api/next-day-map). Re-run daily after the 15:50 data refresh.
// Usage: npx tsx openingStudy.ts
import fs from "fs";
import path from "path";
import { assemble, DayData } from "../nifty20/data";
import { assembleIndex } from "../multiIndex/data";
import { FROM, latestRawDay } from "./dataRange";
import { DATA_DIR } from "../../config/dataDir";
import { dayFeatures, study, DayFeat } from "../../premium/nextDayMap";

const OUT = path.join(DATA_DIR, "research-nextday");
const mn = (t: number) => Math.floor(((t + 19800) % 86400) / 60);
export function featuresOf(days: DayData[]): DayFeat[] {
  const ds = days.map((d) => ({ day: d.day, m: [...d.spot.entries()].sort((a, b) => a[0] - b[0]).filter(([t]) => mn(t) >= 555 && mn(t) < 930) as [number, number][] })).filter((d) => d.m.length >= 300);
  const out: DayFeat[] = [], ranges: number[] = [];
  for (let i = 0; i < ds.length; i++) {
    const p = ds[i].m.map((x) => x[1]), hl = { high: Math.max(...p), low: Math.min(...p), close: p[p.length - 1] };
    if (i > 0) { const pm = ds[i - 1].m.map((x) => x[1]); const f = dayFeatures(ds[i].day, ds[i].m, { high: Math.max(...pm), low: Math.min(...pm), close: pm[pm.length - 1] }, ranges); if (f) out.push(f); }
    ranges.push(hl.high - hl.low);
  }
  return out;
}
if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  const to = latestRawDay();
  for (const [name, days] of [["NIFTY", assemble(FROM, to).days], ["SENSEX", assembleIndex("SENSEX", FROM, to)]] as const) {
    const s = study(name, featuresOf(days));
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(s, null, 1));
    console.log(name, s.days, "sessions", s.from, "→", s.to);
  }
  process.exit(0);
}
