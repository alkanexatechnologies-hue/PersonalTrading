import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../types";
import { sessionsOf, buildLevels, analyseDay, aggregate, hms } from "./liquidityTake";

// One IST session of 5m candles from 09:15 following the given closes (small wicks).
function session(date: string, closes: number[], wick = 2): Candle[] {
  const t0 = Date.parse(`${date}T03:45:00Z`) / 1000;   // 09:15 IST
  let prev = closes[0];
  return closes.map((c, i) => { const o = prev; prev = c; return { time: t0 + i * 300, open: o, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick, close: c, volume: 1000 }; });
}
const flat = (date: string, p: number, n = 72) => session(date, Array(n).fill(p));
function days(...ss: Candle[][]) { const all = ss.flat(); const m = sessionsOf(all); return { m, d: [...m.keys()].sort() }; }

test("previous-day levels come from the previous session only", () => {
  const prev = session("2026-10-05", [100, 110, 95, 105]);
  const today = flat("2026-10-06", 104, 8);
  const lv = buildLevels([prev], today, today[today.length - 1].time + 300);
  const get = (t: string) => lv.find((l) => l.type === t || l.sources.some((s) => s.startsWith(t + ":")));
  assert.equal(get("Previous Day High")!.price, 112);   // 110 + wick
  assert.equal(get("Previous Day Low")!.price, 93);
  assert.equal(get("Previous Day Close")!.price, 105);
});

test("Today 15M levels exist only after 09:30 (no look-ahead)", () => {
  const prev = flat("2026-10-05", 100);
  const today = session("2026-10-06", [100, 103, 98, 101, 101]);
  const at925 = today[1].time + 300;                        // 09:25: only 2 closed candles
  assert.ok(!buildLevels([prev], today.filter((c) => c.time + 300 <= at925), at925).some((l) => l.sources.some((s) => s.startsWith("Today 15M"))));
  const at930 = today[2].time + 300;
  const lv = buildLevels([prev], today.filter((c) => c.time + 300 <= at930), at930);
  assert.ok(lv.some((l) => l.sources.some((s) => s.startsWith("Today 15M High"))));
});

// Previous day range 90-110 (PDL 88). Today drifts down from 104, sweeps below PDL at
// candle 12 and closes back above → a liquidity grab, then rallies.
function sweepDay(): { m: Map<string, Candle[]>; d: string[]; take: number } {
  const prev = session("2026-10-05", [100, 110, 90, 100]);
  const closes = [104, 104, 104, 104, 103, 102, 100, 98, 96, 94, 92, 90, 89, 92, 96, 99, 102, 104, 106, 108, 110, 110, 110, 110, 110, 110];
  const today = session("2026-10-06", closes);
  today[12] = { ...today[12], low: 85, close: 89.5 };     // wick 3 pts below PDL 88, close back above
  const { m, d } = days(prev, today);
  return { m, d, take: today[12].time + 300 };
}

test("liquidity taken is found on the take candle; the result does not change when future candles are removed", () => {
  const { m, d, take } = sweepDay();
  const full = analyseDay(d, m, 1, 5, take + 3600, null)!;
  const ev = full.events.find((e) => e.levelType === "Previous Day Low")!;
  assert.ok(ev, "PDL take recorded");
  assert.equal(ev.takenAt, take);
  assert.equal(ev.sweepSize, 3);
  // Truncate at the take candle: same take time/level, outcome still pending.
  const cut = new Map(m); cut.set(d[1], m.get(d[1])!.filter((c) => c.time + 300 <= take));
  const early = analyseDay(d, cut, 1, 5, take, null)!.events.find((e) => e.levelType === "Previous Day Low")!;
  assert.equal(early.takenAt, ev.takenAt);
  assert.equal(early.level, ev.level);
  assert.equal(early.outcome, "PENDING");
});

test("time to liquidity = last close farther than 1 ATR → take close", () => {
  const { m, d, take } = sweepDay();
  const ev = analyseDay(d, m, 1, 5, take + 3600, null)!.events.find((e) => e.levelType === "Previous Day Low")!;
  assert.ok(ev.timeToLiquiditySec > 0 && ev.timeToLiquiditySec % 300 === 0, String(ev.timeToLiquiditySec));
  assert.equal(ev.timeToLiquidity, hms(ev.timeToLiquiditySec));
  assert.match(ev.timeToLiquidity, /^\d\d:\d\d:\d\d$/);
});

test("sweep below a low that closes back and rallies ≥1 ATR → REVERSAL / Liquidity Grab + Rejection", () => {
  const { m, d, take } = sweepDay();
  const day = analyseDay(d, m, 1, 5, take + 3600, null)!;
  const ev = day.events.find((e) => e.levelType === "Previous Day Low")!;
  assert.equal(ev.outcome, "REVERSAL");
  assert.equal(ev.pattern, "Liquidity Grab + Rejection");
  assert.equal(ev.afterDirection, "UP");
  assert.ok((ev.pointsCaptured ?? 0) > 0);
  const tr = day.levels.find((t) => t.level.type === "Previous Day Low")!;
  assert.equal(tr.status, "REJECTED");
  // events newest first
  for (let i = 1; i < day.events.length; i++) assert.ok(day.events[i - 1].takenAt >= day.events[i].takenAt);
});

test("a gap through a previous-day level is INVALIDATED, not a liquidity take", () => {
  const prev = session("2026-10-05", [100, 110, 90, 100]);
  const today = flat("2026-10-06", 80, 20);                 // opens far below PDL 88
  const { m, d } = days(prev, today);
  const day = analyseDay(d, m, 1, 5, today[today.length - 1].time + 300, null)!;
  assert.equal(day.levels.find((t) => t.level.type === "Previous Day Low")!.status, "INVALIDATED");
  assert.ok(!day.events.some((e) => e.levelType === "Previous Day Low"));
});

test("15m aggregation aligns to 09:15", () => {
  const s = session("2026-10-06", [1, 2, 3, 4, 5, 6]);
  const a = aggregate(s, 3);
  assert.equal(a.length, 2);
  assert.equal(a[0].time, s[0].time);
  assert.equal(a[1].close, 6);
});
