import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseCrude } from "./crudeMove";

const T0 = Date.parse("2026-10-01T09:00:00+05:30") / 1000;
const bars = (closes: number[]) => closes.map((c, i) => ({ time: T0 + i * 300, open: c, high: c + 1, low: c - 1, close: c, volume: 100 }));

test("last 4 h = the last 48 bars vs the close before them", () => {
  const cl = [...Array(60).fill(9000), ...Array.from({ length: 48 }, (_, i) => 9000 + (i + 1) * 2)];
  const r = analyseCrude(bars(cl) as any);
  assert.equal(r.available, true);
  assert.equal(r.last4h!.change, 96);
  assert.equal(r.last4h!.hourly.length, 4);
  assert.equal(r.last4h!.hourly.reduce((a, h) => a + h.change, 0), 96);
  assert.equal(r.trend!.state, "UP");
  assert.equal(r.price, 9096);
});

test("live price overrides the last close for display only, while MCX is trading", () => {
  const lastEnd = T0 + 60 * 300;
  const r = analyseCrude(bars(Array(60).fill(9000)) as any, { value: 9012, ts: lastEnd + 120 });
  assert.equal(r.price, 9012); assert.equal(r.live, true); assert.equal(r.last4h!.change, 0);
  // market closed (weekend): the LTP is ignored, the last close and its time are shown
  const w = analyseCrude(bars(Array(60).fill(9000)) as any, { value: 9012, ts: lastEnd + 2 * 86400 });
  assert.equal(w.price, 9000); assert.equal(w.live, false); assert.equal(w.priceTs, lastEnd);
});

test("next-hour history needs 20 similar hours and uses only completed hours", () => {
  assert.equal(analyseCrude(bars(Array(60).fill(9000).map((x, i) => x + i)) as any).nextHour, null);
  // a steady up-trend: every 4-h move is up and every next hour is up
  const r = analyseCrude(bars(Array.from({ length: 12 * 80 }, (_, i) => 9000 + i)) as any);
  assert.ok(r.nextHour && r.nextHour.n >= 20);
  assert.equal(r.nextHour!.upPct, 100);
  assert.equal(r.nextHour!.baseUpPct, 100);
});

test("too few bars → unavailable", () => {
  assert.equal(analyseCrude(bars([9000, 9001]) as any).available, false);
});

test("brentStats: change vs previous close, 52-week range, YTD and 1M", async () => {
  const { brentStats } = await import("./crudeMove");
  const now = Date.parse("2026-10-25T10:00:00+05:30") / 1000, day = 86400;
  // daily closes: 2025-12-31 = 60, then rising 1 per day to 23 Oct 2026
  const start = Date.parse("2025-10-20T09:30:00+05:30") / 1000, daily = [] as any[];
  for (let t = start, v = 50; t <= now - 2 * day; t += day, v += 0.2) daily.push({ time: t, open: v, high: v + 1, low: v - 1, close: Math.round(v * 100) / 100, volume: 0 });
  const last = daily[daily.length - 1], s = brentStats(daily, last.close + 1, now);
  assert.equal(s.change, 1);
  assert.equal(s.prevClose, last.close);
  assert.ok(s.high52 >= last.close + 1 && s.low52 < 60);
  assert.ok(s.ytdPct! > 0 && s.m1Pct! > 0);
  assert.ok(s.spark.length >= 28 && s.spark.length <= 32);
});

test("brentStats: a price inside the last daily bar's session compares with the bar before (weekend case)", async () => {
  const { brentStats } = await import("./crudeMove");
  const thu = Date.parse("2026-10-22T04:00:00Z") / 1000, fri = thu + 86400, daily = [] as any[];
  for (let k = 40; k >= 2; k--) daily.push({ time: thu - k * 86400, open: 100, high: 101, low: 99, close: 100, volume: 0 });
  daily.push({ time: thu, open: 113, high: 114, low: 112, close: 113.17, volume: 0 }, { time: fri, open: 113, high: 113, low: 111, close: 111.7, volume: 0 });
  const s = brentStats(daily, 111.7, fri + 17 * 3600);           // Friday's last price, stamped Saturday 02:29 IST
  assert.equal(s.change, -1.47); assert.equal(s.prevClose, 113.17);
});
