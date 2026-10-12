import { test } from "node:test";
import assert from "node:assert/strict";
import { featuresFor, outcomeFor, giftNight, lastBefore, similarity, findSimilar, buildLibrary, validateLibrary, type Bar, type History } from "./similarScenarios";

const ist = (d: string, hm: string) => Math.floor(Date.parse(`${d}T${hm}:00Z`) / 1000) - 19800;
function session(d: string, start: number, path: (i: number) => number): Bar[] {
  return Array.from({ length: 75 }, (_, i) => {
    const t = ist(d, "09:15") + i * 300, o = start + path(i), c = start + path(i + 1);
    return { time: t, open: o, high: Math.max(o, c) + 2, low: Math.min(o, c) - 2, close: c };
  });
}
function hist(): History {
  const days = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
  const nifty5 = days.flatMap((d, k) => session(d, 22000 + k * 50, (i) => (k % 2 ? -i : i)));
  const gift5: Bar[] = days.flatMap((d) => [{ time: ist(d, "15:25"), open: 22000, high: 22000, low: 22000, close: 22000 }, { time: ist(d, "23:00"), open: 22100, high: 22100, low: 22100, close: 22100 }]);
  const stock = (sl: number) => days.flatMap((d) => session(d, 1000, (i) => sl * i));
  return { nifty5, gift5, it: { INFY: stock(1) }, bank: { HDFCBANK: stock(-1) }, coefs: { INFY: 0.03, HDFCBANK: 0.1 },
    crude: days.map((d, k) => [d, 9400 + k * 100] as [string, number]), vix: days.map((d) => ({ date: d, open: 15, prevClose: 14 })), fii: { "2026-10-05": 8000, "2026-10-06": -9000, "2026-10-07": 2000, "2026-10-08": -12000 } };
}

test("features use only data knowable at 09:25 (no look-ahead)", () => {
  const h = hist();
  const before = featuresFor(h, "2026-10-08");
  // change everything after 09:25 on that day, and every later day
  const t925 = ist("2026-10-08", "09:25");
  const h2: History = { ...h, nifty5: h.nifty5.map((b) => (b.time >= t925 ? { ...b, close: b.close + 500, high: b.high + 500 } : b)),
    crude: h.crude.map(([d, v]) => [d, d >= "2026-10-08" ? 20000 : v] as [string, number]), fii: { ...h.fii, "2026-10-08": 99999 } };
  assert.deepEqual(featuresFor(h2, "2026-10-08"), before);
  assert.notDeepEqual(outcomeFor(h2.nifty5, "2026-10-08"), outcomeFor(h.nifty5, "2026-10-08"));   // outcomes do see later bars
});

test("feature values: gap, first two candles, groups, crude before the day, FII from the previous session", () => {
  const f = featuresFor(hist(), "2026-10-08");
  assert.equal(f.first2, "RR");                     // day index 3 → falling path
  assert.equal(f.crude, 9600);                      // last value strictly before 10-08 (10-07)
  assert.equal(f.fiiNet, 2000);                     // previous session's file (10-07)
  // each synthetic stock day restarts at 1000: IT 09:20 close 1002 vs prev close 1075; bank 998 vs 925
  assert.equal(f.itPct, -6.79); assert.equal(f.bankPct, 7.89);
  assert.equal(f.vixPct, 7.14);
  assert.ok(f.gapPct != null);
});

test("lastBefore never returns the same day", () => {
  assert.deepEqual(lastBefore([["2026-10-07", 1], ["2026-10-08", 2]], "2026-10-08"), { date: "2026-10-07", value: 1, prev: null });
  assert.equal(lastBefore([["2026-10-08", 2]], "2026-10-08"), null);
});

test("GIFT NIFTY overnight = night-session close vs previous 15:25", () => {
  assert.equal(giftNight(hist().gift5, "2026-10-08"), 0.45);
  // Friday's night session ends Saturday 02:45; Monday uses it (not Saturday's bars as a 'day')
  const fri: Bar[] = [{ time: ist("2026-10-09", "15:25"), open: 1, high: 1, low: 1, close: 22000 }, { time: ist("2026-10-10", "02:40"), open: 1, high: 1, low: 1, close: 22220 }, { time: ist("2026-10-12", "06:30"), open: 1, high: 1, low: 1, close: 99999 }];
  assert.equal(giftNight(fri, "2026-10-12"), 1);
});

test("outcomes measured from the 09:20-bar close", () => {
  const o = outcomeFor(hist().nifty5, "2026-10-05")!;
  // 15 min after 09:25 = close of the 09:35 bar; 30 min = 09:50 bar; 60 min = 10:20 bar
  assert.equal(o.ref, 22002); assert.equal(o.m15, 3); assert.equal(o.m30, 6); assert.equal(o.m60, 12);
  assert.ok(o.maxUp! >= o.m60! && o.maxDown! <= 0);
});

test("similarity = share of compared conditions that match; not a probability", () => {
  const f = featuresFor(hist(), "2026-10-08");
  const s = similarity(f, f);
  assert.equal(s.pct, 100); assert.equal(s.compared, 8);
  assert.equal(similarity(f, { ...f, first2: "GG", crude: 9500 }).pct, 75);
});

test("findSimilar only uses past days and reports sample size and completeness", () => {
  const lib = buildLibrary(hist());
  const today = featuresFor(hist(), "2026-10-08");
  const r = findSimilar(today, "2026-10-08", lib);
  assert.ok(r.rows.every((x) => x.date < "2026-10-08"));
  assert.equal(r.library, lib.filter((x) => x.date < "2026-10-08").length);
  assert.equal(r.completeness.of, 8);
  assert.match(r.note, /not a probability/);
});

test("validation reports no edge with too few calls, and never claims an edge below 55 %", () => {
  const v = validateLibrary(buildLibrary(hist()), 2);
  assert.equal(v.edge, false);
  assert.ok(/no predictive edge|Not enough/.test(v.note));
});
