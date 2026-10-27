import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { parseTrade, resolveShortStrike } from "./parseTrade";
import { analyzeTrade, simulate, agg, tOf, hm, Bar1 } from "./learningEngine";

const TODAY = "2026-10-27";

test("parse: the experienced trader's three messages (27 Oct)", () => {
  const a = parseTrade("BUY Nifty 22750 PE ABOVE 50 SL-37 TARGET 78,95,105 Time 10:07 AM", TODAY, { date: TODAY });
  assert.deepEqual([a.index, a.strike, a.side, a.how, a.price, a.sl, a.targets, a.time, a.missing], ["NIFTY", 22750, "PE", "above", 50, 37, [78, 95, 105], "10:07", []]);
  const b = parseTrade("Nifty 22750 CE Above 52 and SL 40 Target 78,95,105 timing 12:12 PM", TODAY, { date: TODAY });
  assert.deepEqual([b.side, b.price, b.sl, b.time], ["CE", 52, 40, "12:12"]);
  const c = parseTrade("Nifty 750 CE Buy At 20 at 2.42 PM", TODAY, { date: TODAY });
  assert.deepEqual([c.strike, c.strikeShort, c.how, c.price, c.time, c.sl, c.targets], [750, true, "at", 20, "14:42", null, []]);
});

test("parse: dates, t1/t2, @, SENSEX, missing fields, unsupported index", () => {
  assert.equal(parseTrade("27 Oct nifty 22750 pe at 50 10:07", TODAY).date, "2026-10-27");
  assert.equal(parseTrade("oct 23 nifty 22750 pe at 50 10:07", TODAY).date, "2026-10-23");
  assert.equal(parseTrade("23/10/2026 nifty 22750 pe at 50 10:07", TODAY).date, "2026-10-23");
  assert.equal(parseTrade("yesterday nifty 22750 pe at 50 10:07", TODAY).date, "2026-10-26");
  const t = parseTrade("nifty 22700 pe @ 61.5 t1 80 t2 95 sl 50 10:30 target", TODAY, { date: TODAY });
  assert.deepEqual([t.price, t.how, t.targets, t.sl], [61.5, "at", [80, 95], 50]);
  const s = parseTrade("sensex 81500 ce above 120 sl 95 tgt 150/180 at 11:20", TODAY, { date: TODAY });
  assert.deepEqual([s.index, s.targets, s.time], ["SENSEX", [150, 180], "11:20"]);
  assert.equal(parseTrade("78/95 nifty 22750 pe at 50 sl 37 target 78/95 10:07", TODAY, { date: TODAY }).date, TODAY);   // targets never read as a date
  const m = parseTrade("nifty pe", TODAY);
  assert.deepEqual(m.missing, ["date", "strike + CE/PE", "buy price", "time"]);
  assert.match(parseTrade("banknifty 51000 ce above 300 10:00", TODAY).unsupported!, /NIFTY and SENSEX/);
  assert.equal(parseTrade("22750 pe above 50 at 10:07", TODAY, { index: "SENSEX", date: TODAY }).index, "SENSEX");   // defaults from the screen
});

test("short strike: '750' → nearest real strike", () => {
  assert.equal(resolveShortStrike(750, 22712, 50), 22750);
  assert.equal(resolveShortStrike(500, 81320, 100), 81500);
  assert.equal(resolveShortStrike(50, 22712, 50), 22750);
});

// ---------------------------------------------------------------- engine on a synthetic day (no network)
const DAY = "2026-10-20", T0 = tOf(DAY, "09:15");
function series(f: (i: number) => number, oiF: (i: number) => number | null = () => null): Bar1[] {
  const out: Bar1[] = []; for (let i = 0; i < 375; i++) { const c = f(i), p = i ? f(i - 1) : c; out.push({ t: T0 + i * 60, o: p, h: Math.max(p, c) + 0.5, l: Math.min(p, c) - 0.5, c, oi: oiF(i) }); }
  return out;
}

test("simulate: targets in order, SL first when a bar touches both, MFE / MAE", () => {
  const bars: Bar1[] = [100, 98, 110, 121, 131, 90].map((c, i) => ({ t: T0 + i * 60, o: c, h: c + 1, l: c - 1, c }));
  const s = simulate(bars, T0, 100, 90, [110, 120, 130], T0 + 3600);
  assert.deepEqual(s.hits.map((h) => [h.k, hm(h.t)]), [[1, "09:17"], [2, "09:18"], [3, "09:19"]]);
  assert.equal(s.sl, null); assert.equal(s.mae.px, 97); assert.equal(s.mfe.px, 132);
  const both: Bar1[] = [{ t: T0, o: 100, h: 100, l: 100, c: 100 }, { t: T0 + 60, o: 100, h: 125, l: 85, c: 100 }];
  const s2 = simulate(both, T0, 100, 90, [110], T0 + 3600);
  assert.equal(s2.hits.length, 0); assert.equal(s2.sl!.px, 90);   // the careful reading: SL first
});

