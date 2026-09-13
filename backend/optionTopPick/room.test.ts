import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRoom } from "./room";

test("computeRoom: CE with plenty of room to resistance passes", () => {
  const r = computeRoom("CE", 2340, 2300, 2450, 15);
  assert.equal(r.ok, true);
  assert.equal(r.distancePts, 110);
});

test("computeRoom: CE with resistance too close fails, even though a wall exists", () => {
  const r = computeRoom("CE", 2340, 2300, 2345, 15);
  assert.equal(r.ok, false);
  assert.equal(r.distancePts, 5);
});

test("computeRoom: PE measures distance down to support, not up to resistance", () => {
  const r = computeRoom("PE", 2340, 2300, 2450, 15);
  assert.equal(r.distancePts, 40);
});

test("computeRoom: minimum required room scales with the stock's own price, not a fixed index-point count", () => {
  const cheap = computeRoom("CE", 100, 90, 200, 0);
  const expensive = computeRoom("CE", 4000, 3900, 4200, 0);
  assert.ok(expensive.minRequiredPts > cheap.minRequiredPts);
});

test("computeRoom: an unknown opposing wall cannot pass — room is never assumed", () => {
  const r = computeRoom("CE", 2340, null, null, 15);
  assert.equal(r.ok, false);
  assert.equal(r.distancePts, null);
});
