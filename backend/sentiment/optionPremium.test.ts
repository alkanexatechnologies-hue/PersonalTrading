import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLeg, liquidityGrade, premiumAnalysis, strikeComparison, type ChainStrike } from "./optionPremium";

test("leg classification: delta-explained vs IV-driven vs both", () => {
  // spot +100 (0.45 %), delta 0.5 → explained +50
  assert.equal(classifyLeg(150, 100, 0.5, 100, 0.45, "Good").spike, "SPOT-DRIVEN");        // +50 fully explained, big %
  assert.equal(classifyLeg(170, 100, 0.5, 100, 0.45, "Good").spike, "BOTH");               // +20 extra = 20 %
  assert.equal(classifyLeg(125, 100, 0.5, 10, 0.05, "Good").spike, "IV-DRIVEN");           // spot flat, premium +25 %
  assert.equal(classifyLeg(125, 100, 0.5, 10, 0.05, "Low").spike, "LOW-LIQUIDITY SPIKE");
  assert.equal(classifyLeg(104, 100, 0.5, 10, 0.05, "Good").spike, "NONE");
  assert.equal(classifyLeg(null, 100, 0.5, 10, 0.05, "Good").spike, "NO DATA");
});

test("liquidity grades relative to the busiest nearby strike", () => {
  assert.equal(liquidityGrade(100, 100), "Excellent"); assert.equal(liquidityGrade(35, 100), "Good");
  assert.equal(liquidityGrade(12, 100), "Moderate"); assert.equal(liquidityGrade(5, 100), "Low"); assert.equal(liquidityGrade(null, 100), "Unknown");
});

const chain: ChainStrike[] = [22250, 22300, 22350, 22400, 22450, 22500].map((k, i) => ({
  strike: k, ceLtp: 200 - i * 35, peLtp: 60 + i * 35, cePrevClose: 190 - i * 35, pePrevClose: 70 + i * 35,
  ceDelta: 0.75 - i * 0.1, peDelta: -0.25 - i * 0.1, ceIv: 15, peIv: 15.5, ceVol: 1e6 / (1 + Math.abs(i - 2)), peVol: 9e5 / (1 + Math.abs(i - 2)),
}));

test("premium analysis: ATM ±2 window, no spread estimate, labelled rule", () => {
  const a = premiumAnalysis(chain, 22360, 22363)!;
  assert.equal(a.rows.length, 5);
  assert.equal(a.rows.find((r) => r.atm)!.strike, 22350);
  assert.match(a.spread, /ask − best bid/);
  assert.equal(a.rows[0].ce.spread, null);                       // no bid/ask in this fixture → shown as —
  assert.equal(a.detection.label, "No spike");
});

test("premium analysis flags an IV spike without spot confirmation", () => {
  const hot = chain.map((s) => (s.strike === 22350 ? { ...s, ceLtp: (s.cePrevClose as number) * 1.4 } : s));
  const a = premiumAnalysis(hot, 22364, 22363)!;
  assert.equal(a.detection.ceSpike, true); assert.equal(a.detection.withoutSpot, true);
  assert.match(a.detection.driver, /IV expansion/);
});

test("strike comparison: arbiter pick is SELECTED; R:R after costs from the spot plan; never chosen by premium rise", () => {
  const rows: any[] = strikeComparison(chain, 22360, "PE", { entry: 22360, stopLoss: 22400, target1: 22280 }, 22350);
  assert.deepEqual(rows.map((r) => r.kind), ["ITM", "ATM", "OTM", "OTM+2"]);
  assert.deepEqual(rows.map((r) => r.strike), [22400, 22350, 22300, 22250]);
  const sel = rows.find((r) => r.selected); assert.equal(sel.strike, 22350); assert.match(sel.why, /arbiter/);
  assert.ok(sel.rr > 0 && sel.rr < 2);                    // costs reduce the raw 2:1
  const noPlan: any[] = strikeComparison(chain, 22360, "CE", null, null);
  assert.ok(noPlan.every((r) => r.rr === null && !r.selected));
});

import { spreadOf } from "./optionPremium";
test("spread from best bid / ask; missing or crossed quotes give null", () => {
  assert.deepEqual(spreadOf(99, 101), { spread: 2, spreadPct: 2 });
  assert.deepEqual(spreadOf(null, 101), { spread: null, spreadPct: null });
  assert.deepEqual(spreadOf(102, 101), { spread: null, spreadPct: null });
});
