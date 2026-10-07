import { test } from "node:test";
import assert from "node:assert/strict";
import { Candle } from "../types";
import { biasShiftAt, BiasState } from "./biasShift";
import { session, Leg } from "../signals/breakoutFixtures";

// Rally to a new high, fail back under it, then lose VWAP / EMA and break down.
const LEGS: Leg[] = [
  { to: 22040, bars: 6 }, { to: 22030, bars: 3 }, { to: 22070, bars: 6 }, { to: 22060, bars: 3 }, { to: 22100, bars: 6 },
  { to: 22090, bars: 2 }, { to: 22112, bars: 1, wick: 2 },            // breakout above the session high
  { to: 22094, bars: 1 }, { to: 22085, bars: 2 },                       // closes back below it → weakening
  { to: 22040, bars: 6 }, { to: 22020, bars: 4 }, { to: 21990, bars: 5 },
];
const day = (): Candle[] => session(22000, 15, 22020, LEGS);

test("rally → failed breakout → breakdown produces WEAKENING then SHIFT_BEARISH, and blocks CE", () => {
  const r = biasShiftAt(day());
  const states = r.events.map((e) => e.state);
  const w = states.indexOf("BULLISH_WEAKENING"), s = states.indexOf("SHIFT_BEARISH");
  assert.ok(w >= 0, `weakening missing: ${states.join(",")}`);
  assert.ok(s > w, `shift must follow the warning: ${states.join(",")}`);
  assert.match(r.events[w].reason, /FAILED|breakout candle low/);
  assert.ok(["SHIFT_BEARISH", "BEARISH_LEG"].includes(r.state), r.state);
  assert.equal(r.allow.CE, false);
  assert.equal(r.allow.PE, true);
  assert.ok(r.invalidation != null);
});

test("no look-ahead: the state at every bar equals a run on candles up to that bar", () => {
  const cs = day();
  const full = biasShiftAt(cs);
  const today = cs.filter((c) => new Date((c.time + 19800) * 1000).toISOString().slice(0, 10) === new Date((cs[cs.length - 1].time + 19800) * 1000).toISOString().slice(0, 10));
  let cur: BiasState = "MIXED", e = 0;
  for (const c of today) {
    while (e < full.events.length && full.events[e].time <= c.time) cur = full.events[e++].state;
    const upto = cs.filter((x) => x.time <= c.time);
    if (upto.length < 30) continue;
    const prefix = biasShiftAt(upto);
    if (prefix.state === "NO_DATA") continue;
    assert.equal(prefix.state, cur, `state at ${c.time}`);
  }
});

test("mirror: a sell-off that fails and recovers produces SHIFT_BULLISH and blocks PE", () => {
  const K = 44040;
  const mirror = day().map((x) => ({ time: x.time, open: K - x.open, high: K - x.low, low: K - x.high, close: K - x.close, volume: x.volume }));
  const r = biasShiftAt(mirror);
  assert.ok(r.events.some((e) => e.state === "SHIFT_BULLISH"), r.events.map((e) => e.state).join(","));
  assert.equal(r.allow.PE, false);
});

test("too little data → NO_DATA, permits both sides", () => {
  const r = biasShiftAt(day().slice(0, 10));
  assert.equal(r.state, "NO_DATA");
  assert.deepEqual(r.allow, { CE: true, PE: true });
});
