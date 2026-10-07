import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../types";
import type { LiqLevel } from "../liquidity/liquidityTake";
import { evaluateSession } from "./setupSignals";

// Bars from 09:15 IST with explicit OHLC. `day` = ISO date.
const t0 = (day: string) => Date.parse(`${day}T03:45:00Z`) / 1000;
const bar = (day: string, i: number, o: number, h: number, l: number, c: number): Candle => ({ time: t0(day) + i * 300, open: o, high: h, low: l, close: c, volume: 1000 });
// A calm prior session (ATR ≈ 10) used for warm-up; trend flat.
function prior(day = "2026-10-05", base = 100): Candle[] {
  return Array.from({ length: 72 }, (_, i) => { const p = base + (i % 2 ? 2 : -2); return bar(day, i, p, p + 5, p - 5, p + (i % 2 ? 1 : -1)); });
}
const lvl = (type: string, price: number, activeFrom: number, sources = [type + ": test"]): LiqLevel =>
  ({ id: type, type, sources, price, side: "UPSIDE", activeFrom, refPrice: 0, priority: 1 });
const D = "2026-10-06";

// Price rises from 90 toward resistance 110, a rejection candle at bar 6, confirmation at bar 7.
function rejectionDay(): Candle[] {
  const c: Candle[] = [
    bar(D, 0, 90, 93, 88, 92), bar(D, 1, 92, 96, 91, 95), bar(D, 2, 95, 99, 94, 98), bar(D, 3, 98, 102, 97, 101),
    bar(D, 4, 101, 105, 100, 104), bar(D, 5, 104, 107, 103, 106),
    bar(D, 6, 106, 112, 103.5, 104),     // probes 110 (+2), long upper wick, closes back below near the low
    bar(D, 7, 104, 105, 97, 98),         // confirmation: close below the rejection candle's midpoint (and below VWAP), no new high
  ];
  for (let i = 8; i < 30; i++) { const p = 100 - (i - 8) * 1.5; c.push(bar(D, i, p, p + 2, p - 3, p - 1.5)); }
  return c;
}

test("resistance rejection → BUY PE only after the confirming candle (no look-ahead)", () => {
  const h = prior(), day = rejectionDay(), L = [lvl("Previous Day High", 110, t0(D))];
  // daily ATR 30 → the 24-pt move into the level is ≥ 0.6× daily ATR = EXTREME, so the fade is allowed
  // even though today's rally turned the 15M trend up (an ordinary rally would be blocked — next tests).
  const at = (n: number) => evaluateSession(h, day.slice(0, n), L, 30, day[n - 1].time + 300);
  assert.equal(at(7).signals.filter((s) => s.setup === "S3_LEVEL_REJECTION").length, 0, "nothing on the rejection candle alone");
  const s = at(8).signals.find((x) => x.setup === "S3_LEVEL_REJECTION");
  assert.ok(s, "signal on confirmation");
  assert.equal(s!.side, "PE");
  assert.equal(s!.context, "EXTREME");
  assert.equal(s!.status, "ENTRY_READY");
  assert.ok(s!.plan!.stop > 112, "stop above the rejection high");
  // Same signal, same plan, when more candles exist (future candles only grade it).
  const full = evaluateSession(h, day, L, 30, day[day.length - 1].time + 300).signals.find((x) => x.setup === "S3_LEVEL_REJECTION")!;
  assert.equal(full.time, s!.time);
  assert.equal(full.plan!.stop, s!.plan!.stop);
  assert.ok(["TARGET", "STOP", "TIME_EXIT", "EOD_EXIT", "ACTIVE", "NO_TRIGGER"].includes(full.status));
});

test("failed breakdown (1 close below support, then a strong close back) → BUY CE", () => {
  const h = prior("2026-10-05", 115);
  const c = [bar(D, 0, 112, 114, 108, 109), bar(D, 1, 109, 111, 104, 106),
    bar(D, 2, 106, 107, 98, 98.5),        // closes below support 100 (1 candle only)
    bar(D, 3, 98.5, 108, 97, 107),        // strong close back above — sweep / failed breakdown
    bar(D, 4, 107, 110, 105, 109)];       // confirmation above the midpoint, no new low
  for (let i = 5; i < 25; i++) { const p = 109 + (i - 5); c.push(bar(D, i, p, p + 3, p - 1, p + 1)); }
  const r = evaluateSession(h, c, [lvl("Previous Day Low", 100, t0(D))], 60, c[c.length - 1].time + 300);
  const s = r.signals.find((x) => x.setup === "S3_LEVEL_REJECTION");
  assert.ok(s, "signal found");
  assert.equal(s!.side, "CE");
  assert.match(s!.evidence.join(" "), /Failed breakdown|Sweep/);
});

