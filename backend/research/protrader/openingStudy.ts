// ProTrader OPENING STUDY for the Next-Day Map — from Dhan's 5-MIN index candles (true OHLC; the 09:15 open = NSE's official
// open) and Dhan's OFFICIAL daily candles (previous high / low / close, daily range), ~2 years, NIFTY + SENSEX.
// (Cross-check 2026-10-22: the earlier 1-minute series' "open" was a median 27 pts off the official open — replaced.)
// Writes data/research-nextday/<INDEX>.json (read by /api/next-day-map). Re-run daily after the 15:50 data refresh.
// Usage: npx tsx openingStudy.ts
import fs from "fs";
import path from "path";
import { DATA_DIR } from "../../config/dataDir";
import { fetchDhanCandles } from "../../data/dhanHistorical";
import { lookupDhanSecurity } from "../../data/dhanInstruments";
import { dayFeatures5m, study, DayFeat } from "../../premium/nextDayMap";

const OUT = path.join(DATA_DIR, "research-nextday"), FROM = "2024-10-01";
const dayOf = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);
type C = { time: number; open: number; high: number; low: number; close: number };
/** Session features from 5-min bars + official daily candles (oldest first). */
export function featuresFrom(c5: C[], d1: C[]): DayFeat[] {
  const byDay = new Map<string, C[]>(); for (const c of c5) { const d = dayOf(c.time); (byDay.get(d) || byDay.set(d, []).get(d)!).push(c); }
  const daily = new Map(d1.map((c) => [dayOf(c.time), c]));
  const days = [...byDay.keys()].sort(), out: DayFeat[] = [], ranges: number[] = [];
  for (let i = 0; i < days.length; i++) {
    const bars = byDay.get(days[i])!, off = daily.get(days[i]);
    const hl = off ? { high: off.high, low: off.low, close: off.close } : { high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)), close: bars[bars.length - 1].close };
    if (i > 0) { const pd = daily.get(days[i - 1]), pb = byDay.get(days[i - 1])!; const prev = pd ? { high: pd.high, low: pd.low, close: pd.close } : { high: Math.max(...pb.map((b) => b.high)), low: Math.min(...pb.map((b) => b.low)), close: pb[pb.length - 1].close };
      const f = dayFeatures5m(days[i], bars, prev, ranges, off?.close ?? null); if (f) out.push(f); }
    ranges.push(hl.high - hl.low);
  }
  return out;
}
if (require.main === module) {
  (async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const to = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    for (const name of ["NIFTY", "SENSEX"]) {
      const sec = await lookupDhanSecurity(name); if (!sec) { console.log(name, "no Dhan security"); continue; }
      const c5 = await fetchDhanCandles(sec, "5" as any, FROM, to);
      const d1: C[] = []; for (let y = 2024; y <= Number(to.slice(0, 4)); y++) for (const [a, b] of [[`${y}-01-01`, `${y}-06-30`], [`${y}-07-01`, `${y}-12-31`]]) { if (b < FROM || a > to) continue; d1.push(...(await fetchDhanCandles(sec, "1d" as any, a < FROM ? FROM : a, b > to ? to : b).catch(() => []))); }
      const s = study(name, featuresFrom(c5, d1));
      fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ ...s, source: "Dhan 5-min index candles + Dhan official daily candles" }, null, 1));
      console.log(name, s.days, "sessions", s.from, "→", s.to);
    }
    process.exit(0);
  })();
}
