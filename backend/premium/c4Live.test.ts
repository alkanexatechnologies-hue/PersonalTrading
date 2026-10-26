import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { c4Scan, C4Day } from "./c4Live";
import { assemble, DayData } from "../research/nifty20/data";
import { assembleIndex } from "../research/multiIndex/data";
import { run } from "../research/protrader/fakeMoveGrid";
import { isPaperSignal } from "../research/protrader/fakeUpPaperCore";
import { latestRawDay } from "../research/protrader/dataRange";

// PARITY: on real past sessions the live scan must fire on exactly the candles where the research C4 rule
// (isPaperSignal on fakeMoveGrid.run) fired — same time, level, entry and stop. Skipped when the research cache is absent.
const HAVE = fs.existsSync(path.join(process.cwd(), "data", "research-nifty20", "raw1m"));
for (const [ix, step] of [["NIFTY", 50], ["SENSEX", 100]] as const) {
  test(`c4Scan matches the research C4 rule on real ${ix} sessions`, { skip: !HAVE && "no research cache", timeout: 600_000 }, () => {
    // month chunks are named <from>_<latest download>: load up to the latest downloaded day, then keep a fixed window
    const to = latestRawDay(), raw: DayData[] = (ix === "NIFTY" ? assemble("2026-05-01", to).days : assembleIndex("SENSEX", "2026-05-01", to)).filter((d) => d.day <= "2026-10-23");
    const ds = raw.filter((d) => d.spot.size >= 300);
    const research = run(ds, 5, step).ev.filter((e: any) => isPaperSignal(e, "2000-01-01"));
    const toDay = (d: DayData): C4Day => ({ day: d.day, mins: [...d.spot.entries()] });
    const live: any[] = [];
    for (let di = 0; di < ds.length; di++) {
      const legIx = new Map<string, Map<number, any>>(); for (const [k, arr] of ds[di].legs) legIx.set(k, new Map(arr.map((x) => [x.t, x])));
      const r = c4Scan(ds.slice(0, di).map(toDay), toDay(ds[di]), step, (s, side, t) => legIx.get(`${s}${side}`)?.get(t) ?? null);
      live.push(...r.signals);
    }
    const key = (day: string, t: number, lvl: number, px: number) => `${day}|${t}|${Math.round(lvl)}|${px.toFixed(2)}`;
    const a = research.map((e: any) => key(e.day, e.t, e.lvl, e.px)).sort(), b = live.map((s) => key(s.day, s.t, s.level, s.entryIdx)).sort();
    assert.ok(a.length >= 30, `expected the full May–Oct sample, got ${a.length}`);
    assert.deepEqual(b, a);
    // same stop: research stop = 4-bar high, distance at least 0.25 ATR
    for (const s of live) { const e = research.find((x: any) => x.day === s.day && x.t === s.t)!; assert.equal(s.stopIdx.toFixed(4), (s.entryIdx + Math.max(e.stop - e.px, 0.25 * e.atr)).toFixed(4)); }
  });
}

test("c4Scan never uses a candle that has not closed", () => {
  const T = Date.parse("2026-10-23T09:15:00+05:30") / 1000, mins: [number, number][] = [];
  for (let k = 0; k < 120; k++) mins.push([T + k * 60, 100 + Math.sin(k / 5)]);
  const r = c4Scan([], { day: "2026-10-23", mins }, 50, () => null, T + 30 * 60 + 30);
  assert.equal(r.lastClose, mins[29][1]);           // minute 09:44 closes at 09:45; 09:45 is still forming
});