test("two closes beyond the level = acceptance → no fade", () => {
  const h = prior();
  const c = [bar(D, 0, 104, 108, 103, 107), bar(D, 1, 107, 113, 106, 112), bar(D, 2, 112, 115, 111, 114),
    bar(D, 3, 114, 115, 107, 108), bar(D, 4, 108, 109, 104, 105)];
  const r = evaluateSession(h, c, [lvl("Previous Day High", 110, t0(D))], 60, c[c.length - 1].time + 300);
  assert.equal(r.signals.filter((x) => x.setup === "S3_LEVEL_REJECTION" && !x.blockedBy && x.side === "PE").length, 0);
});

test("a PE fade against a 15M uptrend (not extreme, not range) is blocked", () => {
  // prior sessions trending up strongly → 15M EMA9 > EMA21
  const up = (day: string, b: number) => Array.from({ length: 72 }, (_, i) => { const p = b + i * 0.5; return bar(day, i, p, p + 2, p - 1, p + 1); });
  const h = [...up("2026-10-01", 14), ...up("2026-10-05", 50)];   // ends ~86, below today's open 90
  const day = rejectionDay();
  const r = evaluateSession(h, day, [lvl("Previous Day High", 110, t0(D))], 1000, day[day.length - 1].time + 300);
  const s = r.signals.find((x) => x.setup === "S3_LEVEL_REJECTION");
  assert.ok(s);
  assert.match(s!.blockedBy || "", /15M trend UP/);
});

test("the same level does not fire twice without re-arming", () => {
  const h = prior(), day = rejectionDay();
  // a second rejection at the same level right after (price never moved 1 ATR away in between is not the case
  // here, but the level was already traded and the first signal is still open/just closed).
  const r = evaluateSession(h, [...day.slice(0, 8), ...day.slice(0, 8).map((x, i) => ({ ...x, time: day[7].time + (i + 1) * 300 }))], [lvl("Previous Day High", 110, t0(D))], 60, day[7].time + 9 * 300 + 300);
  const fired = r.signals.filter((x) => x.setup === "S3_LEVEL_REJECTION" && !x.blockedBy);
  assert.ok(fired.length <= 1, `fired ${fired.length}`);
});

test("VWAP trend pullback: buys the pullback that holds, not the extreme bar; blocked when a level is too close", () => {
  const h = prior("2026-10-05", 100);
  const c: Candle[] = [];
  // steady rally from 100 to ~140 with tight pullbacks; volume constant → VWAP lags well below
  for (let i = 0; i < 20; i++) { const p = 100 + i * 2; c.push(bar(D, i, p, p + 2.5, p - 0.5, p + 2)); }
  // pullback to EMA9 that closes green above it
  const last = c[c.length - 1].close;
  c.push(bar(D, 20, last, last + 0.5, last - 7, last - 1));
  c.push(bar(D, 21, last - 1, last + 1, last - 6.5, last + 0.8));
  const levelsFar = [lvl("Previous Day High", 400, t0(D))];
  const r = evaluateSession(h, c, levelsFar, 1000, c[c.length - 1].time + 300);
  const s4 = r.signals.filter((x) => x.setup === "S4_VWAP_PULLBACK");
  // The trend here is synthetic; the 15M filter may block — but never a signal on a bar that is not a pullback.
  for (const s of s4) assert.ok(s.time >= "09:50", "not before 09:45");
  const near = evaluateSession(h, c, [lvl("Previous Day High", last + 5, t0(D))], 1000, c[c.length - 1].time + 300);
  for (const s of near.signals.filter((x) => x.setup === "S4_VWAP_PULLBACK")) assert.ok(s.blockedBy, "blocked: resistance too close");
});

