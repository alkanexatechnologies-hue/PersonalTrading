import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeskCommentary, readCandles, DeskInput, DeskBar } from "./deskCommentary";

// 2026-10-28 NIFTY, 12:35 → 13:30 5-min bars (real Dhan values)
const T = (h: number, m: number) => Date.parse(`2026-10-28T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+05:30`) / 1000;
const rows: [number, number, number, number, number, number][] = [
  [12, 35, 22665.75, 22678.05, 22649.75, 22676.65], [12, 40, 22678.5, 22699.2, 22670.3, 22696.25], [12, 45, 22698.95, 22722, 22697.7, 22705.15],
  [12, 50, 22705.75, 22725.1, 22698.8, 22718.8], [12, 55, 22723, 22762.75, 22710.35, 22761.3], [13, 0, 22764.05, 22778.05, 22731.6, 22737.55],
  [13, 5, 22737.3, 22739.65, 22724.1, 22731.5], [13, 10, 22733.25, 22747.3, 22723.75, 22735], [13, 15, 22736.9, 22741.2, 22704.4, 22711.65],
  [13, 20, 22714.35, 22725.45, 22681.85, 22682.55], [13, 25, 22683.75, 22727, 22676.15, 22726.1], [13, 30, 22726.15, 22731.05, 22717.35, 22720.45],
];
const c5: DeskBar[] = rows.map(([h, m, open, high, low, close]) => ({ time: T(h, m), open, high, low, close }));
const plan = (side: "CE" | "PE", trigger: number, entry: number, stop: number, t1: number, strike: number, pe: number, ps: number, p1: number) =>
  ({ side, trigger, entry, stop, t1, t2: null, rr: 1.75, strike, expiry: "2026-11-03", premNow: 160, premAtEntry: pe, premAtStop: ps, premAtT1: p1, premAtT2: null, triggerRisk: { risk: "MEDIUM" }, history: { pct: 56, n: 55 } });
const base: DeskInput = {
  index: "NIFTY", nowSec: T(13, 36), step: 50, lot: 75, atr15: 40, spot: 22718, dayHigh: 22778.05, dayLow: 22497.7, prevClose: 22749.75, c5,
  bull: plan("CE", 22840.72, 22846, 22819, 22931.68, 22850, 190.78, 177, 239), bear: plan("PE", 22700, 22695, 22722, 22647.82, 22700, 183.47, 170.81, 207),
  noTrade: { from: 22695, to: 22846 }, callWall: { strike: 22800, oiL: 59.7, state: "STRENGTHENING" }, putWall: { strike: 22700, oiL: 65.8, state: "WEAKENING" },
  atm: { strike: 22700, ceOi: 6_175_260, peOi: 6_344_520 }, trade: null, pending: null,
};

test("reads the hour's range, the 13:00 rejection near the call wall and the 13:25 SL hunt under the put wall", () => {
  const { story, range } = readCandles(base);
  assert.deepEqual(range, { hi: 22778.05, lo: 22649.75 });
  assert.ok(story.some((s) => /^13:00: .*rejection/.test(s)), story.join("\n"));
  assert.ok(!story.some((s) => /^13:20:/.test(s)));   // 13:20 closed BELOW 22,700 — a break, not a hunt
  assert.equal(story.length, 4);   // the range + the latest three reads (12:50 buying at 22,700, 13:00, 13:25)
  assert.ok(story.some((s) => /^13:25: <b>22,700<\/b> के नीचे 24 pts का wick.*SL hunt/.test(s)), story.join("\n"));
});

test("in the no-trade zone: WAIT headline, both cards carry the plan's own premiums, risk per lot and status", () => {
  const c = buildDeskCommentary(base);
  assert.equal(c.tone, "wait"); assert.match(c.headline, /अभी कोई trade नहीं — 22,718 no-trade zone \(22,695–22,846\)/);
  assert.equal(c.up!.buyAt, 191); assert.equal(c.up!.skipAbove, 210); assert.equal(c.up!.stopPrem, 177); assert.equal(c.up!.t1Prem, 239);
  assert.equal(c.down!.buyAt, 183); assert.equal(c.down!.perLotRisk, Math.round((183 - 171) * 75)); assert.equal(c.down!.perLotReward, Math.round((207 - 183) * 75));
  assert.equal(c.down!.risk, "मध्यम"); assert.match(c.down!.status, /इंतज़ार/);
  assert.ok(c.market.some((m) => /22,700 pin/.test(m))); assert.ok(c.market.some((m) => /call wall.*मज़बूत/.test(m)));
  assert.equal(c.condition.label, "RANGE");
});

