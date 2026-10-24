import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, indexExit, optionPnl, marketLevels, atr14, LAX, Bar, Level } from "./strategy";

// one session of 5-min candles starting 09:15 IST on 2026-10-05 (03:45 UTC); prefix of 20 flat history candles for ATR
const D0 = Date.UTC(2026, 9, 5, 3, 45) / 1000;
const hist: Bar[] = Array.from({ length: 20 }, (_, i) => ({ time: D0 - 86400 + i * 300, open: 100, high: 105, low: 95, close: 100 }));   // ATR = 10
const mk = (rows: [number, number, number, number][]): Bar[] => rows.map(([o, h, l, c], k) => ({ time: D0 + k * 300, open: o, high: h, low: l, close: c }));
const L: Level = { p: 110, kind: "ORH" };
const lv = () => [L];

test("ATR14 from true ranges", () => { assert.equal(atr14(hist, 19), 10); assert.equal(atr14(hist, 5), null); });

test("market levels: previous day + opening range only once 09:30 has passed", () => {
  const today = mk([[100, 112, 98, 104], [104, 110, 101, 109], [109, 111, 103, 108], [108, 109, 104, 106]]);
  assert.equal(marketLevels({ high: 120, low: 90, close: 100 }, today, 565).length, 3);
  const l = marketLevels({ high: 120, low: 90, close: 100 }, today, 570);
  assert.deepEqual(l.map((x) => x.kind), ["PDH", "PDL", "PDC", "ORH", "ORL"]);
  assert.equal(l.find((x) => x.kind === "ORH")!.p, 112);
});

test("accepted breakout at 09:30 → long signal with stop, room, target and reasons", () => {
  // 09:15 09:20 09:25 (OR) · 09:30 breakout close 112 (> 110 + 1) · 09:35 holds (low 109.5 > 109) close 114
  const today = mk([[100, 108, 99, 104], [104, 108, 100, 105], [105, 108, 101, 106], [106, 113, 105, 112], [112, 115, 109.5, 114], [114, 116, 113, 115]]);
  const all = [...hist, ...today], off = hist.length;
  const r = scan(all, off, today.length, () => [{ p: 110, kind: "PDH" }, { p: 160, kind: "PDC" }]);
  assert.equal(r.signals.length, 1);
  const s = r.signals[0];
  assert.equal(s.dir, 1); assert.equal(s.entry, 114); assert.equal(s.t, D0 + 5 * 300);
  assert.ok(Math.abs(s.stop - (105 - s.atr * 0.1)) < 1e-9, "stop = lower of breakout / acceptance lows − 0.1 ATR");
  assert.equal(s.room, 46); assert.equal(s.target, 114 + 45);
});

test("rejections: not accepted, stale entry, no room, chopped level, wide risk, outside the window", () => {
  const base = (accept: [number, number, number, number]) => [...hist, ...mk([[100, 108, 99, 104], [104, 108, 100, 105], [105, 108, 101, 106], [106, 113, 105, 112], accept, [114, 116, 113, 115]])];
  const run = (all: Bar[], levels: Level[], cfg = LAX) => scan(all, hist.length, all.length - hist.length, () => levels, cfg);
  assert.match(run(base([112, 113, 105, 108]), [L]).rejects[0].reason, /not accepted/);                         // next candle closes back below 110
  assert.match(run(base([112, 135, 111, 132]), [L]).rejects[0].reason, /stale/);                                // 22 pts consumed > 1 ATR
  assert.match(run(base([112, 115, 109.5, 114]), [L, { p: 125, kind: "PDH" }]).rejects[0].reason, /no room/);   // 11 pts to 125 < 20
  assert.match(run(base([112, 115, 109.5, 114]), [L], { ...LAX, maxRiskAtr: 0.5 }).rejects[0].reason, /risk/);
  // chop: the level was crossed twice before the breakout
  const chop = [...hist, ...mk([[100, 108, 99, 104], [104, 112, 100, 111], [111, 112, 100, 105], [105, 113, 104, 111], [111, 112, 100, 105], [105, 113, 105, 112], [112, 115, 109.5, 114], [114, 116, 113, 115]])];
  assert.match(run(chop, [L]).rejects.find((x) => /chop/.test(x.reason))!.reason, /crossed/);
  const late = { ...LAX, windowEnd: 560 }; assert.equal(run(base([112, 115, 109.5, 114]), [L], late).signals.length, 0);
});

test("one-sided signal is kept (a single candle cannot break above one level and below another, so same-candle conflicts cannot arise from one bar)", () => {
  const all = [...hist, ...mk([[100, 108, 99, 104], [104, 108, 100, 105], [105, 108, 101, 106], [106, 113, 105, 112], [112, 115, 109.5, 114], [114, 116, 113, 115]])];
  const r = scan(all, hist.length, 6, () => [{ p: 110, kind: "PDH" }, { p: 200, kind: "PDC" }], { ...LAX });
  assert.equal(r.signals.length, 1);   // sanity: one-sided case still trades
});

// ---- exits on 1-min closes ----
const sig = { i: 0, t: D0 + 3600, dir: 1 as const, level: { p: 100, kind: "PDH" }, entry: 105, stop: 98, risk: 7, room: 100, target: 150, consumed: 5, atr: 10, why: [] };
const path = (vals: number[]): [number, number][] => vals.map((p, k) => [sig.t + k * 60, p]);
const END = D0 + 6 * 3600;

test("exit: target, stop, thesis (5-min close back through the level), time", () => {
  assert.equal(indexExit(path([106, 120, 151]), sig, LAX, END).why, "TARGET");
  assert.equal(indexExit(path([104, 97]), sig, LAX, END).why, "STOP");
  const th = indexExit(path([104, 103, 102, 101, 99.5]), sig, LAX, END);   // the 5th minute closes the 5-min candle below 100
  assert.equal(th.why, "THESIS"); assert.equal(th.exitPx, 99.5);
  const flat = indexExit(path(Array(70).fill(106)), sig, LAX, END); assert.equal(flat.why, "TIME");
});

test("exit: after +15 the stop moves to entry + 2 from the NEXT minute (breakeven), never before", () => {
  const be = indexExit(path([110, 121, 106, 100.5]), sig, LAX, END);   // +16 at minute 2 → stop 107 → 106 stops out
  assert.equal(be.why, "BREAKEVEN"); assert.equal(be.exitPx, 106);
  assert.equal(indexExit(path([110, 106]), sig, LAX, END).why !== "BREAKEVEN", true);
});

test("reach is counted only before invalidation and independently of the exit", () => {
  const r = indexExit(path([110, 121, 126, 106, 136, 166]), sig, LAX, END);   // breakeven exit at 106, then +31 and +61 later
  assert.equal(r.reach[15], true); assert.equal(r.reach[20], true); assert.equal(r.reach[30], true); assert.equal(r.reach[60], true);
  const inv = indexExit(path([110, 97, 140]), sig, LAX, END);   // stop hit at 97 → later +35 does NOT count
  assert.equal(inv.reach[30], false); assert.equal(inv.reach[15], false);
});

test("option P&L: costs and the conservative extra", () => {
  const b = optionPnl(100, 120, 75), c = optionPnl(100, 120, 75, true);
  assert.equal(b.gross, 1500);
  assert.ok(Math.abs(b.net - ((20 - 0.5 - 0.5 - (0.12 + 0.088)) * 75 - 40)) < 1e-6);
  assert.ok(c.net < b.net);
});
