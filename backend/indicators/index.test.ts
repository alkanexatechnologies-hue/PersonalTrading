import test from "node:test";
import assert from "node:assert/strict";
import { sma, ema, rsi, atr, macd, last } from "./index";
import { Candle } from "../types";

// These indicators feed every downstream signal, scalp, and paper-trade
// decision in the app. Nothing here was previously tested - an off-by-one in
// a smoothing window or seed value would have silently skewed every
// RSI/ATR/EMA value app-wide with no crash to catch it.

test("sma: matches hand-computed rolling average", () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out, [null, null, 2, 3, 4]);
});

test("ema: seeded with the first SMA, then rolls forward with k=2/(period+1)", () => {
  // Linear series [1,2,3,4,5], period 3: seed (SMA of first 3) = 2 at index 2.
  // k = 2/4 = 0.5. index 3: 4*0.5 + 2*0.5 = 3. index 4: 5*0.5 + 3*0.5 = 4.
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out, [null, null, 2, 3, 4]);
});

test("rsi: a strictly rising series has zero average loss -> RSI = 100", () => {
  const values = Array.from({ length: 16 }, (_, i) => i + 1); // 1..16, period 14
  const out = rsi(values, 14);
  assert.equal(out[14], 100);
});

test("rsi: a strictly falling series has zero average gain -> RSI = 0", () => {
  const values = Array.from({ length: 16 }, (_, i) => 16 - i); // 16..1, period 14
  const out = rsi(values, 14);
  assert.equal(out[14], 0);
});

function candle(time: number, high: number, low: number, close: number): Candle {
  return { time, open: close, high, low, close, volume: 0 } as Candle;
}

test("atr: a constant true-range series converges to that constant", () => {
  // Each bar: high = base+2, low = base, close = base+1, base rising by 1/bar.
  // TR works out to a constant 2 for every bar (see comment in the source
  // audit) - so ATR(14), which is a Wilder average of TR, should also be 2.
  const candles: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    const base = 10 + i;
    candles.push(candle(i, base + 2, base, base + 1));
  }
  const out = atr(candles, 14);
  assert.equal(last(out), 2);
});

test("atr: returns all-null when there aren't enough bars yet", () => {
  const candles: Candle[] = [candle(0, 12, 10, 11), candle(1, 13, 11, 12)];
  const out = atr(candles, 14);
  assert.ok(out.every((v) => v === null));
});

test("macd: a perfectly flat price series has zero macd/signal/histogram", () => {
  const values = new Array(40).fill(100);
  const { macd: macdLine, signal, histogram } = macd(values);
  assert.equal(last(macdLine), 0);
  assert.equal(last(signal), 0);
  assert.equal(last(histogram), 0);
});

test("last: returns the final non-null value, or null if the series is empty of data", () => {
  assert.equal(last([null, 1, 2, null]), 2);
  assert.equal(last([null, null]), null);
});
