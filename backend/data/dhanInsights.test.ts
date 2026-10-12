import { test } from "node:test";
import assert from "node:assert/strict";
import { compareIndicators } from "./dhanInsights";
import { ema, rsi, macd, atr } from "../indicators";

const bars = Array.from({ length: 120 }, (_, i) => { const c = 22000 + Math.sin(i / 7) * 40 + i; return { time: i * 300, open: c - 2, high: c + 6, low: c - 6, close: c, volume: 0 }; });
const last = (s: any[]) => s.filter((v) => v != null).pop();
const closes = bars.map((b) => b.close);

test("matching values pass; a real difference is flagged; missing Dhan value is not judged", () => {
  const dhan = { EMA: [{ period: 20, value: last(ema(closes, 20)) }, { period: 50, value: last(ema(closes, 50)) + 50 }], RSI: { value: last(rsi(closes, 14)) + 1 }, MACD_HIST: { value: last(macd(closes).histogram) }, ATR: null };
  const r = compareIndicators(bars as any, dhan);
  const by = Object.fromEntries(r.map((x) => [x.name, x]));
  assert.equal(by["EMA 20"].ok, true);
  assert.equal(by["EMA 50"].ok, false);          // 50 pts off > 0.05 % of price
  assert.equal(by["RSI 14"].ok, true);           // within 2
  assert.equal(by["MACD hist"].ok, true);
  assert.equal(by["ATR 14"].ok, null); assert.ok(by["ATR 14"].app != null && Math.abs(by["ATR 14"].app - last(atr(bars as any, 14))) < 0.01);
});