test("agg: 3 / 5 / 15 minute candles anchored at 09:15", () => {
  const b = series((i) => 100 + i);
  assert.equal(agg(b, 15).length, 25); assert.equal(hm(agg(b, 15)[1].t), "09:30"); assert.equal(agg(b, 5)[0].c, 104);
});

test("engine: PE bought at a call wall after a double top — every section filled, nothing after 15:15", () => {
  // index rises to 22800 twice (minutes 60 and 70), then falls; the PE falls to a bottom at minute 60, then rises
  const idxF = (i: number) => (i < 60 ? 22700 + i * (100 / 60) : i < 65 ? 22800 - (i - 60) * 4 : i < 70 ? 22780 + (i - 65) * 3.6 : 22798 - (i - 70) * 2.5);
  const idx = series(idxF), opt = series((i) => (i < 60 ? 100 - i * (57 / 60) : i < 75 ? 43 + (i - 60) * 0.8 : 55 + (i - 75) * 2.5 > 120 ? 120 : 55 + (i - 75) * 2.5));
  const band = [22700, 22750, 22800, 22850].flatMap((k) => (["CE", "PE"] as const).map((side) => ({ strike: k, side,
    bars: series(() => 1, (i) => (side === "CE" && k === 22800 ? 21_000_000 : side === "CE" ? 5_000_000 - i * 1000 : 3_000_000 + i * 2000)) })));
  const r = analyzeTrade({ trade: { index: "NIFTY", date: DAY, strike: 22750, side: "PE", how: "above", price: 50, sl: 38, targets: [70, 90, 105], time: "10:20" },
    idx, prev: { day: "2026-10-19", h: 22760, l: 22600, c: 22753 }, opt, band, lot: 75, step: 50, expiryDay: true, source: "test" });
  assert.equal(r.fill!.px, 50); assert.equal(r.status, "ALL TARGETS");
  assert.equal(r.callWall!.strike, 22800); assert.equal(r.atLevel!.key, "callwall"); assert.equal(r.oi.wall!.held, true);
  assert.ok(r.double, "double top found"); assert.ok(r.base && r.base.v < 44, "premium bottom found");
  assert.equal(r.checklist.length, 7);
  for (const n of [3, 5, 15]) { assert.ok(r.tf[n].keyCandles.length >= 3, `key candles on ${n} min`); assert.ok(r.tf[n].keyCandles.every((k: any) => k.t <= tOf(DAY, "15:15"))); }
  assert.ok(r.phases.length >= 4); assert.ok(r.phases.every((p) => p.to <= tOf(DAY, "15:15")));
  assert.equal(r.scenarios[0].pnl, (70 - 50) * 75);
  assert.ok(Object.keys(r.angles).length === 9); assert.ok(r.lesson.length > 40);
});

test("engine: an 'above' entry that never trades is NOT_TRIGGERED and explained", () => {
  const idx = series((i) => 22700 + i * 0.1), opt = series((i) => 40 - i * 0.05);
  const r = analyzeTrade({ trade: { index: "NIFTY", date: DAY, strike: 22750, side: "CE", how: "above", price: 60, sl: 30, targets: [80], time: "10:00" },
    idx, prev: null, opt, band: [], lot: 75, step: 50, expiryDay: false, source: "test" });
  assert.equal(r.status, "NOT_TRIGGERED"); assert.equal(r.fill, null); assert.match(r.dataNotes[0], /not triggered/);
});

// ---------------------------------------------------------------- real 27 Oct data (skipped when the cache is absent)
const CACHED = fs.existsSync(path.join(process.cwd(), "data", "learning-cache", "NIFTY", "2026-10-27_index.json"));
test("engine on real data: 27 Oct NIFTY 22750 PE above 50 (trader call) hits T1–T3 by 10:21", { skip: !CACHED && "no learning cache for 27 Oct" }, async () => {
  const { indexDay, bandDay } = await import("./learningFeed");
  const { bars, prev } = await indexDay("NIFTY", "2026-10-27"), band = await bandDay("NIFTY", "2026-10-27");
  const opt = band.find((l) => l.strike === 22750 && l.side === "PE")!.bars;
  const r = analyzeTrade({ trade: { index: "NIFTY", date: "2026-10-27", strike: 22750, side: "PE", how: "above", price: 50, sl: 37, targets: [78, 95, 105], time: "10:07" },
    idx: bars, prev, opt, band, lot: 75, step: 50, expiryDay: true, source: "test" });
  assert.equal(r.status, "ALL TARGETS"); assert.equal(hm(r.fill!.t), "10:07");
  assert.ok(r.sim.hits.every((h) => hm(h.t) <= "10:21")); assert.equal(r.callWall!.strike, 22800); assert.equal(r.oi.wall!.held, true);
});

test("nearest weekly expiry of a day (a later expiry is a different option)", async () => {
  const { nearestExpiry } = await import("./learningFeed");
  assert.equal(nearestExpiry("NIFTY", "2026-10-23"), "2026-10-27");   // Friday → next Tuesday
  assert.equal(nearestExpiry("NIFTY", "2026-10-27"), "2026-10-27");   // expiry day itself
  assert.equal(nearestExpiry("SENSEX", "2026-10-23"), "2026-10-29");
});