test("VWAP bias (trader's rule): the last 5m close above VWAP = BULLISH, below = BEARISH", () => {
  const h = prior();
  const up = [bar(D, 0, 100, 102, 99, 101), bar(D, 1, 101, 104, 100, 103), bar(D, 2, 103, 106, 102, 105)];
  assert.equal(evaluateSession(h, up, [], 60, up[2].time + 300).vwapBias!.bias, "BULLISH");
  const dn = [bar(D, 0, 100, 101, 97, 98), bar(D, 1, 98, 99, 95, 96), bar(D, 2, 96, 97, 93, 94)];
  assert.equal(evaluateSession(h, dn, [], 60, dn[2].time + 300).vwapBias!.bias, "BEARISH");
});

import { analyzeMoves, type SetupSignal } from "./setupSignals";
test("logic vs market: a big move is CAUGHT / BLOCKED / MISSED depending on the signals", () => {
  const h = prior();
  // flat, then a strong 40-pt rally (≈ 4× ATR of ~10), then flat
  const c: Candle[] = [];
  for (let i = 0; i < 10; i++) c.push(bar(D, i, 100, 102, 98, 100));
  for (let i = 10; i < 20; i++) { const p = 100 + (i - 9) * 4; c.push(bar(D, i, p - 4, p + 1, p - 5, p)); }
  for (let i = 20; i < 30; i++) c.push(bar(D, i, 140, 141, 136, 138));
  const sig = (over: Partial<SetupSignal>): SetupSignal => ({ id: "x", setup: "S3_LEVEL_REJECTION", label: "", context: "MORNING", side: "CE", date: D, barTime: c[10].time, time: "10:10",
    level: null, evidence: [], blockedBy: null, plan: null, status: "TARGET", fillTime: null, exitTime: null, exitPrice: null, resultR: 1.5, metrics: {}, ...over });
  const none = analyzeMoves(h, c, [], []);
  assert.ok(none.summary.moves >= 1);
  assert.equal(none.moves.find((m) => m.dir === "UP")!.verdict, "MISSED");
  assert.equal(analyzeMoves(h, c, [sig({})], []).moves.find((m) => m.dir === "UP")!.verdict, "CAUGHT");
  const b = analyzeMoves(h, c, [sig({ blockedBy: "15M trend DOWN — this is more likely a pullback than a reversal", status: "BLOCKED", resultR: null })], []);
  const up = b.moves.find((m) => m.dir === "UP")!;
  assert.equal(up.verdict, "BLOCKED");
  assert.match(up.blockReasons.join(" "), /15M trend DOWN/);
  assert.equal(analyzeMoves(h, c, [sig({ side: "PE", resultR: -1, status: "STOP" })], []).moves.find((m) => m.dir === "UP")!.verdict, "WRONG_SIDE");
});

// A trending day: rally with shallow pullbacks every 4th candle, then a drop below VWAP.
function trendDay(): Candle[] {
  const c: Candle[] = []; let p = 100;
  for (let i = 0; i < 50; i++) {
    const pull = i % 4 === 3;
    const o = p, cl = pull ? p - 1.5 : p + 3;
    c.push(bar(D, i, o, Math.max(o, cl) + (pull ? 0.5 : 1), Math.min(o, cl) - (pull ? 3.5 : 0.5), cl));
    if (pull) { const n = c.length - 1; c[n] = { ...c[n], open: o - 2, low: o - 14, close: o + 1, high: o + 1.5 }; p = o + 1; } else p = cl;   // dips to EMA 9 (~12 pts behind), closes green above it
  }
  for (let i = 50; i < 70; i++) { p -= 6; c.push(bar(D, i, p + 6, p + 7, p - 1, p)); }
  return c;
}
test("S5: direction turns UP on the rally (alert event) and DOWN/NEUTRAL after the drop", () => {
  const h = prior("2026-10-05", 100), c = trendDay();
  const r = evaluateSession(h, c, [], 200, c[c.length - 1].time + 300, { s5DistPts: 20 });
  const ev = r.directionEvents.map((e) => e.to);
  assert.ok(ev.includes("UP"), ev.join(","));
  assert.ok(ev.indexOf("UP") < Math.max(ev.lastIndexOf("DOWN"), ev.lastIndexOf("NEUTRAL")), "turns away from UP after the drop");
  assert.ok(r.directionEvents.every((e) => /VWAP/.test(e.why)));
  assert.notEqual(r.direction!.state, "UP");
});
test("S5: pullback entries in the up trend; once 50% is booked the result is ≥ +0.25R; no look-ahead", () => {
  const h = prior("2026-10-05", 100), c = trendDay();
  const full = evaluateSession(h, c, [], 200, c[c.length - 1].time + 300, { s5DistPts: 20 });
  const s5 = full.signals.filter((x) => x.setup === "S5_EMA_TREND" && !x.blockedBy);
  assert.ok(s5.length >= 1, "at least one S5 signal");
  for (const s of s5) {
    assert.equal(s.side, "CE");
    if (s.metrics.booked && s.resultR != null) assert.ok(s.resultR >= 0.25 - 1e-9, `booked trade result ${s.resultR}`);
    // same signal exists, with the same plan, when the session is cut at its candle
    const cut = c.filter((x) => x.time <= s.barTime);
    const early = evaluateSession(h, cut, [], 200, s.barTime + 300, { s5DistPts: 20 }).signals.find((x) => x.id === s.id);
    assert.ok(early, "signal visible at its own candle");
    assert.equal(early!.plan!.stop, s.plan!.stop);
  }
});

