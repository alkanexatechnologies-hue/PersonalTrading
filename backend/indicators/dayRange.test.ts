import test from "node:test";
import assert from "node:assert/strict";
import { todaysCandles, dayHighLow } from "./dayRange";
import { Candle } from "../types";

function candle(time: number, high: number, low: number): Candle {
  return { time, open: low, high, low, close: low, volume: 0 };
}

// 2026-01-01 00:00 UTC = 05:30 IST (still 2026-01-01 IST).
// 2026-01-01 20:00 UTC = 01:30 IST on 2026-01-02 - a different IST calendar day.
const DAY1_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000;
const DAY2_EPOCH = Date.UTC(2026, 0, 1, 20, 0, 0) / 1000;

test("todaysCandles: keeps only bars on the same IST calendar day as the last bar", () => {
  const candles = [candle(DAY1_EPOCH, 105, 95), candle(DAY1_EPOCH + 60, 106, 96), candle(DAY2_EPOCH, 110, 100)];
  const out = todaysCandles(candles);
  assert.equal(out.length, 1);
  assert.equal(out[0].time, DAY2_EPOCH);
});

test("dayHighLow: high/low computed only across today's bars, ignoring earlier days", () => {
  const candles = [candle(DAY1_EPOCH, 999, 1), candle(DAY2_EPOCH, 110, 100), candle(DAY2_EPOCH + 60, 115, 98)];
  const { high, low } = dayHighLow(candles);
  assert.equal(high, 115);
  assert.equal(low, 98);
});

test("dayHighLow: null/null on an empty candle list", () => {
  assert.deepEqual(dayHighLow([]), { high: null, low: null });
});
