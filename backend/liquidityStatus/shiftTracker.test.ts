import { test } from "node:test";
import assert from "node:assert/strict";
import { clearShiftHistoryForTest, recordShift } from "./shiftTracker";

const SYMBOL = "__LS_TEST_SYMBOL__";
const t0 = Math.floor(Date.UTC(2026, 8, 15, 4, 0, 0) / 1000); // 09:30 IST

test("recordShift: the first reading of the day is recorded with no prior event", () => {
  clearShiftHistoryForTest(SYMBOL);
  const r = recordShift(SYMBOL, "Neutral", t0);
  assert.equal(r.history.length, 1);
  assert.equal(r.lastEvent, null);
  clearShiftHistoryForTest(SYMBOL);
});

test("recordShift: an unchanged state is NOT re-appended (no polling firehose)", () => {
  clearShiftHistoryForTest(SYMBOL);
  recordShift(SYMBOL, "Neutral", t0);
  const r = recordShift(SYMBOL, "Neutral", t0 + 300);
  assert.equal(r.history.length, 1);
  clearShiftHistoryForTest(SYMBOL);
});

test("recordShift: an actual state change appends a new point AND produces a shift event with a reason", () => {
  clearShiftHistoryForTest(SYMBOL);
  recordShift(SYMBOL, "Neutral", t0);
  const r = recordShift(SYMBOL, "Bullish", t0 + 6000); // ~11:10
  assert.equal(r.history.length, 2);
  assert.equal(r.lastEvent?.previous, "Neutral");
  assert.equal(r.lastEvent?.current, "Bullish");
  assert.ok(r.history[0].time && r.history[1].time);
  clearShiftHistoryForTest(SYMBOL);
});

test("recordShift: progressive strengthening (Neutral -> Bullish -> Strong Bullish) builds a readable time-series", () => {
  clearShiftHistoryForTest(SYMBOL);
  recordShift(SYMBOL, "Neutral", t0);
  recordShift(SYMBOL, "Bullish", t0 + 6000);
  const r = recordShift(SYMBOL, "Strong Bullish", t0 + 9300);
  assert.deepEqual(r.history.map((p) => p.state), ["Neutral", "Bullish", "Strong Bullish"]);
  clearShiftHistoryForTest(SYMBOL);
});

test("recordShift: a CALL->PUT style flip (Bullish -> Bearish) is captured with a distinct reason", () => {
  clearShiftHistoryForTest(SYMBOL);
  recordShift(SYMBOL, "Bullish", t0);
  const r = recordShift(SYMBOL, "Bearish", t0 + 3000);
  assert.ok(r.lastEvent?.reason.toLowerCase().includes("flipped"));
  clearShiftHistoryForTest(SYMBOL);
});
