import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { isPaperSignal, toSignal, scoreBoard, paperHtml, GridEvent, PaperSignal, PAPER_START } from "./fakeUpPaperCore";
import { score1to1, run } from "./fakeMoveGrid";
import { RAW_DIRS } from "./dataRange";

// 2026-10-26 09:55 IST = 04:25 UTC
const T0 = Date.UTC(2026, 9, 26, 4, 25) / 1000;
const ev = (o: Partial<GridEvent> = {}): GridEvent => ({
  day: "2026-10-26", src: "OWNER", dir: -1, t: T0, lvl: 23053.4, px: 23030.95, stop: 23117.2, atr: 40, atm: 23050,
  premIn: 169.75, p0: 36.44, f: { write: true, retest: true }, r0: { win: true, loss: false, r: 1 }, ...o,
});
const sig = (o: Partial<PaperSignal> = {}): PaperSignal => ({ ...toSignal("NIFTY", ev()), ...o });

// ---- the rule ----
test("rule: owner-level fake-up with call writing and an earlier touch is a paper signal", () => {
  assert.equal(isPaperSignal(ev()), true);
});
test("rule: each condition is required", () => {
  assert.equal(isPaperSignal(ev({ dir: 1 })), false, "fake-down is not the rule");
  assert.equal(isPaperSignal(ev({ src: "LIVE" })), false, "screen levels are not the rule");
  assert.equal(isPaperSignal(ev({ f: { write: false, retest: true } })), false, "needs call writing");
  assert.equal(isPaperSignal(ev({ f: { write: true, retest: false } })), false, "needs the earlier touch");
  assert.equal(isPaperSignal(ev({ r0: null })), false, "needs a scored entry");
});
test("rule: nothing before the paper start counts (backtest days are not paper evidence)", () => {
  assert.equal(PAPER_START, "2026-10-26");
  assert.equal(isPaperSignal(ev({ day: "2026-10-23" })), false);
  assert.equal(isPaperSignal(ev({ day: "2026-10-23" }), "2026-09-01"), true);
});

// ---- signal layout ----
test("signal: IST time, 1:1 stop/target around the entry, PE strike, rounded premium %", () => {
  const s = toSignal("NIFTY", ev());
  assert.equal(s.time, "09:55");
  assert.equal(s.level, 23053);
  assert.equal(s.stop, 23117.2);
  assert.equal(s.target, 22944.7);
  assert.equal(Math.round((s.stop - s.entry) * 100), Math.round((s.entry - s.target) * 100), "1:1");
  assert.equal(s.strike, "23050 PE");
  assert.equal(s.premPct, 36.4);
  assert.equal(s.result, "TARGET");
});
test("signal: a tiny stop is floored at 0.25 × ATR, as the backtest scores it", () => {
  const s = toSignal("NIFTY", ev({ stop: 23032, atr: 40 }));   // 1.05 pts < 10 pts floor
  assert.equal(s.stop, 23040.95);
  assert.equal(s.target, 23020.95);
});
test("signal: results map to TARGET / STOP / TIME", () => {
  assert.equal(toSignal("NIFTY", ev({ r0: { win: false, loss: true, r: -1 } })).result, "STOP");
  assert.equal(toSignal("NIFTY", ev({ r0: { win: false, loss: false, r: -0.24 } })).result, "TIME");
});

// ---- 1:1 scorer shared with the backtest ----
test("score1to1 (fake-up = short): target first → win, stop first → loss, neither → time scored in R", () => {
  const win = score1to1([[1, 101], [2, 95], [3, 89]], 100, 110, -1, 20);
  assert.deepEqual([win.win, win.loss, win.r, win.tOut], [true, false, 1, 3]);
  const loss = score1to1([[1, 104], [2, 110.5]], 100, 110, -1, 20);
  assert.deepEqual([loss.win, loss.loss, loss.r, loss.tOut], [false, true, -1, 2]);
  const time = score1to1([[1, 103], [2, 95]], 100, 110, -1, 20);
  assert.deepEqual([time.win, time.loss, time.r], [false, false, 0.5]);
});
test("score1to1: stop distance floored at 0.25 ATR", () => {
  const r = score1to1([[1, 104.9], [2, 95.1]], 100, 100.5, -1, 20);   // floor 5 pts → stop 105, target 95
  assert.equal(r.loss, false); assert.equal(r.win, false); assert.equal(r.stopPts, 0.25);
});

