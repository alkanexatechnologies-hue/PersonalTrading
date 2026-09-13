import { test } from "node:test";
import assert from "node:assert/strict";
import { clearConfirmationForTest, updateConfirmation } from "./confirmationState";

const SYMBOL = "__OTP_TEST_SYMBOL__";

test("updateConfirmation: a brand-new directional signal starts as NEW, not immediately tradeable", () => {
  clearConfirmationForTest(SYMBOL);
  const r = updateConfirmation(SYMBOL, "CE", 1000, 50);
  assert.equal(r.status, "NEW");
  clearConfirmationForTest(SYMBOL);
});

test("updateConfirmation: the same side held for less than the minimum hold time stays PENDING", () => {
  clearConfirmationForTest(SYMBOL);
  updateConfirmation(SYMBOL, "CE", 1000, 50);
  const r = updateConfirmation(SYMBOL, "CE", 1060, 51); // +60s, well under the 3-minute floor
  assert.equal(r.status, "PENDING");
  clearConfirmationForTest(SYMBOL);
});

test("updateConfirmation: the same side held past the minimum hold time becomes CONFIRMED", () => {
  clearConfirmationForTest(SYMBOL);
  updateConfirmation(SYMBOL, "CE", 1000, 50);
  const r = updateConfirmation(SYMBOL, "CE", 1000 + 4 * 60, 55);
  assert.equal(r.status, "CONFIRMED");
  assert.equal(r.pending?.confirmationPremium, 55);
  clearConfirmationForTest(SYMBOL);
});

test("updateConfirmation: a flip to the opposite side resets confirmation — no stale carry-over", () => {
  clearConfirmationForTest(SYMBOL);
  updateConfirmation(SYMBOL, "CE", 1000, 50);
  updateConfirmation(SYMBOL, "CE", 1000 + 4 * 60, 55); // CONFIRMED CE
  const r = updateConfirmation(SYMBOL, "PE", 1000 + 5 * 60, 40); // flips
  assert.equal(r.status, "NEW");
  assert.equal(r.pending?.direction, "PE");
  clearConfirmationForTest(SYMBOL);
});

test("updateConfirmation: no current side clears any pending state (NONE)", () => {
  clearConfirmationForTest(SYMBOL);
  updateConfirmation(SYMBOL, "CE", 1000, 50);
  const r = updateConfirmation(SYMBOL, null, 1010, null);
  assert.equal(r.status, "NONE");
  clearConfirmationForTest(SYMBOL);
});
