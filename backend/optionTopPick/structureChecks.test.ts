import { test } from "node:test";
import assert from "node:assert/strict";
import { Candle } from "../types";
import { computeEmaStructure, computeVwapStatus } from "./structureChecks";

function makeTrend(n: number, startPrice: number, stepPct: number): Candle[] {
  const out: Candle[] = [];
  let price = startPrice;
  const t0 = Math.floor(Date.UTC(2026, 8, 15, 4, 0, 0) / 1000); // 09:30 IST
  for (let i = 0; i < n; i++) {
    const open = price;
    price = price * (1 + stepPct);
    out.push({ time: t0 + i * 300, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: 1000 });
  }
  return out;
}

function makeZigzag(n: number, base: number, amp: number): Candle[] {
  const out: Candle[] = [];
  const t0 = Math.floor(Date.UTC(2026, 8, 15, 4, 0, 0) / 1000);
  for (let i = 0; i < n; i++) {
    const close = base + (i % 2 === 0 ? amp : -amp);
    out.push({ time: t0 + i * 300, open: base, high: Math.max(base, close), low: Math.min(base, close), close, volume: 1000 });
  }
  return out;
}

test("computeEmaStructure: Spot > EMA9 > EMA21 > EMA50 -> Strong Bullish", () => {
  assert.equal(computeEmaStructure(110, 108, 105, 100), "Strong Bullish");
});

test("computeEmaStructure: Spot < EMA9 < EMA21 < EMA50 -> Strong Bearish", () => {
  assert.equal(computeEmaStructure(90, 92, 95, 100), "Strong Bearish");
});

test("computeEmaStructure: any conflicting order is Mixed, never forced to a side", () => {
  assert.equal(computeEmaStructure(105, 108, 100, 102), "Mixed");
});

test("computeVwapStatus: a sustained uptrend sits above a rising VWAP", () => {
  const candles = makeTrend(60, 100, 0.003);
  const r = computeVwapStatus(candles);
  assert.equal(r.status, "Above+Rising");
});

test("computeVwapStatus: a sustained downtrend sits below a falling VWAP", () => {
  const candles = makeTrend(60, 100, -0.003);
  const r = computeVwapStatus(candles);
  assert.equal(r.status, "Below+Falling");
});

test("computeVwapStatus: repeated whipsaws across VWAP are classified Choppy, not a false directional read", () => {
  const candles = makeZigzag(20, 100, 2);
  const r = computeVwapStatus(candles);
  assert.equal(r.status, "Choppy");
});
