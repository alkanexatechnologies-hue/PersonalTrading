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
  // level 141 + buffer 1 (0.1·ATR) → the plan starts at 142; stop ½ ATR back = 137; R:R from the entry = (150−142)/(142−137)
  assert.equal(p.bull!.trigger, 141); assert.equal(p.bull!.entry, 142); assert.equal(p.bull!.t1, 150); assert.equal(p.bull!.stop, 137); assert.equal(p.bull!.rr, 1.6);
  assert.equal(p.bear!.entry, 119); assert.equal(p.bear!.stop, 124);
  assert.equal(p.bear!.trigger, 120); assert.equal(p.bear!.t1, 110);
  assert.deepEqual(p.noTrade, { from: 119, to: 142 });   // between the two plan starts
  assert.ok(p.bull!.flags.some((f) => /past breakouts/.test(f)));
  // OI wall + prev-day high + trendline within 0.75 ATR = one zone; the trigger is its far edge
  const z: Level[] = [{ price: 160, label: "R2", kind: "PIVOT" }, { price: 145.2, label: "trendline", kind: "TRENDLINE" }, { price: 145, label: "PDH", kind: "PREV DAY" }, { price: 140, label: "OI call wall", kind: "OI" }, { price: 120, label: "PDL", kind: "PREV DAY" }];
  const q = plans({ levels: z, spot: 130, atr: 10, chain: [], expiry: null, events: [] }).bull!;
  assert.equal(q.trigger, 145); assert.equal(q.zoneFrom, 140);   // 145.2 is within 0.1·ATR of 145 = the same level assert.equal(q.t1, 160); assert.match(q.triggerLabel, /zone 140–145/);
  assert.ok(q.flags.some((f) => /OI wall is in the trigger zone/.test(f)));
  // dense levels 6 apart over 30 pts: the zone stops at 1 ATR (10) wide
  const dense: Level[] = [0, 6, 12, 18, 24, 30].map((d) => ({ price: 140 + d, label: "L" + d, kind: "PIVOT" as const }));
  const zz = plans({ levels: dense, spot: 130, atr: 10, chain: [], expiry: null, events: [] }).bull!;
  assert.equal(zz.zoneFrom, 140); assert.equal(zz.trigger, 146);
});
const C = (o: Partial<CoachIn> = {}): CoachIn => ({ session: "OPEN", istMin: 630, dataStatus: "LIVE", spot: 130, atr: 10, closed15: [bar(0, 129), bar(1, 130)],
  bull: { side: "CE", trigger: 141, entry: 142, stop: 137, t1: 150, rr: 1.6 } as any, bear: { side: "PE", trigger: 120, entry: 119, stop: 124, t1: 110, rr: 2 } as any,
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
test("level risk: room, OI wall, trend, rejections and history each add risk; far levels are FAR; strong supports are flagged for a bounce", async () => {
  const { levelRisks } = await import("./traderView");
  const tr = (d: string, h: string) => [{ tf: "Daily", verdict: d } as any, { tf: "1H", verdict: h } as any];
  const good = Array.from({ length: 20 }, () => ({ dir: "UP", outcome: "FOLLOWED THROUGH" } as any)).concat(Array.from({ length: 20 }, () => ({ dir: "DOWN", outcome: "FOLLOWED THROUGH" } as any)));
  const lv: Level[] = [{ price: 160, label: "R2", kind: "PIVOT" }, { price: 145, label: "PDH", kind: "PREV DAY" }, { price: 112, label: "S1", kind: "PIVOT" }, { price: 110, label: "Put wall", kind: "OI" }, { price: 90, label: "S2", kind: "PIVOT" }];
  // uptrend, good history: breaking 145 (15 pts room to 160 at ATR 10) is LOW risk
  let r = levelRisks({ levels: lv, spot: 130, atr: 10, closed: [], trends: tr("UP", "UP"), events: good });
  assert.equal(r.find((x) => x.price === 145)!.risk, "LOW");
  // breaking 112 down: counter-trend on both (+2) and a put wall 2 pts away (+1) → HIGH; but it is a strong support for a CE bounce
  const s1 = r.find((x) => x.price === 112)!; assert.equal(s1.risk, "HIGH"); assert.match(s1.bounce!, /strong support/);
  assert.equal(r.find((x) => x.price === 90)!.risk, "FAR");
  // weak history (+1) and three rejections at 145 (+1) → MEDIUM
  // three separate rejection episodes (a candle that does not reach the level between them)
  const rej = [140, 120, 141, 120, 142].map((c, i) => ({ time: 1_790_000_000 + i * 900, open: c, high: c > 130 ? 145.5 : c + 1, low: c - 1, close: c, volume: 0 }));
  r = levelRisks({ levels: lv, spot: 130, atr: 10, closed: rej, trends: tr("UP", "UP"), events: [] });
  const p = r.find((x) => x.price === 145)!; assert.equal(p.rejections, 3); assert.equal(p.risk, "MEDIUM");
});
test("opportunity radar: approaching → armed (forming only) → triggered (closed) → failed / missed", async () => {
  const { opportunity } = await import("./traderView");
  const p: any = { side: "CE", trigger: 100, entry: 102, stop: 97, t1: 120 };
  const k = (i: number, c: number) => ({ time: 1_790_000_000 + i * 900, open: c, high: c + 1, low: c - 1, close: c, volume: 0 });
  const base = [k(0, 90), k(1, 92), k(2, 95)];
  assert.equal(opportunity(p, base, k(3, 99), 10).state, "APPROACHING");                 // 3 pts away, 0.3 ATR = 3
  assert.equal(opportunity(p, base, k(3, 96), 10).state, "IDLE");
  assert.equal(opportunity(p, base, k(3, 103), 10).state, "ARMED");                      // forming above, not closed
  assert.equal(opportunity(p, [...base, k(3, 103)], k(4, 104), 10).state, "TRIGGERED");  // closed above the start
  assert.equal(opportunity(p, [...base, k(3, 103), k(4, 99)], k(5, 99), 10).state, "FAILED");
  assert.equal(opportunity(p, [...base, k(3, 103)], k(4, 121), 10).state, "MISSED");
  const q: any = { side: "PE", trigger: 100, entry: 98, stop: 103, t1: 80 };
  assert.equal(opportunity(q, [k(0, 105), k(1, 97)], k(2, 96), 10).state, "TRIGGERED");
});
test("session plan stays fixed while price moves; rolls only after Target 1 or a failure on a closed candle", async () => {
  const { anchoredPlans } = await import("./traderView");
  const lv: Level[] = [{ price: 160, label: "R2", kind: "PIVOT" }, { price: 150, label: "R1", kind: "PIVOT" }, { price: 141, label: "PDH", kind: "PREV DAY" }, { price: 120, label: "PDL", kind: "PREV DAY" }, { price: 110, label: "S1", kind: "PIVOT" }];
  const k = (i: number, c: number) => ({ time: 1_790_000_000 + i * 900, open: c, high: c + 1, low: c - 1, close: c, volume: 0 });
  // price drifts up to 140 (inside the zone): the plan must NOT move
  let r = anchoredPlans({ levels: lv, spot: 140, prevClose: 130, todays15: [k(0, 135), k(1, 140)], atr: 10, chain: [], expiry: null, events: [] });
  assert.equal(r.bull!.entry, 142); assert.equal(r.bear!.entry, 119); assert.equal(r.anchor.rolls.length, 0);
  // today's low appearing above the anchor (e.g. a gap-up day) must not re-shape the plan
  const withToday = [...lv, { price: 133, label: "Today low", kind: "TODAY" as const }];
  r = anchoredPlans({ levels: withToday, spot: 140, prevClose: 130, todays15: [k(0, 135)], atr: 10, chain: [], expiry: null, events: [] });
  assert.equal(r.bull!.entry, 142);
  // triggers (close 143) then reaches T1 150 → rolls to the next levels
  r = anchoredPlans({ levels: lv, spot: 151, prevClose: 130, todays15: [k(0, 143), k(1, 151)], atr: 10, chain: [], expiry: null, events: [] });
  assert.equal(r.anchor.rolls.length, 1); assert.match(r.anchor.why, /Target 1/); assert.equal(r.bull!.trigger, 160);
});
test("plan levels are ranked against the anchor, so a live-price move never reshuffles the plan", async () => {
  const { anchoredPlans } = await import("./traderView");
  const k = (i: number, c: number) => ({ time: 1_790_000_000 + i * 900, open: c, high: c + 1, low: c - 1, close: c, volume: 0 });
  // a wall whose side flips with the price it is ranked against: above the ref it is resistance, below it support
  const levelsAt = (ref: number): Level[] => [{ price: 150, label: "R1", kind: "PIVOT" }, { price: 141, label: ref < 141 ? "call wall" : "put wall", kind: "OI" }, { price: 120, label: "PDL", kind: "PREV DAY" }];
  const r1 = anchoredPlans({ levels: levelsAt(130), spot: 130, prevClose: 130, todays15: [k(0, 132)], atr: 10, chain: [], expiry: null, events: [], levelsAt });
  const r2 = anchoredPlans({ levels: levelsAt(145), spot: 145, prevClose: 130, todays15: [k(0, 132)], atr: 10, chain: [], expiry: null, events: [], levelsAt });
  assert.equal(r1.bull!.entry, r2.bull!.entry);   // live price 130 vs 145 — same plan
});
test("significant lines: at most one respected (unbroken) + one recently broken per side", async () => {
  const { significantLines } = await import("./traderView");
  const p = [100, 104, 110, 104, 100, 98, 101, 106, 101, 98, 96, 99, 103, 100, 97, 98, 99, 101, 100, 99];
  const c = p.map((v, i) => ({ time: 1_790_000_000 + i * 900, open: v, high: v + 0.5, low: v - 0.5, close: v, volume: 0 }));
  const out = significantLines(c as any, 2, 2, 0);
  for (const kind of ["SELLER", "BUYER"]) {
    const mine = out.filter((l) => l.kind === kind);
    assert.ok(mine.length <= 2); assert.ok(mine.filter((l) => l.brokeAt == null).length <= 1);
  }
  assert.ok(out.every((l) => typeof l.touches === "number"));
});
test("significant lines: a smooth staircase of lower highs (no 3-bar pivot) still gets a minor seller line", async () => {
  // rally to a top, then lower highs whose pivots are only 2 bars wide, with closes staying below the falling line
  const hs = [100, 104, 108, 112, 116, 120, 117, 118.5, 116, 117, 118, 117.5, 115, 113, 112, 111, 110.5, 110, 109.5, 109];
  const c = hs.map((h, i) => ({ time: 1_700_000_000 + i * 300, open: h - 2, high: h, low: h - 4, close: h - 2, volume: 0 }));
  const { significantLines } = await import("./traderView");
  const L = significantLines(c as any, 3, 3, 0);
  const s = L.find((l: any) => l.kind === "SELLER" && l.brokeAt == null) as any;
  assert.ok(s, "seller line present");
  assert.equal(s.minor, true);
  assert.ok(s.p2.price < s.p1.price);
});
