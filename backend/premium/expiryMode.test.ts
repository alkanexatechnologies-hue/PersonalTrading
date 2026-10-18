import { test } from "node:test";
import assert from "node:assert/strict";
import { expirySignal, itmStrike, stepExpiryTrade, expiryEntryMsg, ExpTrade } from "./expiryMode";

const T0 = 1_792_034_100;   // 08:45 IST
const bar = (k: number, o: number, h: number, l: number, c: number) => ({ time: T0 + k * 300, open: o, high: h, low: l, close: c });

test("expiry signal: trend-up pullback to the rising EMA20 that closes above it → CE; time window and trend respected", () => {
  const bars = Array.from({ length: 30 }, (_, k) => bar(k, 100 + k, 101 + k, 99 + k, 100.5 + k));
  const ema = bars.map((_, k) => (k < 19 ? null : 95 + k));          // rising, below price
  bars[29] = bar(29, 126, 127, 123.5, 126.5);                          // 11:10 candle dips to 123.5 (EMA 124 + 0.15·ATR) and closes above
  const s = expirySignal(bars, ema, 100, 20)!;
  assert.equal(s.side, "CE");
  assert.equal(expirySignal(bars, ema, 130, 20), null);                // price below the day's open: no up-trend
  const early = bars.slice(0, 22); assert.equal(expirySignal(early, ema.slice(0, 22), 100, 20), null);   // 11:05 is in the window, but no dip → null
  assert.equal(itmStrike(23146, 50, "CE"), 23100); assert.equal(itmStrike(23146, 50, "PE"), 23200);
});
test("expiry trade: −40% premium stop · half at 1.5× then breakeven · 2.5× · 40-min time stop · 15:15", () => {
  const mk = (): ExpTrade => ({ index: "^NSEI", name: "NIFTY 50", side: "CE", strike: 23100, openedAt: T0 + 3 * 3600, entrySpot: 23146, entryPrem: 100, state: "OPEN" });
  let t = mk(); assert.match(stepExpiryTrade(t, 59, t.openedAt + 60)[0], /PREMIUM STOP −40%/); assert.equal(t.state, "CLOSED");
  t = mk(); assert.match(stepExpiryTrade(t, 151, t.openedAt + 60)[0], /1\.5× HIT/); assert.equal(t.state, "HALF");
  assert.match(stepExpiryTrade(t, 99, t.openedAt + 120)[0], /BACK TO ENTRY/); assert.equal(t.exitWhy, "BREAKEVEN after 1.5×");
  t = mk(); stepExpiryTrade(t, 160, t.openedAt + 60); assert.match(stepExpiryTrade(t, 260, t.openedAt + 120)[0], /2\.5× HIT/);
  t = mk(); assert.deepEqual(stepExpiryTrade(t, 110, t.openedAt + 39 * 60), []); assert.match(stepExpiryTrade(t, 110, t.openedAt + 40 * 60)[0], /40-MIN TIME STOP/);
  t = mk(); assert.match(stepExpiryTrade(t, 120, T0 + 6.5 * 3600)[0], /OUT AT 15:15/);   // 15:15 IST
  const m = expiryEntryMsg(mk(), { side: "CE", bar: bar(29, 1, 1, 1, 1), ema: 124 }, 1);
  assert.match(m, /EXPIRY MODE · PAPER \/ MIN SIZE/); assert.match(m, /Stop Loss: premium ₹60 \(−40%\)/); assert.match(m, /Target 1: ₹150 \(1\.5×\)/); assert.match(m, /NOT validated/);
});
