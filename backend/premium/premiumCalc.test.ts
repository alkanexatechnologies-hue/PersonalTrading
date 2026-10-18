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
test("real Friday chain (Dhan ITM CE IV = 0 / stale): consistent OTM IV, calls fall on a down move, arbitrage-free across strikes", async () => {
  const { premiumCalc, expiryIv } = await import("./premiumCalc");
  // the exact rows Dhan returned on Fri 16 Oct after the close (NIFTY spot 23,146)
  const rows = [[22900, 221.85, 0, 30, 19.51], [22950, 182, 0, 40.25, 19.41], [23000, 144, 0, 53.95, 19.47], [23050, 112.2, 6.42, 71.05, 19.59], [23100, 84.95, 8.82, 93.85, 20.13], [23150, 62.8, 10.06, 120.65, 20.75], [23200, 45, 10.86, 152.65, 21.71], [23250, 32.35, 11.66, 189.65, 23.04]]
    .map(([strike, ceLtp, ceIv, peLtp, peIv]) => ({ strike, ceLtp, ceIv, peLtp, peIv, ceDelta: 0, peDelta: -0.3, ceGamma: 0, peGamma: 0 }));
  assert.equal(Math.round(expiryIv(rows, 23146)! * 100) / 100, 15.41);       // ATM 23150: (CE 10.06 + PE 20.75) / 2
  const r = premiumCalc({ spot: 23146, level: 23000, step: 50, expiry: "2026-10-19", mins: 0, strikes: rows, nowMs: Date.UTC(2026, 9, 18, 13, 52) });
  const ce = (k: number) => r.rows.find((x) => x.strike === k && x.side === "CE")!, pe = (k: number) => r.rows.find((x) => x.strike === k && x.side === "PE")!;
  for (const k of [22900, 22950, 23000, 23050, 23100, 23150, 23200, 23250]) assert.ok(ce(k).chg! < 0, `CE ${k} must fall when the index falls: ${ce(k).chg}`);
  for (const k of [22900, 22950, 23000]) assert.ok(pe(k).chg! > 0);
  const ks = [22900, 22950, 23000, 23050, 23100, 23150, 23200, 23250];
  for (let i = 1; i < ks.length; i++) { assert.ok(ce(ks[i]).est! <= ce(ks[i - 1]).est!, `CE not increasing at ${ks[i]}`); assert.ok(pe(ks[i]).est! >= pe(ks[i - 1]).est!, `PE not decreasing at ${ks[i]}`); }
  assert.ok(ce(22900).est! >= 100, "22900 CE keeps at least its intrinsic value (100)");
  assert.equal(ce(22900).stale, true);   // ₹221.85 < intrinsic ₹246 → stale quote, model price used
  assert.equal(ce(23250).stale, false);
  // no flat run of identical call estimates (the earlier jump between put-side and call-side IV)
  assert.ok(ce(23150).est! > ce(23200).est! && ce(23200).est! > ce(23250).est!);
});
