import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRegime, completed, efficiencyRatio, adx, atr, vwapCrossings, missingCandles, baselineRegime, Candle, REGIME_DEFAULTS } from "./marketRegime";

// session helpers: day d (0 = first), candle k of the session (09:15 IST + k × tf)
const D0 = Date.UTC(2026, 9, 5, 3, 45) / 1000;   // Mon 5 Oct 2026 09:15 IST
const t = (d: number, k: number, tf: number) => D0 + d * 86400 + k * tf;
function series(days: number, tf: number, px: (i: number) => number, wig = 2): Candle[] {
  const per = tf === 900 ? 25 : 75, out: Candle[] = []; let i = 0;
  for (let d = 0; d < days; d++) for (let k = 0; k < per; k++, i++) { const p = px(i), q = px(i + 1); out.push({ time: t(d, k, tf), open: p, high: Math.max(p, q) + wig, low: Math.min(p, q) - wig, close: q }); }
  return out;
}
const now = (d: number, k5: number) => t(d, k5, 300);   // a moment on day d after k5 completed 5m candles

test("completed(): a forming 15m candle is never used", () => {
  const c = series(1, 900, (i) => 100 + i);
  assert.equal(completed(c, t(0, 3, 900) + 600, 900).length, 3, "the 4th candle (10:00–10:15) is still forming at 10:10");
  assert.equal(completed(c, t(0, 4, 900), 900).length, 4);
});

test("incomplete 15m candle does not change the regime until it closes", () => {
  const c15 = series(3, 900, (i) => 22000 + 8 * i), c5 = series(3, 300, (i) => 22000 + (8 / 3) * i);
  const at = (s: number) => classifyRegime(c15, c5, s, null);
  const mid = t(2, 10, 900) + 7 * 60;   // 7 minutes into a 15m candle
  const spike = c15.map((c) => (c.time === t(2, 10, 900) ? { ...c, high: c.high + 5000, close: c.close - 3000 } : c));   // the forming candle goes wild
  assert.deepEqual(classifyRegime(spike, c5, mid, null).features, at(mid).features);
});

test("UNKNOWN_DATA: too few candles, missing candles, flat prices, invalid prices", () => {
  const short15 = series(1, 900, (i) => 100 + i), c5 = series(1, 300, (i) => 100 + i / 3);
  assert.equal(classifyRegime(short15, c5, now(0, 70), null).regime, "UNKNOWN_DATA");
  const c15 = series(3, 900, (i) => 22000 + 5 * i), c5b = series(3, 300, (i) => 22000 + (5 / 3) * i);
  const holes = c15.filter((c, j) => !(j > c15.length - 12 && j % 2 === 0));   // drop every other recent 15m candle
  assert.equal(missingCandles(holes.slice(-29), 900) > 2, true);
  assert.match(classifyRegime(holes, c5b, now(2, 74), null).reasons[0], /missing 15m/);
  const flat15 = series(3, 900, () => 22000, 0), flat5 = series(3, 300, () => 22000, 0);
  const r = classifyRegime(flat15, flat5, now(2, 74), null);
  assert.equal(r.regime, "UNKNOWN_DATA"); assert.match(r.reasons[0], /flat prices/);
  const bad = c15.map((c, j) => (j === c15.length - 3 ? { ...c, close: NaN } : c));
  assert.match(classifyRegime(bad, c5b, now(2, 74), null).reasons[0], /invalid/);
  const fewToday = classifyRegime(c15, c5b, now(2, 3), null);
  assert.equal(fewToday.regime, "UNKNOWN_DATA"); assert.match(fewToday.reasons[0], /5m candles today/);
});