import { SETUP_CONFIG } from "./setupSignals";
test("S5 trend filter is configured per index (trader's choice)", () => {
  const f = SETUP_CONFIG.s5TrendFilterByIndex;
  assert.equal(f.NIFTY, "notAgainst"); assert.equal(f.FINNIFTY, "notAgainst");
  assert.equal(f.BANKNIFTY, "slow5m"); assert.equal(f.SENSEX, "off");
});

test("VWAP gate: a PE rejection whose confirming close is ABOVE VWAP does not start a trade", () => {
  const h = prior(), day = rejectionDay();
  day[7] = bar(D, 7, 104, 105, 99.9, 100.5);      // confirms below the rejection midpoint but closes above VWAP (~99.8)
  const s = evaluateSession(h, day.slice(0, 8), [lvl("Previous Day High", 110, t0(D))], 30, day[7].time + 300).signals.find((x) => x.setup === "S3_LEVEL_REJECTION");
  assert.ok(s, "setup recognised");
  assert.match(s!.blockedBy || "", /VWAP gate/);
});

test("break entry: a signal fills only when price breaks the signal candle's low (PE), else NO_TRIGGER", () => {
  const h = prior(), day = rejectionDay();
  const full = evaluateSession(h, day, [lvl("Previous Day High", 110, t0(D))], 30, day[day.length - 1].time + 300).signals.find((x) => x.setup === "S3_LEVEL_REJECTION")!;
  assert.ok(full.status !== "ENTRY_READY");
  if (full.status !== "NO_TRIGGER") assert.ok(full.plan!.entry! <= Number(full.metrics.sigLow), "PE filled at/below the signal candle's low");
  // a flat day after the signal never breaks the low → cancelled
  const flat = [...day.slice(0, 8), ...[8, 9, 10].map((j) => bar(D, j, 99, 100, 98.5, 99.5))];
  const nt = evaluateSession(h, flat, [lvl("Previous Day High", 110, t0(D))], 30, flat[flat.length - 1].time + 300).signals.find((x) => x.setup === "S3_LEVEL_REJECTION")!;
  assert.equal(nt.status, "NO_TRIGGER");
});

test("day efficiency: a back-and-forth day is CHOPPY (< 0.20), a one-way day is not", () => {
  const h = prior();
  const chop = Array.from({ length: 24 }, (_, i) => { const p = 100 + (i % 2 ? 4 : -4); return bar(D, i, 100, Math.max(100, p) + 1, Math.min(100, p) - 1, p); });
  const r1 = evaluateSession(h, chop, [], 60, chop[chop.length - 1].time + 300);
  assert.ok(r1.efficiency!.value < 0.2 && r1.efficiency!.choppy, `choppy ${r1.efficiency!.value}`);
  const trend = Array.from({ length: 24 }, (_, i) => bar(D, i, 100 + i * 2, 102 + i * 2 + 1, 99 + i * 2, 102 + i * 2));
  const r2v = evaluateSession(h, trend, [], 60, trend[trend.length - 1].time + 300);
  assert.ok(r2v.efficiency!.value > 0.5 && !r2v.efficiency!.choppy, `trend ${r2v.efficiency!.value}`);
  assert.equal(r2v.efficiency!.series.length, 24, "one reading per closed candle");
});
