import { test } from "node:test";
import assert from "node:assert/strict";
import { readCandle } from "./candleRead";
const k = (i: number, o: number, h: number, l: number, c: number) => ({ time: 1_790_000_000 + i * 900, open: o, high: h, low: l, close: c });

test("shapes: hammer, shooting star, doji, momentum", () => {
  assert.match(readCandle([k(0, 100, 101, 90, 100.5)], "15m")!.shape, /hammer/);
  assert.match(readCandle([k(0, 100, 110, 99, 99.5)], "15m")!.shape, /shooting star/);
  assert.match(readCandle([k(0, 100, 105, 95, 100.2)], "15m")!.shape, /doji/);
  assert.match(readCandle([k(0, 100, 110.2, 99.9, 110)], "15m")!.shape, /bullish momentum/);
});
test("two-candle patterns and where it formed", () => {
  const r = readCandle([k(0, 105, 106, 100, 101), k(1, 100.5, 108, 100, 107.5)], "15m", [{ price: 106, label: "PDH" }], 5)!;
  assert.equal(r.pattern, "BULLISH ENGULFING"); assert.equal(r.tone, "bull"); assert.match(r.text, /closed ABOVE PDH 106/);
  const rej = readCandle([k(0, 100, 101, 99, 100.5), k(1, 100.5, 104, 100, 101)], "5m", [{ price: 103, label: "R1" }], 4)!;
  assert.match(rej.text, /poked above R1 103 and closed back below/);
  assert.match(readCandle([k(0, 100, 110, 90, 105), k(1, 104, 108, 95, 101)], "15m")!.pattern!, /INSIDE BAR/);
});
