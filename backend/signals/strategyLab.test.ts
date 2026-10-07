import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../types";
import { runLabStrategy, pdhPdlLevels, swingLevels, oiLevels, labConfigFor, liquidityMap } from "./strategyLab";

// 09:15 IST on 2026-10-07 in epoch seconds
const T0 = Date.UTC(2026, 9, 7, 3, 45) / 1000;
const bar = (k: number, o: number, h: number, l: number, c: number, day = 0): Candle => ({ time: T0 + day * 86400 + k * 300, open: o, high: h, low: l, close: c, volume: 1000 });

// previous day: range 100..120 → PDH 120, PDL 100
const prev: Candle[] = Array.from({ length: 70 }, (_, k) => bar(k, 110, k === 10 ? 120 : 112, k === 20 ? 100 : 108, 110, -1));
const hist = prev;

test("PDL reversal: wick into PDL, green close back above → CE that hits target", () => {
  const today: Candle[] = [];
  for (let k = 0; k < 6; k++) today.push(bar(k, 110, 111, 109, 110));          // 09:15–09:40 near 110
  today.push(bar(6, 108, 108.5, 104, 104.5));                                    // falls toward PDL
  today.push(bar(7, 104.5, 105, 99.5, 103.5));                                   // wicks PDL 100, closes back above, green? (open 104.5 > close) → no
  today.push(bar(8, 101, 104.8, 99.8, 104.2));                                   // wick to 99.8, green close 104.2 in upper half → signal
  today.push(bar(9, 104.2, 105.5, 103.9, 105.2));                                // breaks 104.8 → entry
  for (let k = 10; k < 30; k++) today.push(bar(k, 105 + (k - 10), 107 + (k - 10), 104.5 + (k - 10), 106.5 + (k - 10)));
  const lv = pdhPdlLevels(prev, today);
  assert.equal(lv.find((l) => l.name === "PDL")!.price, 100);
  const tr = runLabStrategy("PDH_PDL", hist, today, lv, today[today.length - 1].time + 300);
  assert.equal(tr.length, 1);
  assert.equal(tr[0].side, "CE");
  assert.equal(tr[0].signalTime, "10:00");
  assert.equal(tr[0].entry, 104.8);
  assert.equal(tr[0].status, "TARGET");
  assert.equal(tr[0].resultR, 2);   // PDH/PDL uses a 2R target
});

test("no look-ahead: as of the signal candle the trade is only WAITING", () => {
  const today: Candle[] = [];
  for (let k = 0; k < 6; k++) today.push(bar(k, 110, 111, 109, 110));
  today.push(bar(6, 108, 108.5, 104, 104.5));
  today.push(bar(7, 101, 104.8, 99.8, 104.2));
  today.push(bar(8, 104.2, 105.5, 103.9, 105.2));
  const tr = runLabStrategy("PDH_PDL", hist, today, pdhPdlLevels(prev, today), today[7].time + 300);
  assert.equal(tr.length, 1);
  assert.equal(tr[0].status, "WAITING");
  assert.equal(tr[0].entry, null);
});

test("swing levels become usable only after the confirming candles close", () => {
  const today: Candle[] = [bar(0, 10, 11, 9, 10), bar(1, 10, 12, 9, 11), bar(2, 11, 15, 10, 12), bar(3, 12, 13, 10, 11), bar(4, 11, 12, 9, 10), bar(5, 10, 11, 8, 9)];
  const sw = swingLevels([], today, 2).filter((l) => l.kind === "RESISTANCE");
  assert.equal(sw.length, 1);
  assert.equal(sw[0].price, 15);
  assert.equal(sw[0].from, today[4].time + 300);
});

test("PDH/PDL settings: until 14:30, wick up to 1 ATR, 2R; other strategies keep the defaults", () => {
  const p = labConfigFor("PDH_PDL"), sw = labConfigFor("SWING");
  assert.equal(p.lastSignalMin, 870); assert.equal(p.maxPierceAtr, 1); assert.equal(p.targetR, 2);
  assert.equal(sw.lastSignalMin, 840); assert.equal(sw.maxPierceAtr, 0.6); assert.equal(sw.targetR, 1.5);
});

test("OI levels: none without a snapshot", () => {
  assert.deepEqual(oiLevels(null, [bar(0, 1, 1, 1, 1)]), []);
  assert.equal(oiLevels({ support: 22000, resistance: 23000 }, [bar(0, 1, 1, 1, 1)]).length, 2);
});

test("liquidity map: PDL pre-identified as WAITING, then SWEPT after a close below, BROKEN after 2 closes", () => {
  const base: Candle[] = []; for (let k = 0; k < 6; k++) base.push(bar(k, 110, 111, 109, 110));
  const lv = pdhPdlLevels(prev, base).map((l) => ({ ...l, trades: true }));
  const st = (today: Candle[]) => liquidityMap("PDH_PDL", hist, today, lv, today[today.length - 1].time + 300, []).rows.find((r) => r.name === "PDL")!;
  const w = st(base);
  assert.equal(w.state, "WAITING"); assert.equal(w.distPts, 10); assert.match(w.plan, /BUY CE/);
  const swept = [...base, bar(6, 104, 104, 98, 99)];
  assert.equal(st(swept).state, "SWEPT");
  assert.equal(st([...swept, bar(7, 99, 99.5, 97, 98)]).state, "BROKEN");
  assert.equal(st([...swept, bar(7, 99, 103, 98.5, 102.5)]).state, "TESTED");
});
