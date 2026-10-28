import { test } from "node:test";
import assert from "node:assert/strict";
import { levelTest, sim, gapKey, computeStats, Mins, Sess } from "./scenarioStats";
import { buildScenarioMap, maxPainOf, scnSessions, verdict } from "./scenarioMap";
import STATS from "./scenario-stats.json";

const t0 = Date.parse("2026-10-28T09:15:00+05:30") / 1000;
const path = (pts: number[]): Mins => pts.map((p, i) => [t0 + i * 60, p]);
const lin = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / Math.max(1, n - 1));

test("1:2 simulator and gap buckets", () => {
  assert.deepEqual(sim(path([100, 110, 141]), 0, 1, 1), { res: "WIN", pts: 40 });
  assert.deepEqual(sim(path([100, 90, 79]), 0, 1, 1), { res: "LOSS", pts: -20 });
  assert.equal(gapKey(-75), "DOWN"); assert.equal(gapKey(-101), "BIG_DOWN"); assert.equal(gapKey(30), "FLAT"); assert.equal(gapKey(80), "UP");
});

test("level test: a sweep below support that closes back and runs 40 = hold + sweep + a winning defend trade", () => {
  // support 1000: falls to 990 (pierce 10) within the 15-min bar, back above by the 5-min close, then +45
  const m = path([...lin(1030, 1001, 20), ...lin(998, 990, 5), ...lin(992, 1002, 5), ...lin(1003, 1045, 30), ...lin(1045, 1045, 300)]);
  const o = levelTest(m, 1000, 1, 1)!;
  assert.equal(o.hold, true); assert.equal(o.sweep, true); assert.equal(o.brk, false); assert.equal(o.defend?.res, "WIN");
  // a clean break: 15-min close well below, then −40
  const b = levelTest(path([...lin(1030, 1000, 20), ...lin(999, 950, 60), ...lin(950, 950, 300)]), 1000, 1, 1)!;
  assert.equal(b.hold, false); assert.equal(b.brk, true); assert.equal(b.breakTrade?.res, "WIN");
});

test("computeStats on synthetic sessions gives every gap bucket and level key", () => {
  const ss: Sess[] = Array.from({ length: 12 }, (_, d) => ({ day: `2026-01-${String(d + 1).padStart(2, "0")}`, m: path(lin(1000 + d * 10, 1000 + d * 10 + (d % 2 ? 60 : -60), 375)).map(([t, p]) => [t + d * 86400, p] as [number, number]) }));
  const s = computeStats(ss, 1);
  assert.deepEqual(Object.keys(s.gaps), ["BIG_DOWN", "DOWN", "FLAT", "UP", "BIG_UP"]);
  assert.ok(s.gaps.FLAT.n > 0); assert.ok(Object.keys(s.levels).length > 0 && Object.values(s.levels).every((l) => l.n > 0));
});

test("verdict: GOOD only when both halves make money", () => {
  const T = (n: number, a: number) => ({ n, win: 0, loss: 0, time: 0, winPct: 0, avgPts: a });
  assert.equal(verdict(T(10, 5), T(10, 3)).v, "GOOD"); assert.equal(verdict(T(10, 5), T(10, -1)).v, "MIXED");
  assert.equal(verdict(T(10, -2), T(10, -1)).v, "AVOID"); assert.equal(verdict(T(3, 9), T(10, 9)).v, "MIXED");
});

test("max pain and the session the map is for", () => {
  assert.equal(maxPainOf([{ strike: 100, ceOi: 10, peOi: 50 }, { strike: 110, ceOi: 20, peOi: 40 }, { strike: 120, ceOi: 30, peOi: 30 }, { strike: 130, ceOi: 40, peOi: 20 }, { strike: 140, ceOi: 50, peOi: 10 }]), 120);
  const bar = (d: string, hm: string, p: number) => ({ time: Date.parse(`${d}T${hm}:00+05:30`) / 1000, open: p, high: p + 5, low: p - 5, close: p });
  const bars = [bar("2026-10-27", "09:15", 100), bar("2026-10-27", "15:15", 110), bar("2026-10-28", "09:15", 120), bar("2026-10-28", "15:15", 130)];
  const after = scnSessions(bars, Date.parse("2026-10-28T16:00:00+05:30") / 1000)!;
  assert.equal(after.base.day, "2026-10-28"); assert.equal(after.base.close, 130); assert.equal(after.targetDay, "2026-10-29"); assert.equal(after.live, false);
  const during = scnSessions(bars, Date.parse("2026-10-28T11:00:00+05:30") / 1000)!;
  assert.equal(during.base.day, "2026-10-27"); assert.equal(during.targetDay, "2026-10-28"); assert.equal(during.targetIsToday, true);
  const fri = scnSessions([bar("2026-10-30", "09:15", 100)], Date.parse("2026-10-30T18:00:00+05:30") / 1000)!;
  assert.equal(fri.targetDay, "2026-11-02");   // Friday → Monday
});

test("map: 5 scenarios with branches, 1:2 trades and Hindi stories (NIFTY, 28 Oct)", () => {
  const S: any = STATS;
  const m = buildScenarioMap({ index: "NIFTY", step: 50, base: { day: "2026-10-28", open: 22678, high: 22778.05, low: 22497.7, close: 22698.85 },
    prior: [{ day: "2026-10-27", open: 22708.8, high: 22829.75, low: 22636.85, close: 22749.75 }], spot: 22698.85, callWall: 22700, putWall: 22600, maxPain: 22650,
    targetDay: "2026-10-29", targetIsToday: false, stats: { all: S.indices.NIFTY, dev: S.split.NIFTY.dev, val: S.split.NIFTY.val } });
  assert.deepEqual(m.scenarios.map((s) => s.id), ["GAP_DOWN", "GAP_UP", "FALL", "RISE", "SWEEP"]);
  const gd = m.scenarios[0];
  assert.equal(gd.open, 22698.85 - 75); assert.equal(gd.branches.length, 3); assert.ok(gd.story[0].includes("22,624"));
  for (const t of m.scenarios.flatMap((s) => s.trades)) { const dir = t.side === "CE" ? 1 : -1; assert.equal(Math.round(dir * (t.target - t.entry)), 40); assert.equal(Math.round(dir * (t.entry - t.stop)), 20); }
  const fall = m.scenarios[2]; assert.ok(fall.levels.every((l) => l.price < 22698.85)); assert.ok(fall.branches[0].path.every((w) => w.m >= 555 && w.m <= 930));
  assert.ok(m.levels.some((l) => l.key === "MAX_PAIN") && m.levels.some((l) => l.key === "PDL" && l.price === 22497.7));
});
