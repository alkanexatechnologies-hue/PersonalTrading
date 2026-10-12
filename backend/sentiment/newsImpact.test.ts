import { test } from "node:test";
import assert from "node:assert/strict";
import { newsRows, newsTabs, newMajor } from "./newsImpact";

const item = (title: string, over: any = {}) => ({ title, source: "ET", epoch: 1000, ageH: 1, tier: "MEDIA", dir: 0, note: null, pos: [], neg: [], link: "https://x", ...over });
const intel = { categories: [
  { label: "RBI", items: [item("RBI announces VRRR auction of 1.5 lakh crore", { tier: "OFFICIAL", source: "RBI", dir: -1, note: "Tighter liquidity weighs on banks", neg: ["Banks"], epoch: 2000 })] },
  { label: "Rupee", items: [item("RBI announces VRRR auction of 1.5 lakh crore today", { dir: -1, note: "x" }), item("Rupee gains on RBI steps", { dir: 1, note: "Rupee support", pos: ["Importers"], epoch: 1500 })] },
  { label: "Gold", items: [item("Gold steady in quiet trade"), item("Old gold story", { ageH: 9 })] },
] };

test("rows: fresh only, deduplicated (official copy kept), fact vs report, interpretation labelled", () => {
  const r = newsRows(intel);
  assert.equal(r.length, 3);                                    // duplicate merged, 9-hour item excluded
  const rbi = r.find((x) => /VRRR/.test(x.headline))!;
  assert.equal(rbi.kind, "CONFIRMED FACT"); assert.equal(rbi.source, "RBI"); assert.equal(rbi.strength, "High");
  assert.match(rbi.interpretation!, /^Interpretation:/);
  assert.deepEqual(rbi.affected, ["RBI", "Banks"]);
  assert.equal(r.find((x) => /Gold/.test(x.headline))!.kind, "REPORT");
  assert.deepEqual(r.map((x) => x.ts), [2000, 1500, 1000]);    // newest first
});

test("tabs count by impact", () => {
  assert.deepEqual(newsTabs(newsRows(intel)), { All: 3, Positive: 1, Negative: 1, Neutral: 1, Mixed: 0 });
});

test("new major headlines are those not seen before", () => {
  const r = newsRows(intel);
  const first = newMajor(r, new Set());
  assert.ok(first.length >= 1);
  assert.equal(newMajor(r, new Set(first.map((x) => x.id))).length, 0);
});
