import { test } from "node:test";
import assert from "node:assert/strict";
import { bandOf, PCR_BANDS, VIX_BANDS, nearPcr, vixTrend } from "./pcrVix";

test("PCR bands: bearish below 0.8, neutral 0.95–1.05, bullish above 1.05, extremes flagged", () => {
  assert.equal(bandOf(0.42, PCR_BANDS)!.label, "BEARISH · OVERSOLD");
  assert.equal(bandOf(0.62, PCR_BANDS)!.tone, "bear");
  assert.equal(bandOf(1.0, PCR_BANDS)!.label, "NEUTRAL");
  assert.equal(bandOf(1.38, PCR_BANDS)!.label, "BULLISH");
  assert.equal(bandOf(1.07, PCR_BANDS)!.label, "MILDLY BULLISH");
  assert.equal(bandOf(1.75, PCR_BANDS)!.label, "BULLISH · OVERBOUGHT");
  assert.equal(bandOf(null, PCR_BANDS), null);
});
test("VIX bands and today's direction", () => {
  assert.equal(bandOf(15.25, VIX_BANDS)!.label, "NORMAL");
  assert.equal(bandOf(23, VIX_BANDS)!.label, "HIGH");
  assert.equal(vixTrend(7).tone, "bear"); assert.equal(vixTrend(-6).tone, "bull"); assert.equal(vixTrend(1).tone, "neutral");
});
test("near-money PCR uses ATM ± 5 strikes only", () => {
  const s = [22300, 22400, 22500, 22600, 22700, 22800, 22900, 23500].map((k) => ({ strike: k, ceOi: k === 23500 ? 1e9 : 100, peOi: 150 }));
  assert.equal(nearPcr(s, 22600, 2), 1.5);   // far 23,500 call wall excluded
});
