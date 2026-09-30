import { test } from "node:test";
import assert from "node:assert/strict";
import { recordStrikeSnapshot, strikeDeltas, strikeHistory, resetStrikeStore, sampleCount } from "./intradayStore";

// The store enforces a ~1-min cadence via wall-clock; to test deltas without
// waiting, we drive distinct asOf values and rely on the dedupe-by-asOf path
// plus a fresh symbol per test.

test("first snapshot yields zero-change deltas", () => {
  resetStrikeStore("T1");
  recordStrikeSnapshot("T1", 1000, 22000, [{ strike: 22000, ceOi: 100000, peOi: 100000, ceLtp: 50, peLtp: 50 }]);
  const d = strikeDeltas("T1", 5);
  assert.equal(sampleCount("T1"), 1);
  assert.equal(d.length, 2); // one CALL + one PUT
  assert.equal(d[0].oiChg, 0);
});

test("duplicate asOf is ignored", () => {
  resetStrikeStore("T2");
  recordStrikeSnapshot("T2", 2000, 22000, [{ strike: 22000, ceOi: 100000, peOi: 100000, ceLtp: 50, peLtp: 50 }]);
  recordStrikeSnapshot("T2", 2000, 22000, [{ strike: 22000, ceOi: 200000, peOi: 200000, ceLtp: 60, peLtp: 60 }]);
  assert.equal(sampleCount("T2"), 1);
});

test("history returns a per-side series", () => {
  resetStrikeStore("T3");
  recordStrikeSnapshot("T3", 3000, 22000, [{ strike: 22000, ceOi: 100000, peOi: 120000, ceLtp: 50, peLtp: 55 }]);
  const h = strikeHistory("T3", 22000, "PUT");
  assert.equal(h.length, 1);
  assert.equal(h[0].oi, 120000);
  assert.equal(h[0].ltp, 55);
});

test("empty symbol yields no deltas / no history", () => {
  resetStrikeStore("T4");
  assert.deepEqual(strikeDeltas("T4", 5), []);
  assert.deepEqual(strikeHistory("T4", 22000, "CALL"), []);
});