// ---- scoreboard ----
test("scoreboard: accuracy = targets ÷ (targets + stops); time exits only in avg R", () => {
  const b = scoreBoard([sig(), sig({ result: "TARGET", r: 1 }), sig({ result: "STOP", r: -1, premPct: -20 }), sig({ result: "TIME", r: -0.2, premPct: null })]);
  assert.deepEqual([b.n, b.target, b.stop, b.time, b.accuracy], [4, 2, 1, 1, 67]);
  assert.equal(b.avgR, 0.2);
  assert.equal(b.avgPremPct, 17.6);   // (36.4 + 36.4 − 20) / 3
});
test("scoreboard: empty and all-time cases do not divide by zero", () => {
  assert.deepEqual(scoreBoard([]), { n: 0, target: 0, stop: 0, time: 0, accuracy: null, avgR: null, avgPremPct: null });
  assert.equal(scoreBoard([sig({ result: "TIME", r: 0 })]).accuracy, null);
});

// ---- Telegram note ----
test("note: says paper only, lists today's signal with SL / target / result, and counts to the verdict", () => {
  const h = paperHtml("2026-10-26", [sig()]);
  assert.match(h, /Paper only, not a trade/);
  assert.match(h, /NIFTY 09:55 · failed breakout at 23053 · BUY 23050 PE @ 169.75/);
  assert.match(h, /SL 23117.2 T 22944.7 → ✅ TARGET \(\+1R, premium \+36.4%\)/);
  assert.match(h, /29 more to the verdict/);
  assert.match(h, /SENSEX: no signals yet/);
});
test("note: a day without a signal still shows the scoreboard", () => {
  const h = paperHtml("2026-10-27", [sig()]);
  assert.match(h, /Today: no signal/);
  assert.match(h, /NIFTY: 1 signals · 1 target/);
});
test("note: at 30 signals it says the rule is ready for the verdict", () => {
  assert.match(paperHtml("2026-10-26", Array.from({ length: 30 }, () => sig())), /ready for ProTrader's verdict/);
});

// ---- the real replay (needs the research data; skipped where data/ is absent) ----
const hasData = fs.existsSync(RAW_DIRS.NIFTY) && fs.readdirSync(RAW_DIRS.NIFTY).some((f) => f.startsWith("2026-10"));
test("replay: reproduces the 21 Oct NIFTY 09:55 signal, and later days do not change it (no look-ahead)", { skip: !hasData && "no research data" }, async () => {
  const { assemble } = await import("../nifty20/data");
  // raw files are month chunks named <from>_<latest download>: load up to the latest downloaded day, then cut by day
  const { latestRawDay } = await import("./dataRange");
  const days = assemble("2026-09-01", latestRawDay()).days.filter((d) => d.day <= "2026-10-23");
  const find = (to: string) => run(days.filter((d) => d.day <= to), 5, 50).ev.filter((e: any) => isPaperSignal(e, "2026-10-21") && e.day === "2026-10-21").map((e: any) => toSignal("NIFTY", e));
  const upTo21 = find("2026-10-21"), upTo23 = find("2026-10-23");
  assert.ok(upTo21.some((s) => s.time === "09:55" && s.level === 23053 && s.strike === "23050 PE"), "the 09:55 signal");
  assert.deepEqual(upTo21, upTo23, "data after the day must not change the day's signals");
});
void path;
