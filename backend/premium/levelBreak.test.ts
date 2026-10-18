import { test } from "node:test";
import assert from "node:assert/strict";
import { candleGrade, detectBreaks, breakOutcome, breakAlertMsg } from "./levelBreak";

const b = (i: number, o: number, h: number, l: number, c: number) => ({ time: 1_792_036_800 + i * 900, open: o, high: h, low: l, close: c });

test("candle grade: strong / normal / weak for the break direction", () => {
  assert.equal(candleGrade(b(0, 100, 121, 99, 120), 25, "UP").grade, "STRONG");
  assert.equal(candleGrade(b(0, 100, 121, 99, 120), 25, "DOWN").grade, "WEAK");
  assert.equal(candleGrade(b(0, 100, 120, 95, 104), 25, "UP").grade, "WEAK");    // small body
  assert.equal(candleGrade(b(0, 100, 112, 98, 110), 25, "UP").grade, "NORMAL");  // good body, but range < 0.7 ATR
});
test("detect breaks: first close through a level from the other side, once per level and direction", () => {
  const bars = [b(0, 95, 99, 94, 98), b(1, 98, 106, 97, 105), b(2, 105, 107, 99, 100), b(3, 100, 108, 99, 107), b(4, 107, 108, 92, 93)];
  const ev = detectBreaks(bars, [{ price: 100, label: "PDH", kind: "PREV DAY" }, { price: 95, label: "S1", kind: "PIVOT" }], 10);
  assert.deepEqual(ev.map((e) => `${e.dir} ${e.level.label} @${e.index}`), ["UP PDH @1", "DOWN PDH @4", "DOWN S1 @4"]);
});
test("outcome: follow-through vs failed, and the alert text", () => {
  const bars = [b(0, 95, 99, 94, 98), b(1, 98, 106, 97, 105), b(2, 105, 117, 104, 116), b(3, 116, 118, 99, 99)];
  assert.equal(breakOutcome(bars, 1, 100, "UP", 10, 8).res, "FOLLOW-THROUGH");
  assert.equal(breakOutcome([...bars.slice(0, 2), b(2, 105, 106, 98, 99)], 1, 100, "UP", 10, 8).res, "FAILED");
  const ev = detectBreaks(bars.slice(0, 2), [{ price: 100, label: "Prev day high", kind: "PREV DAY" }], 10)[0];
  const m = breakAlertMsg("NIFTY 50", "15m", ev, 15, { n: 40, ft: 22, failed: 12 }, { price: 110, label: "R1 pivot", kind: "PIVOT" });
  assert.match(m, /NIFTY · 15-MIN BREAKOUT<\/b> · 09:45–10:00/);
  assert.match(m, /Closed <b>105<\/b> above resistance <b>100<\/b> <i>Prev day high<\/i>/);
  assert.match(m, /followed through <b>22\/40 \(55%\)<\/b>/); assert.match(m, /Next resistance: <b>110<\/b>/);
  assert.match(breakAlertMsg("SENSEX", "5m", ev, 5, { n: 4, ft: 1, failed: 2 }, null), /only 4 past cases/);
});
