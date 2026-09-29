import { test } from "node:test";
import assert from "node:assert/strict";
import { currentSlot, inSnapshotWindow, SLOTS } from "./snapshotStore";

// Build an epoch (ms) for a given IST wall-clock on a weekday (2026-09-29 = Tue).
function istMs(h: number, m: number): number {
  return Date.UTC(2026, 8, 29, h, m, 0) - 19800000; // subtract IST offset to get UTC epoch
}

test("currentSlot maps IST time to the right 30-min slot", () => {
  assert.equal(currentSlot(istMs(9, 12)), "09:10");
  assert.equal(currentSlot(istMs(9, 45)), "09:40");
  assert.equal(currentSlot(istMs(10, 10)), "10:10");
  assert.equal(currentSlot(istMs(14, 55)), "14:40");
});

test("currentSlot clamps before open and after last slot", () => {
  assert.equal(currentSlot(istMs(8, 30)), SLOTS[0]);   // pre-open → first slot
  assert.equal(currentSlot(istMs(16, 0)), "15:10");     // after last → last slot
});

test("inSnapshotWindow true during session, false off-hours/weekend", () => {
  assert.equal(inSnapshotWindow(istMs(10, 0)), true);
  assert.equal(inSnapshotWindow(istMs(7, 0)), false);
  assert.equal(inSnapshotWindow(istMs(16, 0)), false);
  // 2026-09-27 is a Sunday
  const sundayMs = Date.UTC(2026, 8, 27, 10, 0, 0) - 19800000;
  assert.equal(inSnapshotWindow(sundayMs), false);
});
