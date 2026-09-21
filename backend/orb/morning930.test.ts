import { test } from "node:test";
import assert from "node:assert/strict";
import { Candle, OiAnalysis } from "../types";
import { SymbolDef } from "../config";
import { evaluateMorning930 } from "./morning930";

const nifty: SymbolDef = {
  symbol: "^NSEI", name: "NIFTY 50", type: "index", fno: true, lotSize: 65, strikeStep: 50, nseSymbol: "NIFTY", isIndex: true,
};
const stock: SymbolDef = {
  symbol: "RELIANCE.NS", name: "Reliance", type: "equity", fno: true, lotSize: 500, strikeStep: 20, nseSymbol: "RELIANCE",
};

/** IST clock on 16 Sep 2026 → epoch seconds. */
function istEpoch(h: number, m: number): number {
  return Math.floor(Date.UTC(2026, 8, 16, 0, 0, 0) / 1000) + (h * 60 + m - 330) * 60;
}
function bar(h: number, m: number, o: number, hi: number, lo: number, c: number, vol = 0): Candle {
  return { time: istEpoch(h, m), open: o, high: hi, low: lo, close: c, volume: vol };
}

function rangeBars(mid = 25000, half = 40): Candle[] {
  const out: Candle[] = [];
  for (let m = 15; m < 30; m++) {
    out.push(bar(9, m, mid, mid + half, mid - half, mid, 100));
  }
  return out;
}

function oi(under: number, strike: number, ce: number, pe: number): OiAnalysis {
  return {
    symbol: "^NSEI", nseSymbol: "NIFTY", available: true, underlying: under, expiry: "2026-09-17",
    pcr: 1, maxPain: strike, totalCeOi: 1, totalPeOi: 1, verdict: { bias: "Neutral", confidence: 0, summary: "" },
    topStrikes: [{ strike, ceOi: 1, peOi: 1, ceChg: 0, peChg: 0, ceLtp: ce, peLtp: pe }],
  } as OiAnalysis;
}

test("morning 9:30: WAIT while the 09:15-09:30 range is still building", () => {
  const r = evaluateMorning930({
    def: nifty, candles1m: rangeBars().slice(0, 8), oi: oi(25000, 25000, 120, 90),
    nowEpochSec: istEpoch(9, 22), openRisk: 0, startCapital: 200000,
  });
  assert.equal(r.action, "WAIT");
  assert.match(r.reason, /9:30/);
});

test("morning 9:30: WAIT inside the completed range", () => {
  const candles = [...rangeBars(), bar(9, 30, 25000, 25020, 24990, 25010, 100)];
  const r = evaluateMorning930({
    def: nifty, candles1m: candles, oi: oi(25010, 25000, 120, 90),
    nowEpochSec: istEpoch(9, 31), openRisk: 0, startCapital: 200000,
  });
  assert.equal(r.action, "WAIT");
  assert.match(r.reason, /inside/i);
  assert.equal(r.rangeFormed, true);
});

test("morning 9:30: TAKE CE on index up-break (volume n/a is not a veto)", () => {
  const candles = [
    ...rangeBars(25000, 40),
    bar(9, 30, 25040, 25090, 25030, 25080, 0),
  ];
  const r = evaluateMorning930({
    def: nifty, candles1m: candles, oi: oi(25080, 25100, 118, 95),
    nowEpochSec: istEpoch(9, 31), openRisk: 0, startCapital: 200000,
  });
  assert.equal(r.action, "TAKE");
  assert.equal(r.idea?.optionType, "CE");
  assert.equal(r.idea?.direction, "Bullish");
  assert.ok((r.idea?.premiumStop ?? 0) < (r.idea?.premium ?? 0));
  assert.ok((r.idea?.premiumTarget ?? 0) > (r.idea?.premium ?? 0));
});

test("morning 9:30: TAKE PE on index down-break", () => {
  const candles = [
    ...rangeBars(25000, 40),
    bar(9, 30, 24960, 24970, 24920, 24940, 0),
  ];
  const r = evaluateMorning930({
    def: nifty, candles1m: candles, oi: oi(24940, 24950, 80, 140),
    nowEpochSec: istEpoch(9, 31), openRisk: 0, startCapital: 200000,
  });
  assert.equal(r.action, "TAKE");
  assert.equal(r.idea?.optionType, "PE");
});

test("morning 9:30: stock break without 1.5x volume stays WAIT", () => {
  const prior: Candle[] = [];
  for (let i = 0; i < 25; i++) prior.push(bar(8, 50 + i, 1400, 1402, 1398, 1400, 100));
  const or: Candle[] = [];
  for (let m = 15; m < 30; m++) or.push(bar(9, m, 1400, 1410, 1390, 1400, 100));
  const candles = [...prior, ...or, bar(9, 30, 1410, 1425, 1408, 1420, 110)];
  const r = evaluateMorning930({
    def: stock, candles1m: candles, oi: oi(1420, 1420, 40, 38),
    nowEpochSec: istEpoch(9, 31), openRisk: 0, startCapital: 200000,
  });
  assert.equal(r.action, "WAIT");
  assert.match(r.reason, /volume/i);
});
