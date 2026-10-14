import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConstituents, buildHeatmap } from "./sectorHeatmap";

test("parses NSE constituent CSV by the Symbol column", () => {
  const csv = "Company Name,Industry,Symbol,Series,ISIN Code\r\nAxis Bank Ltd.,Financial Services,AXISBANK,EQ,INE238A01034\r\nM&M Ltd.,Automobile,M&M,EQ,INE101A01026\r\nBajaj-Auto,Automobile,BAJAJ-AUTO,EQ,X\r\n";
  assert.deepEqual(parseConstituents(csv), ["AXISBANK", "M&M", "BAJAJ-AUTO"]);
  assert.deepEqual(parseConstituents("<html>Access Denied</html>"), []);
});

test("sector = average of its stocks; stocks shared by sectors count in each", () => {
  const members = { Bank: ["A", "B"], PSU: ["B", "C"] };
  const q = { A: { price: 101, previousClose: 100 }, B: { price: 99, previousClose: 100 }, C: { price: 103, previousClose: 100 } };
  const h = buildHeatmap(members, q, "2026-10-12", 1);
  assert.equal(h.status, "OK");
  assert.deepEqual(h.sectors.map((s) => [s.name, s.avg, s.adv, s.dec]), [["PSU", 1, 1, 1], ["Bank", 0, 1, 1]]);
  assert.equal(h.stocksUp, 2); assert.equal(h.stocksDown, 1); assert.equal(h.quoted, 3);
  assert.deepEqual(h.sectors[0].stocks.map((s) => s.s), ["C", "B"]);   // strongest first
});

test("drops missing quotes and impossible moves (>20%)", () => {
  const h = buildHeatmap({ X: ["A", "B", "C", "D"] }, { A: { price: 101, previousClose: 100 }, B: null, C: { price: 130, previousClose: 100 }, D: { price: 0, previousClose: 100 } }, "d", 1);
  assert.deepEqual(h.dropped.sort(), ["B", "C", "D"]);
  assert.equal(h.sectors[0].n, 1);
});

test("most stocks still at previous close → PREOPEN_NOT_AVAILABLE, not a flat map", () => {
  const q: any = {}; const syms = ["A", "B", "C", "D", "E"];
  syms.forEach((s, i) => (q[s] = { price: i === 0 ? 101 : 100, previousClose: 100 }));
  const h = buildHeatmap({ X: syms }, q, "d", 1);
  assert.equal(h.status, "PREOPEN_NOT_AVAILABLE");
  assert.match(h.note || "", /4 of 5/);
  assert.equal(buildHeatmap({ X: ["A"] }, { A: null }, "d", 1).status, "FAILED");
});

test("refill updates only stocks still at previous close and recomputes sectors", async () => {
  const { applyRefill } = await import("./sectorHeatmap");
  const h = buildHeatmap({ Energy: ["REL", "ONGC"], Oil: ["REL"] }, { REL: { price: 100, previousClose: 100 }, ONGC: { price: 101, previousClose: 100 } }, "d", 1);
  const r = applyRefill(h, new Map([["REL", 101], ["ONGC", 105]]), 2);
  const energy = r.sectors.find((s) => s.name === "Energy")!, oil = r.sectors.find((s) => s.name === "Oil")!;
  assert.equal(r.refilled, 1);                                   // REL updated once even though in 2 sectors
  assert.equal(energy.stocks.find((k) => k.s === "ONGC")!.price, 101);   // already-moved stock untouched
  assert.equal(oil.avg, 1); assert.equal(energy.avg, 1);
  assert.equal(r.atPrevClose, 0); assert.equal(r.stocksUp, 2);
});

import { niftyConstituentHeat } from "./sectorHeatmap";
test("NIFTY constituents: weight order, % move from the snapshot, index points", () => {
  const snap: any = { sectors: [{ name: "Bank", stocks: [{ s: "HDFCBANK", price: 1010, prev: 1000, pct: 1 }, { s: "ICICIBANK", price: 990, prev: 1000, pct: -1 }] }, { name: "Energy", stocks: [{ s: "RELIANCE", price: 1005, prev: 1000, pct: 0.5 }, { s: "HDFCBANK", price: 1010, prev: 1000, pct: 1 }] }] };
  const r = niftyConstituentHeat(snap, { RELIANCE: 0.0764, HDFCBANK: 0.1078, ICICIBANK: 0.0919, TCS: 0.03 }, 22000)!;
  assert.deepEqual(r.rows.map((x) => x.s), ["HDFCBANK", "ICICIBANK", "RELIANCE", "TCS"]);
  assert.equal(r.rows[0].points, Math.round(0.1078 * 0.01 * 22000 * 10) / 10);   // +23.7
  assert.equal(r.rows[3].pct, null); assert.equal(r.priced, 3); assert.equal(r.up, 2); assert.equal(r.down, 1);
  assert.equal(niftyConstituentHeat(null, {}, 1), null);
});
