import { test } from "node:test";
import assert from "node:assert/strict";
import { allLines, breakEvents, breakStats, tfTrend, ladder, plans, coach, CoachIn, Level } from "./traderView";

const bar = (i: number, c: number, w = 1) => ({ time: 1_790_000_000 + i * 900, open: c, high: c + w, low: c - w, close: c, volume: 0 });
/** zig-zag down then a breakout: lower highs 110, 106, 102 then a rally */
function series() {
  const p = [100, 104, 108, 110, 107, 103, 100, 98, 101, 104, 106, 103, 99, 96, 99, 101, 102, 99, 96, 94, 95, 96, 97, 98, 99, 100, 101, 103, 106, 109, 112, 114, 116, 118, 119, 120, 121, 122, 123, 124];
  return p.map((v, i) => bar(i, v));
}

test("trendlines exist only from the bar after p2 is confirmed (no repaint)", () => {
  const c = series(), ls = allLines(c, 2);
  const s = ls.find((l) => l.kind === "SELLER")!;
  assert.ok(s && s.p2.price < s.p1.price && s.from === s.p2.index + 2);
  for (let n = 10; n <= c.length; n++) for (const l of allLines(c.slice(0, n), 2)) assert.ok(ls.some((x) => x.p1.index === l.p1.index && x.p2.index === l.p2.index && x.kind === l.kind), "a line vanished when later bars were added");
});
test("breaks need a CLOSE beyond; outcomes are measured from later candles", () => {
  const c = series(), ev = breakEvents(c, 2, 8);
  const up = ev.filter((e) => e.dir === "UP");
  assert.ok(up.length >= 1);
  assert.equal(up[up.length - 1].outcome === "FOLLOWED THROUGH" || up[up.length - 1].outcome === "PENDING", true);
  // a wick through a level is not a break
  const w = series().slice(0, 12); w.push({ ...bar(12, 99), high: 140 });
  assert.equal(breakEvents(w, 2, 8).some((e) => e.index === 12 && e.dir === "UP"), false);
  const st = breakStats(ev, "UP"); assert.ok(st.n >= 0 && (st.pct == null || st.pct <= 100)); assert.equal(st.weak, true);   // < 15 samples is always weak
});
test("trend verdict needs ≥ 3 of 4 agreeing signs", () => {
  const up = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i + (i % 5 === 0 ? -6 : 0)));   // dips deep enough to form confirmed higher lows
  assert.equal(tfTrend("15m", up, 2).verdict, "UP");
  assert.equal(tfTrend("15m", up.slice(0, 10), 2).verdict, "NO DATA");
});
const day = (d: string, o: number, h: number, l: number, c: number) => ({ time: Math.floor(Date.parse(d + "T00:00:00Z") / 1000) - 19800, open: o, high: h, low: l, close: c, volume: 0 });
test("ladder: previous day / pivots / previous week, sorted, with confluence", () => {
  const daily = [day("2026-10-05", 100, 120, 90, 110), day("2026-10-09", 110, 130, 100, 125), day("2026-10-13", 120, 140, 115, 135), day("2026-10-14", 135, 138, 125, 130)];
  const L = ladder({ daily, sessionDay: "2026-10-14", today: { high: 138, low: 125 }, lines: [{ label: "15m seller trendline", value: 140.1 }], chain: [], spot: 130, atr: 5 });
  assert.equal(L.find((x) => x.label === "Prev day high")!.price, 140);
  assert.equal(L.find((x) => x.label === "Prev week high")!.price, 130);   // week of 5–9 Oct
  assert.ok(L.find((x) => x.label === "Prev day high")!.confluence);        // trendline 140.1 within 0.2·ATR
  for (let i = 1; i < L.length; i++) assert.ok(L[i - 1].price >= L[i].price);
});
test("plans: trigger = nearest level beyond the noise, targets ≥ ½ ATR apart, stop ½ ATR back, flags weak history", () => {
  const lv: Level[] = [{ price: 160, label: "R2", kind: "PIVOT" }, { price: 150, label: "PDH", kind: "PREV DAY" }, { price: 141, label: "R1", kind: "PIVOT" }, { price: 130.5, label: "noise", kind: "TODAY" }, { price: 120, label: "PDL", kind: "PREV DAY" }, { price: 110, label: "S1", kind: "PIVOT" }];
  const p = plans({ levels: lv, spot: 130, atr: 10, chain: [], expiry: null, events: [] });
  assert.equal(p.bull!.trigger, 141); assert.equal(p.bull!.t1, 150); assert.equal(p.bull!.stop, 136); assert.equal(p.bull!.rr, 1.8);
  assert.equal(p.bear!.trigger, 120); assert.equal(p.bear!.t1, 110);
  assert.deepEqual(p.noTrade, { from: 120, to: 141 });
  assert.ok(p.bull!.flags.some((f) => /past breakouts/.test(f)));
  // OI wall + prev-day high + trendline within 0.75 ATR = one zone; the trigger is its far edge
  const z: Level[] = [{ price: 160, label: "R2", kind: "PIVOT" }, { price: 145.2, label: "trendline", kind: "TRENDLINE" }, { price: 145, label: "PDH", kind: "PREV DAY" }, { price: 140, label: "OI call wall", kind: "OI" }, { price: 120, label: "PDL", kind: "PREV DAY" }];
  const q = plans({ levels: z, spot: 130, atr: 10, chain: [], expiry: null, events: [] }).bull!;
  assert.equal(q.trigger, 145); assert.equal(q.zoneFrom, 140);   // 145.2 is within 0.1·ATR of 145 = the same level assert.equal(q.t1, 160); assert.match(q.triggerLabel, /zone 140–145/);
  assert.ok(q.flags.some((f) => /OI wall is in the trigger zone/.test(f)));
});
const C = (o: Partial<CoachIn> = {}): CoachIn => ({ session: "OPEN", istMin: 630, dataStatus: "LIVE", spot: 130, atr: 10, closed15: [bar(0, 129), bar(1, 130)],
  bull: { side: "CE", trigger: 141, stop: 136, t1: 150, rr: 1.8 } as any, bear: { side: "PE", trigger: 120, stop: 125, t1: 110, rr: 2 } as any,
  trends: [{ tf: "Daily", verdict: "UP" } as any, { tf: "1H", verdict: "RANGE" } as any], arbiter: { finalAction: "WAIT", reason: "", fresh: true }, riskOk: true, riskWhy: "ok",
  premium: { CE: { response: "RISING" }, PE: { response: "FLAT" } }, liquidity: { CE: "GOOD", PE: "GOOD" }, ...o });
