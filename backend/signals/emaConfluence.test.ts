// Master Trade Selector EMA confluence (session decision): emaConfluenceDirection
// only calls a direction when EMA9/21 and EMA21/50 agree with each other; any
// disagreement or insufficient history reads as Neutral, never an opposing signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emaShortDirection, emaLongDirection, emaConfluenceDirection } from "./emaConfluence";

function uptrend(n: number, start = 100, step = 1): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}
function downtrend(n: number, start = 300, step = 1): number[] {
  return Array.from({ length: n }, (_, i) => start - i * step);
}
function flat(n: number, value = 100): number[] {
  return Array.from({ length: n }, () => value);
}

test("emaShortDirection: Neutral when fewer than 21 bars", () => {
  assert.equal(emaShortDirection(uptrend(20)), "Neutral");
});

test("emaShortDirection: Bullish on a sustained uptrend, Bearish on a sustained downtrend", () => {
  assert.equal(emaShortDirection(uptrend(60)), "Bullish");
  assert.equal(emaShortDirection(downtrend(60)), "Bearish");
});

test("emaShortDirection: Neutral on a flat series (EMA9 == EMA21)", () => {
  assert.equal(emaShortDirection(flat(60)), "Neutral");
});

test("emaLongDirection: Neutral when fewer than 50 bars", () => {
  assert.equal(emaLongDirection(120, uptrend(40)), "Neutral");
});

test("emaLongDirection: Bullish on a sustained uptrend, Bearish on a sustained downtrend", () => {
  const up = uptrend(80);
  assert.equal(emaLongDirection(up[up.length - 1], up), "Bullish");
  const down = downtrend(80);
  assert.equal(emaLongDirection(down[down.length - 1], down), "Bearish");
});

test("emaLongDirection: Neutral on a flat series", () => {
  const f = flat(80);
  assert.equal(emaLongDirection(f[f.length - 1], f), "Neutral");
});

test("emaConfluenceDirection: Bullish only when short AND long both agree Bullish", () => {
  const up = uptrend(80);
  assert.equal(emaConfluenceDirection(up[up.length - 1], up), "Bullish");
});

test("emaConfluenceDirection: Bearish only when short AND long both agree Bearish", () => {
  const down = downtrend(80);
  assert.equal(emaConfluenceDirection(down[down.length - 1], down), "Bearish");
});

test("emaConfluenceDirection: Neutral (not an opposing signal) when there isn't enough history for EMA21/50", () => {
  const up = uptrend(30); // enough for EMA9/21 (Bullish) but not EMA21/50 (Neutral) -> disagreement -> Neutral overall
  assert.equal(emaConfluenceDirection(up[up.length - 1], up), "Neutral");
});

test("emaConfluenceDirection: Neutral on a flat series", () => {
  const f = flat(80);
  assert.equal(emaConfluenceDirection(f[f.length - 1], f), "Neutral");
});
