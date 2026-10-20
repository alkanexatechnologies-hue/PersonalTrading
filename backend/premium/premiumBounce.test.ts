import { test } from "node:test";
import assert from "node:assert/strict";
import { bounceAt, bounceEvents, bounceStudy, oddsFor, rateOpportunity, roomBucket, BounceStudy } from "./premiumBounce";

// one session of 15-min premium candles from 09:15; the premium turns at ~100 (support) and ~130 (resistance)
const T0 = Date.parse("2026-10-19T03:45:00Z") / 1000;
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ time: T0 + i * 900, open: o, high: h, low: l, close: c });
const base = [bar(0, 115, 118, 112, 116), bar(1, 116, 122, 115, 121), bar(2, 121, 130, 120, 128), bar(3, 128, 129, 118, 119), bar(4, 119, 120, 105, 106), bar(5, 106, 108, 100, 101),
  bar(6, 101, 112, 101, 111), bar(7, 111, 129, 110, 127), bar(8, 127, 131, 121, 122), bar(9, 122, 123, 108, 109), bar(10, 109, 110, 101, 102)];
const bounce = bar(11, 102, 107, 99.5, 106);   // dips into the ~100 support, closes green above it

test("bounceAt: a green 15-min close off the support zone is a bounce; a red one is not", () => {
  const b = bounceAt([...base, bounce], 11)!;
  assert.ok(b && b.s1.price > 98 && b.s1.price < 103, JSON.stringify(b?.s1)); assert.ok(b.r1 && b.r1.price > 125);
  assert.equal(bounceAt([...base, bar(11, 106, 107, 99.5, 101)], 11), null, "red candle");
});
test("bounceEvents: PASS when a later candle closes above resistance before support breaks; FAIL when support breaks first", () => {
  const meta = { side: "CE" as const, strike: 23000, step: 50, spotAt: () => 23010, expiryDays: new Set<string>() };
  const pass = bounceEvents([...base, bounce, bar(12, 106, 118, 105, 117), bar(13, 117, 135, 116, 134)], meta);
  assert.equal(pass.length, 1); assert.equal(pass[0].outcome, "PASS"); assert.equal(pass[0].money, "ATM"); assert.ok(pass[0].touchedR);
  const fail = bounceEvents([...base, bounce, bar(12, 106, 107, 95, 96)], meta);
  assert.equal(fail[0].outcome, "FAIL");
});
test("study buckets, odds lookup (most specific with ≥ 40 events) and the star rating", () => {
  const ev = Array.from({ length: 100 }, (_, i) => ({ day: `2026-0${1 + (i % 9)}-10`, time: i, side: "CE" as const, strike: 1, money: "ATM", expiryDay: false, sT: "3+×", rT: "1×", room: "≤1.5 bars", outcome: (i % 2 ? "PASS" : "FAIL") as any, touchedR: true, maxGainPct: 10 }));
  const st = bounceStudy("T", ev);
  assert.equal(st.buckets.ALL.passPct, 50); assert.equal(oddsFor(st, { room: "≤1.5 bars", rT: "1×", sT: "3+×", expiryDay: false })!.key, "room:≤1.5 bars|R:1×|S:3+×");
  assert.equal(roomBucket(null), "no R"); assert.equal(roomBucket(2), "1.5–3 bars");
  // live: bouncing now with 50 % tested pass odds → ★★★★★ when liquid with R:R ≥ 1
  const study: BounceStudy = { ...st, buckets: Object.fromEntries(Object.entries(st.buckets).map(([k, b]) => [k, { ...b }])) };
  const allRooms = ["≤1.5 bars", "1.5–3 bars", ">3 bars"]; for (const r of allRooms) study.buckets[`room:${r}`] = { ...st.buckets.ALL };
  const live = rateOpportunity({ candles: [...base, bounce], ltp: 106, liq: "GOOD", rr: 1.5, expiryDay: false, study })!;
  assert.equal(live.state, "BOUNCING"); assert.equal(live.stars, 5); assert.equal(live.passPct, 50);
  assert.equal(rateOpportunity({ candles: [...base, bounce], ltp: 106, liq: "NO QUOTE", rr: 1.5, expiryDay: false, study })!.stars, 3, "no live quote caps at ★★★");
  assert.equal(rateOpportunity({ candles: [...base, bounce], ltp: 80, liq: "GOOD", rr: 1.5, expiryDay: false, study })!.stars, 1, "below support");
});
