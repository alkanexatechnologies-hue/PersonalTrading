import { test } from "node:test";
import assert from "node:assert/strict";
import { charges, netPoints } from "./costs";
import { tradeFriction } from "../../paper/engine";

test("charges equal the paper engine's itemised charges (slippage excluded) plus the SEBI fee", () => {
  const entry = 100 * 75, exit = 120 * 75;
  const paperWithSlip = tradeFriction("indexOption", entry, exit), paperSlip = 0.004 * (entry + exit);
  const c = charges(100, 120, 75);
  const sebi = 0.000001 * (entry + exit) * 1.18;
  assert.ok(Math.abs(c.total - (paperWithSlip - paperSlip) - sebi) < 0.02, `${c.total} vs ${paperWithSlip - paperSlip + sebi}`);
  assert.equal(c.brokerage, 40); assert.equal(c.stt, 9);   // 0.1 % of ₹9,000 sale value
});

test("net points: gross minus slippage both sides minus charges per unit", () => {
  const r = netPoints(100, 120, 75, 0);
  assert.equal(r.gross, 20); assert.ok(r.net < 20 && r.net > 18.5);
  const s = netPoints(100, 120, 75, 1);
  assert.ok(Math.abs(s.net - (r.net - 2)) < 0.05);
});