test("efficiency ratio: 1 on a straight line, ~0 on a zig-zag, 0 on flat", () => {
  assert.equal(efficiencyRatio([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 1);
  assert.ok(efficiencyRatio([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1])! < 0.05);
  assert.equal(efficiencyRatio(Array(11).fill(5)), 0);
  assert.equal(efficiencyRatio([1, 2, 3]), null);
});

test("ADX: strong in a steady trend (+DI on top going up), weak in a zig-zag", () => {
  const up = series(3, 900, (i) => 22000 + 10 * i), zz = series(3, 900, (i) => 22000 + (i % 2 ? 15 : -15));
  const a = adx(up)!, z = adx(zz)!;
  assert.ok(a.adx > 40 && a.plusDI > a.minusDI, JSON.stringify(a));
  assert.ok(z.adx < 20, JSON.stringify(z));
  assert.equal(adx(up.slice(0, 20)), null);
});

test("sudden gap: the true range includes the gap and classification still works", () => {
  const c15 = series(3, 900, (i) => 22000 + 4 * i).map((c) => (c.time >= t(2, 0, 900) ? { ...c, open: c.open + 300, high: c.high + 300, low: c.low + 300, close: c.close + 300 } : c));
  const c5 = series(3, 300, (i) => 22000 + (4 / 3) * i).map((c) => (c.time >= t(2, 0, 300) ? { ...c, open: c.open + 300, high: c.high + 300, low: c.low + 300, close: c.close + 300 } : c));
  const at = t(2, 3, 900), before = atr(completed(c15, t(1, 24, 900), 900))!, after = atr(completed(c15, at, 900))!;
  assert.ok(after > before * 2, `ATR ${before.toFixed(1)} → ${after.toFixed(1)} should include the 300-point gap`);
  const r = classifyRegime(c15, c5, t(2, 9, 300) + 1, null);
  assert.notEqual(r.regime, undefined); assert.ok(r.features.atr15! > 0);
});

test("VWAP crossings: counts sign changes of close − VWAP over the last 12 candles (TWAP when no volume)", () => {
  const mk = (cl: number[]) => cl.map((c, k) => ({ time: t(0, k, 300), open: c, high: c + 1, low: c - 1, close: c }));
  assert.equal(vwapCrossings(mk([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111])), 0, "steady rise stays above VWAP");
  assert.ok((vwapCrossings(mk([100, 110, 90, 110, 90, 110, 90, 110, 90, 110, 90, 110])) ?? 0) >= 8, "whipsaw crosses repeatedly");
  const withVol = [{ time: t(0, 0, 300), open: 100, high: 100, low: 100, close: 100, volume: 1000 }, { time: t(0, 1, 300), open: 120, high: 120, low: 120, close: 120, volume: 1 }, { time: t(0, 2, 300), open: 105, high: 105, low: 105, close: 105, volume: 1 }];
  assert.equal(vwapCrossings(withVol), 0, "volume-weighted VWAP stays near 100, so 120 → 105 stays above it");
  assert.equal(vwapCrossings([]), null);
});

test("classification: steady rise → TRENDING_UP, steady fall → TRENDING_DOWN, whipsaw → CHOPPY", () => {
  const up15 = series(3, 900, (i) => 22000 + 12 * i, 3), up5 = series(3, 300, (i) => 22000 + 4 * i, 1);
  assert.equal(classifyRegime(up15, up5, now(2, 40), null).regime, "TRENDING_UP");
  const dn15 = series(3, 900, (i) => 23000 - 12 * i, 3), dn5 = series(3, 300, (i) => 23000 - 4 * i, 1);
  assert.equal(classifyRegime(dn15, dn5, now(2, 40), null).regime, "TRENDING_DOWN");
  const zz15 = series(3, 900, (i) => 22000 + (i % 2 ? 40 : -40), 5), zz5 = series(3, 300, (i) => 22000 + (i % 2 ? 20 : -20), 3);
  const c = classifyRegime(zz15, zz5, now(2, 40), null);
  assert.equal(c.regime, "CHOPPY"); assert.match(c.guidance, /^WAIT/);
});

test("compression is a state, never a breakout call", () => {
  const c15 = series(3, 900, (i) => (i < 50 ? 22000 + (i % 2 ? 60 : -60) : 22000 + (i % 2 ? 3 : -3)), 2), c5 = series(3, 300, (i) => 22000 + (i % 2 ? 1 : -1), 1);
  const r = classifyRegime(c15, c5, now(2, 70), null);
  assert.equal(r.regime, "COMPRESSION"); assert.match(r.guidance, /no breakout is predicted/);
});

test("premium disagreement turns a spot trend into TRANSITION; missing premium data is ignored", () => {
  const up15 = series(3, 900, (i) => 22000 + 12 * i, 3), up5 = series(3, 300, (i) => 22000 + 4 * i, 1), at = now(2, 40);
  assert.equal(classifyRegime(up15, up5, at, { ce: [100, 98, 96, 94], pe: [80, 82, 84, 86] }).regime, "TRANSITION");
  assert.equal(classifyRegime(up15, up5, at, { ce: [100, 102, 104, 106], pe: [80, 78, 76, 74] }).regime, "TRENDING_UP");
  assert.equal(classifyRegime(up15, up5, at, { ce: [null, null, null, null], pe: [80, 78, 76, 74] }).regime, "TRENDING_UP");
  assert.equal(classifyRegime(up15, up5, at, { ce: [100, 98, 96, 94], pe: [80, 82, 84, 86] }, { ...REGIME_DEFAULTS, usePremium: false }).regime, "TRENDING_UP");
});

test("baseline regime: close vs EMA21 and its direction", () => {
  assert.equal(baselineRegime(series(3, 900, (i) => 22000 + 10 * i), now(2, 40)), "TRENDING_UP");
  assert.equal(baselineRegime(series(3, 900, (i) => 22000 - 10 * i), now(2, 40)), "TRENDING_DOWN");
  assert.equal(baselineRegime(series(1, 900, (i) => 22000 + i), now(0, 30)), "UNKNOWN_DATA");
});
