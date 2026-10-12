import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, summarize, monthChunks, DEFAULT, type Bar } from "./twentyPoints";

const T0 = Math.floor(Date.parse("2026-09-01T03:45:00Z") / 1000);   // 09:15 IST
// spot path: flat opening range 24000–24010, then a breakout up; CE 24050 premium rises 4/bar
function day(spotAfter: (i: number) => number, ceAfter: (i: number) => [number, number, number, number]): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < 30; i++) {
    const spot = i < 3 ? 24000 + i * 5 : spotAfter(i);
    const legs = new Map();
    const [o, h, l, c] = i < 3 ? [100, 101, 99, 100] : ceAfter(i);
    for (const k of [23900, 23950, 24000, 24050, 24100, 24150, 24200]) { legs.set(`${k}CE`, { o, h, l, c }); legs.set(`${k}PE`, { o: 100, h: 101, l: 99, c: 100 }); }
    bars.push({ t: T0 + i * 300, spot, legs });
  }
  return bars;
}

test("breakout entry fills at the NEXT bar's open; target hit gives +target minus costs", () => {
  const bars = day((i) => 24030 + i * 2, (i) => { const b = 100 + (i - 3) * 4; return [b, b + 25, b - 1, b + 3]; });
  const t = simulate(bars, { ...DEFAULT, useEmaFilter: false });
  assert.equal(t.length, 1);
  assert.equal(t[0].side, "CE"); assert.equal(t[0].why, "TARGET");
  assert.ok(t[0].entryT > t[0].signalT);                       // no look-ahead
  assert.equal(t[0].gross, 20); assert.equal(t[0].net, 20 - DEFAULT.costPts);
});

test("a bar touching both stop and target counts as a loss", () => {
  const bars = day((i) => 24030 + i * 2, () => [100, 130, 80, 100]);
  const t = simulate(bars, { ...DEFAULT, useEmaFilter: false });
  assert.equal(t[0].why, "STOP"); assert.equal(t[0].gross, -10);
});

test("time stop and no trade inside the opening range", () => {
  const flat = day(() => 24005, () => [100, 101, 99, 100]);
  assert.equal(simulate(flat, { ...DEFAULT, useEmaFilter: false }).length, 0);
  const slow = day((i) => 24030 + i, (i) => [100, 102, 98, 101]);
  const t = simulate(slow, { ...DEFAULT, useEmaFilter: false, maxTrades: 1 });
  assert.equal(t[0].why, "TIME"); assert.equal(t[0].gross, 1);
});

test("summary counts days, win rate and drawdown", () => {
  const s = summarize([{ day: "a", net: 17 } as any, { day: "b", net: -12 } as any, { day: "b", net: 20 } as any], 4);
  assert.equal(s.trades, 3); assert.equal(s.winRate, 66.67); assert.equal(s.daysPositive, 2); assert.equal(s.maxDrawdown, -12);
  assert.deepEqual(monthChunks("2026-09-15", "2026-10-12"), [["2026-09-15", "2026-09-30"], ["2026-10-01", "2026-10-12"]]);
});
