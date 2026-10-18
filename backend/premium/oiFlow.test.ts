import { test } from "node:test";
import assert from "node:assert/strict";
import { oiFlow, oiHtml } from "./oiFlow";

const s = (strike: number, ceOi: number, peOi: number, ceChg: number, peChg: number) => ({ strike, ceOi, peOi, ceChg, peChg });
const chain = [s(22000, 5e5, 180e5, 0, 60e5), s(22900, 30e5, 80e5, -1e5, 9e5), s(23000, 60e5, 115e5, -6e5, 20e5), s(23100, 70e5, 50e5, 3e5, 18e5), s(23200, 97e5, 20e5, 9e5, 1e5), s(24000, 140e5, 5e5, 12e5, 0)];

test("OI flow: totals, PCR, NEAREST strong walls (chain max noted), tilt + bias, top movers", () => {
  const f = oiFlow({ strikes: chain, spot: 23146, step: 50 })!;
  assert.equal(f.totalCeL, 402); assert.equal(f.totalPeL, 450); assert.equal(f.pcr, 1.12);
  assert.equal(f.callWall.strike, 23200); assert.equal(f.callWall.chainMax!.strike, 24000);
  assert.equal(f.putWall.strike, 23000); assert.equal(f.putWall.chainMax!.strike, 22000);
  // near ±300: CE −6+3+9 = +6L (−1 at 22900 is outside? 22900 is 246 away → inside: −1) ; PE 9+20+18+1 = 48L
  assert.equal(f.bias, "BULLISH"); assert.ok(f.tiltToday! >= 85);
  assert.equal(f.movers[0].side, "PE"); assert.equal(f.movers[0].strike, 23000);
  assert.deepEqual(f.windows, []); assert.equal(f.last15, null);
});
test("OI flow: three 5-minute windows from snapshots, each with where OI moved most; html full + compact", () => {
  const bump = (base: typeof chain, k: number, side: "ceOi" | "peOi", v: number) => base.map((x) => (x.strike === k ? { ...x, [side]: x[side] - v } : x));
  const at5 = bump(chain, 23100, "peOi", 4e5);           // 5→0: PE 23100 +4L
  const at10 = bump(at5, 23200, "ceOi", 3e5);            // 10→5: CE 23200 +3L
  const at15 = bump(at10, 23000, "peOi", 2e5);           // 15→10: PE 23000 +2L
  const f = oiFlow({ strikes: chain, spot: 23146, step: 50, snaps: [{ ageMin: 15, strikes: at15 }, { ageMin: 10, strikes: at10 }, { ageMin: 5, strikes: at5 }] })!;
  assert.deepEqual(f.windows.map((w) => `${w.fromMin}-${w.toMin} ${w.top!.side} ${w.top!.strike}`), ["15-10 PE 23000", "10-5 CE 23200", "5-0 PE 23100"]);
  assert.equal(f.windows[1].tilt, 0); assert.equal(f.windows[2].tilt, 100);
  const h = oiHtml(f, { expiry: "2026-10-19" }).join("\n");
  assert.match(h, /Total OI: CE <b>402L<\/b>.*PE <b>450L<\/b>.*PCR <b>1.12<\/b>/);
  assert.match(h, /OI tilt near the price today: <b>Bulls \d+% · Bears \d+%<\/b> → <b>BULLISH<\/b>/);
  assert.match(h, /Call wall <b>23,200<\/b> .* = resistance · chain's biggest 24,000 \(140L\)/);
  assert.match(h, /Every 5 min — where OI moved most/);
  assert.match(h, /5→0 min ago: CE \+0\.0L · PE \+4\.0L · most at <b>PE 23,100 \+4\.0L<\/b> \(put writers adding = support building\) · tilt Bulls 100% · Bears 0%/);
  assert.match(h, /not a tested win probability/);
  const c = oiHtml(f, { compact: true }).join("\n");
  assert.match(c, /^📊 OI: total CE 402L · PE 450L · PCR <b>1.12<\/b> · tilt <b>Bulls/); assert.match(c, /last 5 min CE \+0\.0L · PE \+4\.0L · most at <b>PE 23,100/);
  assert.equal(oiFlow({ strikes: [], spot: 1, step: 50 }), null);
});
test("OI wall review: same definition as the plan; strengthening / weakening / shifted vs 15 min ago", async () => {
  const { wallReview, wallReviewHtml } = await import("./oiFlow");
  const now = [s(23000, 60e5, 115e5, 0, 0), s(23100, 70e5, 50e5, 0, 0), s(23200, 97e5, 20e5, 0, 0), s(24000, 140e5, 5e5, 0, 0)];
  const prev = [s(23000, 60e5, 120e5, 0, 0), s(23100, 70e5, 50e5, 0, 0), s(23200, 90e5, 20e5, 0, 0), s(24000, 140e5, 5e5, 0, 0)];
  const w = wallReview({ now, prev, spot: 23146, ageMin: 15 })!;
  assert.equal(w.call!.strike, 23200); assert.equal(w.call!.state, "STRENGTHENING"); assert.equal(w.majorCall, 24000);
  assert.equal(w.put!.strike, 23000); assert.equal(w.put!.state, "WEAKENING");
  const shifted = wallReview({ now, prev: prev.map((x) => (x.strike === 23200 ? { ...x, ceOi: 20e5 } : x)), spot: 23146, ageMin: 15 })!;
  assert.equal(shifted.call!.state, "SHIFTED"); assert.equal(shifted.call!.shiftedFrom, 24000);
  const h = wallReviewHtml(shifted).join("\n");
  assert.match(h, /Call wall <b>23,200<\/b> · 97L · <b>SHIFTED<\/b> from 24,000 \(resistance came closer\) · 54 pts above/);
  assert.match(wallReviewHtml(w).join("\n"), /Put wall <b>23,000<\/b> · 115L · −5\.0L in 15 min → <b>WEAKENING<\/b> · 146 pts below/);
  assert.equal(wallReview({ now, prev: null, spot: 23146, ageMin: null })!.call!.state, "NEW READ");
});