test("an open co-pilot trade leads; pending retest and the time cut-offs change the headline", () => {
  const open = buildDeskCommentary({ ...base, trade: { side: "PE", strike: 22700, entrySpot: 22690, entryPrem: 185, stop: 22722, t1: 22648, t2: null, state: "OPEN", openedAt: T(13, 25) }, premLive: 178 });
  assert.equal(open.tone, "pe"); assert.match(open.headline, /22700 PE चालू — SL <b>22,722<\/b>.*premium 178 \(−7\)/); assert.match(open.down!.status, /ट्रेड चालू \(13:25 से\)/);
  const pd = buildDeskCommentary({ ...base, pending: { side: "bear", trigger: 22700, from: T(13, 30), until: T(14, 0) } });
  assert.equal(pd.tone, "pe"); assert.match(pd.down!.status, /14:00 तक 5-min retest/);
  assert.match(buildDeskCommentary({ ...base, nowSec: T(14, 50), spot: 22600 }).headline, /14:45 के बाद/);
  assert.equal(buildDeskCommentary({ ...base, nowSec: T(15, 13) }).tone, "closed");
});

test("live class: descending triangle read, the PE as the best opportunity with its steps, OI read and lessons", () => {
  // falling highs, flat lows ≈ 22,682–22,692 (the 13:00 → 14:20 shape)
  const hs = [22778, 22760, 22747, 22735, 22742, 22720, 22725, 22713, 22704, 22711, 22700, 22704];
  const ls = [22731, 22725, 22690, 22715, 22718, 22692, 22705, 22691, 22684, 22694, 22682, 22688];
  const bars: DeskBar[] = hs.map((h, i) => ({ time: T(13, 20) + i * 300, open: (h + ls[i]) / 2, high: h, low: ls[i], close: (h + ls[i]) / 2 + 2, volume: 1e6 }));
  const c = buildDeskCommentary({ ...base, nowSec: T(14, 23), spot: 22690, c5: bars,
    atm: { strike: 22700, ceOi: 6.3e6, peOi: 7.0e6, ceChg: 2.8e6, peChg: 3.6e6, ceLtpChgPct: -13.4, peLtpChgPct: -1.7 }, movers: [{ side: "PE", strike: 22600, chg: 5.5e6 }],
    closedToday: [{ side: "CE", strike: 22750, won: true }] });
  assert.equal(c.structure!.label, "DESCENDING TRIANGLE"); assert.equal(c.structure!.bias, "DOWN");
  assert.equal(c.best!.side, "PE"); assert.equal(c.best!.title, "22700 PE (11-03 expiry)");
  assert.match(c.best!.steps[0].v, /14:30 की 15-min candle <b>22,700<\/b> के नीचे बंद हो/);
  assert.match(c.best!.steps.find((x) => x.k === "⏰ Deadline")!.v, /^14:45 तक/);   // the 14:45 entry cut-off caps the 30-min retest window
  assert.ok(c.oiRead.some((x) => /CE premiums −13% गिरे/.test(x))); assert.ok(c.oiRead.some((x) => /22,600 PE में \+55\.0L/.test(x)));
  assert.ok(c.oiRead.some((x) => /22,700<\/b> put wall पर है/.test(x)));
  assert.ok(c.lessons.some((x) => /सीढ़ी/.test(x))); assert.ok(c.lessons.some((x) => /अच्छा trade हो चुका/.test(x)));
  assert.match(c.intro, /^नमस्कार दोस्तों! 14:23 बजे NIFTY <b>22,690<\/b>/);
});
