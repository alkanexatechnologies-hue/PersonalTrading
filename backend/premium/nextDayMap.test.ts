import { test } from "node:test";
import assert from "node:assert/strict";
import { dayFeatures, study, nextDayMap, gapBucket, closeLoc, standZone, DayFeat } from "./nextDayMap";

// one session of 1-minute prices from 09:15 (epoch of 09:15 IST on some day + i minutes)
const T915 = Date.parse("2026-10-12T03:45:00Z") / 1000;
const session = (f: (i: number) => number) => Array.from({ length: 375 }, (_, i) => [T915 + i * 60, f(i)] as [number, number]);

test("dayFeatures: open, 09:20 / 09:30 prices, first-15 range, post-09:30 high and the pullback after it", () => {
  // rises 1 pt a minute to 10:15 (min 60), then falls 1 pt a minute
  const f = dayFeatures("2026-10-12", session((i) => 1000 + (i <= 60 ? i : 120 - i)), { high: 1010, low: 980, close: 995 }, [40, 40, 40, 40, 40])!;
  assert.equal(f.open, 1000); assert.equal(f.p920, 1004); assert.equal(f.p930, 1014); assert.equal(f.or15h, 1014); assert.equal(f.or15l, 1000);
  assert.equal(f.atr, 40); assert.equal(f.hiAfter, 1060); assert.equal(f.hi1015, 1060); assert.equal(f.close, 1000 + 120 - 374);
  assert.equal(f.pullAfterHi, 1060 - (1000 + 120 - 374));
});
test("buckets: gap size in ATR, where the last day closed, where 09:30 stands", () => {
  assert.equal(gapBucket(-0.6), "BIG GAP DOWN"); assert.equal(gapBucket(0), "FLAT"); assert.equal(gapBucket(0.2), "GAP UP"); assert.equal(gapBucket(0.5), "BIG GAP UP");
  assert.equal(closeLoc(101, 110, 100), "WEAK"); assert.equal(closeLoc(109, 110, 100), "STRONG");
  assert.equal(standZone(111, 110, 105, 100), "ABOVE PDH"); assert.equal(standZone(106, 110, 105, 100), "PDC–PDH"); assert.equal(standZone(99, 110, 105, 100), "BELOW PDL");
});

const feat = (o: Partial<DayFeat>, i: number): DayFeat => ({ day: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, pdc: 1000, pdh: 1020, pdl: 980, atr: 40, open: 1000, p920: 1000, p930: 1000, close: 1000, or15h: 1005, or15l: 995,
  lo2045: 998, hi2045: 1002, lo1015: 995, hi1015: 1005, hiAfter: 1010, loAfter: 990, pullAfterHi: 20, bounceAfterLo: 20, ...o });

test("study: gap-up opens whose first 5 min rise — fall-back %, gap-fill %, travel when held", () => {
  const xs = [
    ...Array.from({ length: 6 }, (_, i) => feat({ open: 1012, p920: 1016, lo2045: 1008, lo1015: 999, hi1015: 1020 }, i)),   // fell back below the open, filled the gap
    ...Array.from({ length: 4 }, (_, i) => feat({ open: 1012, p920: 1016, lo2045: 1013, lo1015: 1010, hi1015: 1032 }, i + 6)),  // held: +20 = 0.5 ATR
  ];
  const s = study("TEST", xs).first5["UP|UP"];
  assert.equal(s.n, 10); assert.equal(s.fallBackPct, 60); assert.equal(s.gapFillPct, 60); assert.equal(s.heldTravelMed, 0.5);
});
test("study: a 09:30 stand is a bias only when development AND validation agree", () => {
  const up = Array.from({ length: 60 }, (_, i) => feat({ p930: 1010, open: 1000, close: 1030, hiAfter: 1040 }, i));   // PDC–PDH, above open, always closes higher
  const s = study("TEST", up).stand["PDC–PDH|above open"];
  assert.equal(s.upClosePct, 100); assert.equal(s.devUp, 100); assert.equal(s.valUp, 100); assert.equal(s.upExtMed, 0.75);
});

test("nextDayMap: six points; before the open it gives the likely open range, after 09:30 it reads the real stand", () => {
  const xs = Array.from({ length: 90 }, (_, i) => feat(i % 2 ? { open: 1012, p920: 1016, p930: 1010, close: 1030, hiAfter: 1040 } : { open: 1000, p930: 1004, close: 990 }, i));
  const st = study("TEST", xs);
  const levels = [{ price: 1040, label: "R1 pivot", kind: "PIVOT", holdPct: 60, tests: 10 }, { price: 1030, label: "Prev week high", kind: "WEEK", holdPct: 40, tests: 5 }, { price: 1020, label: "Prev day high", kind: "PREV DAY" }, { price: 980, label: "Prev day low", kind: "PREV DAY", holdPct: 55, tests: 9 }];
  const pre = nextDayMap({ index: "TEST", planFor: "2026-10-21", study: st, pdh: 1020, pdl: 980, pdc: 1000, atr: 40, levels });
  assert.deepEqual(pre.points.map((p) => p.n), [1, 2, 3, 4, 5, 6]);
  assert.match(pre.points[0].lines[0], /Most likely: <b>(FLAT|GAP UP)/);
  assert.ok(pre.points.every((p) => !p.live));
  const live = nextDayMap({ index: "TEST", planFor: "2026-10-21", study: st, pdh: 1020, pdl: 980, pdc: 1000, atr: 40, levels, seen: { open: 1012, p920: 1016, p930: 1010 } });
  assert.match(live.points[0].lines[0], /Opened 1,012 → GAP UP/);
  assert.match(live.points[1].lines[0], /First 5 min: UP/);
  assert.match(live.points[2].lines[0], /09:30: 1,010 → PDC–PDH, below open/);
  assert.match(live.points[4].lines[0], /Rejection zone: (R1 pivot 1,040|Prev week high 1,030|Prev day high 1,020)/);
  assert.match(live.points[5].lines[0], /Support zone: Prev day low 980<\/b> — held 55% of 9 past tests/);
});

import { dayFeatures5m } from "./nextDayMap";
test("dayFeatures5m: the 09:15 candle's OPEN is the open, real highs / lows, official close; 09:20 / 09:30 from candle closes", () => {
  const T = Date.parse("2026-10-21T03:45:00Z") / 1000;
  const bars = Array.from({ length: 75 }, (_, i) => ({ time: T + i * 300, open: 100 + i, high: 103 + i, low: 98 + i, close: 101 + i }));
  const f = dayFeatures5m("2026-10-21", bars, { high: 120, low: 90, close: 99 }, [30, 30, 30, 30, 30], 175)!;
  assert.equal(f.open, 100); assert.equal(f.p920, 101); assert.equal(f.p930, 103); assert.equal(f.or15h, 105); assert.equal(f.or15l, 98);
  assert.equal(f.close, 175, "official close"); assert.equal(f.hiAfter, 103 + 74); assert.equal(f.lo2045, 99); assert.equal(f.atr, 30);
  assert.equal(dayFeatures5m("x", bars.slice(1), { high: 1, low: 1, close: 1 }, [1, 1, 1, 1, 1]), null, "must start with the 09:15 candle");
});
