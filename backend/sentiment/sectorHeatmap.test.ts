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
