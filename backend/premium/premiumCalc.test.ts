import { test } from "node:test";
import assert from "node:assert/strict";
import { premiumCalc } from "./premiumCalc";

const nowMs = Date.UTC(2026, 9, 16, 5, 0);   // Fri 10:30 IST, expiry Mon 19 Oct (≈3.2 days)
const chain = [23050, 23100, 23150, 23200, 23250].map((k) => ({ strike: k, ceLtp: Math.max(5, 23146 - k + 60), peLtp: Math.max(5, k - 23146 + 60), ceIv: 10, peIv: 11, ceDelta: 0.5, peDelta: -0.5, ceGamma: 0.002, peGamma: 0.002 }));

test("premium calculator: CE gains / PE loses on a move up; time decay lowers both; strikes around spot and target", () => {
  const up = premiumCalc({ spot: 23146, level: 23246, step: 50, expiry: "2026-10-19", mins: 0, strikes: chain, nowMs });
  const ce = up.rows.find((r) => r.strike === 23150 && r.side === "CE")!, pe = up.rows.find((r) => r.strike === 23150 && r.side === "PE")!;
  assert.ok(ce.chg! > 30 && ce.chg! < 100, `CE +100 index pts gains ~delta×100: ${ce.chg}`);
  assert.ok(pe.chg! < 0); assert.equal(ce.money, "ATM"); assert.equal(up.move, 100);
  const later = premiumCalc({ spot: 23146, level: 23246, step: 50, expiry: "2026-10-19", mins: 180, strikes: chain, nowMs });
  const ce2 = later.rows.find((r) => r.strike === 23150 && r.side === "CE")!;
  assert.ok(ce2.est! < ce.est!, "3 hours of time decay lowers the estimate");
  const one = premiumCalc({ spot: 23146, level: 23100, step: 50, expiry: "2026-10-19", mins: 0, strikes: chain, strike: 23200, nowMs });
  assert.deepEqual(one.rows.map((r) => `${r.strike}${r.side}`), ["23200CE", "23200PE"]);
  assert.equal(one.rows[0].money, "OTM"); assert.equal(one.rows[1].money, "ITM");
  // after expiry only intrinsic value is left
  const exp = premiumCalc({ spot: 23146, level: 23246, step: 50, expiry: "2026-10-19", mins: 100000, strikes: chain, nowMs });
  assert.equal(exp.rows.find((r) => r.strike === 23150 && r.side === "CE")!.est, 96);
});
