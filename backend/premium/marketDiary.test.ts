import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDiary, diaryText } from "./marketDiary";

const t0 = 1_792_122_300;   // a 09:15 IST bar
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ time: t0 + i * 300, open: o, high: h, low: l, close: c });

test("diary: gap-up filled early, then rallied to close near the high = V-reversal; story and notes are factual", () => {
  const bars = [bar(0, 23065, 23070, 23020, 23030), bar(1, 23030, 23035, 22960, 22970), bar(2, 22970, 22975, 22914, 22930),
    bar(3, 22930, 23000, 22925, 22995), bar(4, 22995, 23080, 22990, 23075), bar(5, 23075, 23150, 23070, 23140), bar(6, 23140, 23148, 23120, 23146)];
  const e = buildDiary({ symbol: "^NSEI", name: "NIFTY 50", day: "2026-10-16", bars, prevClose: 22997.35, vwapClose: 23081,
    trades: [{ source: "co-pilot", side: "CE", strike: 23050, entryPrem: 100, exitPrem: 150, exitWhy: "T1", openedAt: t0 + 1500 }] })!;
  assert.equal(e.gap.dir, "UP"); assert.equal(e.gap.filledAt, "09:20");
  assert.equal(e.dayType, "GAP-UP SHAKEOUT → RALLY (V-reversal)");
  assert.equal(e.lowAt, "09:25"); assert.equal(e.highAt, "09:40");
  assert.equal(e.openingRange.breakDir, "UP");   // the dip was inside the 09:15–09:30 range; the first close outside it was above
  assert.equal(e.closeVsVwap, "ABOVE"); assert.ok(e.closeLocationPct >= 90);
  assert.ok(e.notes.some((n) => /filled 5 min after the open/.test(n)));
  assert.equal(e.trades[0].pnlPct, 50);
  assert.match(diaryText(e), /NIFTY 50 2026-10-16 — GAP-UP SHAKEOUT/);
});
test("diary: flat open, steady fall, close at the low = trend down; no data = null", () => {
  const bars = Array.from({ length: 10 }, (_, i) => bar(i, 100 - i, 100.5 - i, 98.8 - i, 99 - i));
  const e = buildDiary({ symbol: "X", name: "X", day: "d", bars, prevClose: 100.05 })!;
  assert.equal(e.gap.dir, "FLAT"); assert.equal(e.dayType, "TREND DOWN"); assert.equal(e.closeVsVwap, null);
  assert.equal(buildDiary({ symbol: "X", name: "X", day: "d", bars: [], prevClose: 100 }), null);
});