test("coach: no-trade zone, wick vs close, counter-trend, arbiter has the final word, time rules", () => {
  assert.match(coach(C()).action, /NO-TRADE ZONE/);
  assert.match(coach(C({ istMin: 560 })).action, /OPENING RANGE/);
  assert.match(coach(C({ istMin: 900 })).action, /LATE SESSION/);
  assert.match(coach(C({ dataStatus: "STALE" })).action, /DATA NOT LIVE/);
  assert.match(coach(C({ spot: 143, closed15: [bar(0, 139), bar(1, 140)] })).action, /ATTEMPT/);                       // above trigger, no 15m close yet
  assert.match(coach(C({ spot: 144, closed15: [bar(0, 139), bar(1, 144)] })).action, /WAIT FOR RETEST/);              // closed beyond, arbiter WAIT
  assert.match(coach(C({ spot: 144, closed15: [bar(0, 139), bar(1, 144)], arbiter: { finalAction: "BUY_CE", reason: "", fresh: true } })).action, /READY — BUY CE/);
  assert.match(coach(C({ spot: 144, closed15: [bar(0, 139), bar(1, 144)], arbiter: { finalAction: "BUY_CE", reason: "", fresh: true }, riskOk: false })).action, /WAIT FOR RETEST/);
  assert.match(coach(C({ spot: 116, closed15: [bar(0, 121), bar(1, 116)] })).action, /COUNTER-TREND/);               // PE break vs daily UP
});
