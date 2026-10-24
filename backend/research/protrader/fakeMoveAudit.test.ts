import { test } from "node:test";
import assert from "node:assert/strict";
import { detectP, combine } from "./fakeMoveAudit";
import { detectFakeMoveTF, buildFakeMoveResult, FakeMoveLevel } from "../../analyst/fakeMove";

// The audit's parametrised detector must equal the LIVE detector with the default threshold, so every ablation is
// measured against exactly what the screen shows.
let _t = 1_700_000_000;
const bar = (o: number, h: number, l: number, c: number) => ({ open: o, high: h, low: l, close: c, volume: 0, time: (_t += 300) });
const sameAs = (c: any[], lv: FakeMoveLevel[]) => { const a = detectFakeMoveTF({ tfLabel: "5M", candles: c, levels: lv }), b = detectP(c, lv);
  return a.direction === b.direction && a.status === b.status && a.breakoutState === b.breakoutState && (a.level ?? null) === (b.level ?? null); };

test("copy = live on the documented patterns (fake-up, fake-down, breakout, retest, breakdown, no level)", () => {
  const R = [{ price: 100, label: "R", side: "resistance" as const }], S = [{ price: 100, label: "S", side: "support" as const }];
  assert.ok(sameAs([bar(98, 99, 97, 98), bar(98, 101, 98, 100.5), bar(100.5, 101, 99, 99.5), bar(99.5, 100, 98, 99)], R));
  assert.ok(sameAs([bar(102, 103, 101, 102), bar(102, 102, 99, 99.5), bar(99.5, 101, 99, 100.5), bar(100.5, 102, 100, 101)], S));
  assert.ok(sameAs([bar(99, 100, 98, 99), bar(99, 101, 99, 100.5), bar(100.5, 102, 100, 101.2), bar(101.2, 102, 101, 101.5)], R));
  assert.ok(sameAs([bar(99, 100, 98, 99), bar(99, 101, 99, 100.5), bar(100.5, 102, 100, 101), bar(101, 101.5, 99.9, 100.2)], R));
  assert.ok(sameAs([bar(101, 102, 100, 101), bar(101, 101, 99, 99.5), bar(99.5, 100, 98, 99), bar(99, 99.5, 98, 98.8)], S));
  assert.ok(sameAs([bar(98, 99, 97, 98), bar(98, 99, 97, 98), bar(98, 99, 97, 98)], [{ price: 120, label: "far", side: "resistance" }]));
});

test("copy = live on 5,000 random candle windows and level sets (fuzz)", () => {
  let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; k < 5000; k++) {
    let p = 22000 + rnd() * 1000; const c: any[] = [];
    for (let j = 0; j < 3 + Math.floor(rnd() * 6); j++) { const o = p, cl = o + (rnd() - 0.5) * 40, h = Math.max(o, cl) + rnd() * 15, l = Math.min(o, cl) - rnd() * 15; c.push(bar(o, h, l, cl)); p = cl; }
    const lv: FakeMoveLevel[] = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, j) => { const price = Math.round((p + (rnd() - 0.5) * 80) * 100) / 100; return { price, label: `L${j}`, side: rnd() < 0.5 ? "resistance" : "support" }; });
    assert.ok(sameAs(c, lv), `window ${k}`);
  }
});

test("combine = the live headline signal and confidence (buildFakeMoveResult)", () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; k < 3000; k++) {
    const mk = () => { let p = 22500; const c: any[] = []; for (let j = 0; j < 5; j++) { const o = p, cl = o + (rnd() - 0.5) * 40; c.push(bar(o, Math.max(o, cl) + rnd() * 15, Math.min(o, cl) - rnd() * 15, cl)); p = cl; } return c; };
    const lv: FakeMoveLevel[] = [22480, 22500, 22520].map((price) => ({ price, label: "L", side: rnd() < 0.5 ? "resistance" : "support" }));
    const c5 = mk(), c15 = mk(), live = buildFakeMoveResult({ tf5: { tfLabel: "5M", candles: c5, levels: lv }, tf15: { tfLabel: "15M", candles: c15, levels: lv }, higher: { timeframe: "1H", available: false }, existingDirection: null, dataStale: false });
    const cb = combine(detectP(c5, lv), detectP(c15, lv));
    const liveSig = ["FAILED_BREAKDOWN", "FAILED_BREAKOUT", "EARLY_REJECTION"].includes(live.mtfFakeMoveState.status) && (live.fakeMove5m.status === "CONFIRMED" || live.fakeMove15m.status === "CONFIRMED");
    assert.equal(!!cb, liveSig, `case ${k}`);
    if (cb) { assert.equal(cb.confidence, live.mtfFakeMoveState.confidence, `confidence ${k}`); assert.equal(cb.dir, live.mtfFakeMoveState.direction === "DOWN" ? 1 : -1); }
  }
});
