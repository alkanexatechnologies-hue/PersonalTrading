import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFii, enrichFiiRows, summariseFii } from "./fiiFutures";

test("classifyFii returns null without a prior day (no fabrication)", () => {
  assert.equal(classifyFii(-83080, null, null), null);
});

test("classifyFii: net rising + up close → LONG BUILDUP", () => {
  assert.equal(classifyFii(1400, -3680, 200), "LONG BUILDUP");
});

test("classifyFii: net rising + down close → SHORT COVERING", () => {
  assert.equal(classifyFii(-20970, -57410, -140), "SHORT COVERING");
});

test("classifyFii: net falling + up close → LONG UNWINDING", () => {
  assert.equal(classifyFii(-57410, -20970, 60), "LONG UNWINDING");
});

test("classifyFii: net falling + down close → SHORT BUILDUP", () => {
  assert.equal(classifyFii(-83080, -57410, -360), "SHORT BUILDUP");
});

test("enrichFiiRows computes netPos, dailyChange, type in date order", () => {
  const rows = enrichFiiRows([
    { date: "2026-09-22", longQty: 188770, shortQty: 192450, close: 23580 },
    { date: "2026-09-23", longQty: 199990, shortQty: 203680, close: 23620 },
    { date: "2026-09-26", longQty: 178450, shortQty: 235860, close: 23140 },
  ]);
  assert.equal(rows[0].netPos, 188770 - 192450);
  assert.equal(rows[2].netPos, 178450 - 235860);
  assert.equal(rows[1].dailyChange, (199990 - 203680) - (188770 - 192450));
  assert.ok(rows[2].positionType); // classified against the prior day
});

test("summariseFii on empty → DATA UNAVAILABLE, never fabricated", () => {
  const s = summariseFii([]);
  assert.equal(s.available, false);
  assert.equal(s.freshness, "UNAVAILABLE");
  assert.match(s.note, /UNAVAILABLE/);
});

test("summariseFii computes bias/pressure from real net position", () => {
  const rows = enrichFiiRows([
    { date: "2026-09-25", longQty: 196670, shortQty: 217640, close: 23280 },
    { date: "2026-09-26", longQty: 178450, shortQty: 235860, close: 23140 },
    { date: "2026-09-29", longQty: 165240, shortQty: 248320, close: 22780 },
  ]);
  const s = summariseFii(rows);
  assert.equal(s.available, true);
  assert.equal(s.currentNet, 165240 - 248320); // most-recent net
  assert.equal(s.bias, "BEARISH"); // deeply net short
});
