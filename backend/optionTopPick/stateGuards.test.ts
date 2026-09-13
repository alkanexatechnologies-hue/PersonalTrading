import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOneTradeGlobal, checkTimeFilter } from "./stateGuards";

// IST = UTC+5:30, so 14:30 IST == 09:00 UTC on the same day.
function epochAtUtc(hourUtc: number, minuteUtc: number): number {
  return Math.floor(Date.UTC(2026, 8, 15, hourUtc, minuteUtc, 0) / 1000);
}

test("checkTimeFilter: before 2:30 PM IST, new buying is not blocked", () => {
  const r = checkTimeFilter(epochAtUtc(8, 59)); // 14:29 IST
  assert.equal(r.blocked, false);
});

test("checkTimeFilter: at or after 2:30 PM IST, new buying is blocked with the exact required message", () => {
  const r = checkTimeFilter(epochAtUtc(9, 0)); // 14:30 IST
  assert.equal(r.blocked, true);
  assert.equal(r.reason, "New option buying blocked after 2:30 PM.");
});

test("checkOneTradeGlobal: no open index-option position -> not blocked", () => {
  const r = checkOneTradeGlobal([]);
  assert.equal(r.blocked, false);
});

test("checkOneTradeGlobal: any open index-option position blocks a new BUY, globally", () => {
  const r = checkOneTradeGlobal(["^NSEBANK"]);
  assert.equal(r.blocked, true);
  assert.ok(r.reason?.includes("HOLD EXISTING TRADE"));
});
