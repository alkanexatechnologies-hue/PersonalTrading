import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFakeMoveTF, buildFakeMoveResult, FakeMoveLevel, FakeMoveTFInput } from "./fakeMove";

// Candle helper (time increments so crossedAt/reclaimedAt are checkable).
let _t = 1_700_000_000;
const bar = (o: number, h: number, l: number, c: number) => ({ open: o, high: h, low: l, close: c, volume: 100, time: (_t += 300) });

const R = (price: number): FakeMoveLevel => ({ price, label: "Resistance", side: "resistance" });
const S = (price: number): FakeMoveLevel => ({ price, label: "Support", side: "support" });

const tf = (label: string, candles: any[], levels: FakeMoveLevel[], structure: any = "RANGING"): FakeMoveTFInput => ({ tfLabel: label, candles, levels, structure });

// --- Building blocks that produce each documented state against level = 100 ---
// Fake-UP: pierce & close above 100, then reclaim below.
const fakeUpCandles = () => [bar(98, 99, 97, 98), bar(98, 101, 98, 100.5), bar(100.5, 101, 99, 99.5), bar(99.5, 100, 98, 99)];
// Fake-DOWN: pierce & close below 100, then reclaim above.
const fakeDownCandles = () => [bar(102, 103, 101, 102), bar(102, 102, 99, 99.5), bar(99.5, 101, 99, 100.5), bar(100.5, 102, 100, 101)];
// Accepted breakout: two closes above 100 with no reclaim.
const breakoutCandles = () => [bar(99, 100, 98, 99), bar(99, 101, 99, 100.5), bar(100.5, 102, 100, 101.2), bar(101.2, 102, 101, 101.5)];
// Retest: two closes above, last dips to level and holds above.
const retestCandles = () => [bar(99, 100, 98, 99), bar(99, 101, 99, 100.5), bar(100.5, 102, 100, 101), bar(101, 101.5, 99.9, 100.2)];
// Accepted breakdown: two closes below 100.
const breakdownCandles = () => [bar(101, 102, 100, 101), bar(101, 101, 99, 99.5), bar(99.5, 100, 98, 99), bar(99, 99.5, 98, 98.8)];

test("Fake-Up 5M: pierce+close above then reclaim below → CONFIRMED UP (failed breakout)", () => {
  const fm = detectFakeMoveTF(tf("5M", fakeUpCandles(), [R(100)]));
  assert.equal(fm.direction, "UP");
  assert.equal(fm.status, "CONFIRMED");
  assert.equal(fm.breakoutState, "FAILED_BREAKOUT");
  assert.equal(fm.level, 100);
  assert.ok(fm.crossedAt && fm.reclaimedAt);
});

test("Fake-Down 5M: pierce+close below then reclaim above → CONFIRMED DOWN (failed breakdown)", () => {
  const fm = detectFakeMoveTF(tf("5M", fakeDownCandles(), [S(100)]));
  assert.equal(fm.direction, "DOWN");
  assert.equal(fm.status, "CONFIRMED");
  assert.equal(fm.breakoutState, "FAILED_BREAKDOWN");
});

test("Fake-Up 15M and Fake-Down 15M behave identically on the 15M input", () => {
  const up = detectFakeMoveTF(tf("15M", fakeUpCandles(), [R(100)]));
  const down = detectFakeMoveTF(tf("15M", fakeDownCandles(), [S(100)]));
  assert.equal(up.direction, "UP");
  assert.equal(down.direction, "DOWN");
  assert.equal(up.timeframe, "15M");
});

test("Breakout accepted: two closes above → BREAKOUT_ACCEPTED, not a fake", () => {
  const fm = detectFakeMoveTF(tf("5M", breakoutCandles(), [R(100)]));
  assert.equal(fm.breakoutState, "BREAKOUT_ACCEPTED");
  assert.equal(fm.direction, "NONE");
});

test("Failed breakout equals confirmed fake-up", () => {
  const fm = detectFakeMoveTF(tf("5M", fakeUpCandles(), [R(100)]));
  assert.equal(fm.breakoutState, "FAILED_BREAKOUT");
});

test("Retest: breakout then dip-to-level holding above → RETEST", () => {
  const fm = detectFakeMoveTF(tf("5M", retestCandles(), [R(100)]));
  assert.equal(fm.breakoutState, "RETEST");
});

test("Failed breakdown: accepted breakdown is not a fake", () => {
  const fm = detectFakeMoveTF(tf("5M", breakdownCandles(), [S(100)]));
  assert.equal(fm.breakoutState, "BREAKDOWN_ACCEPTED");
  assert.equal(fm.direction, "NONE");
});

test("5M/15M confirmation aligned → CONFIRMED_ALIGNED + FAILED_BREAKOUT headline", () => {
  const r = buildFakeMoveResult({
    tf5: tf("5M", fakeUpCandles(), [R(100)]),
    tf15: tf("15M", fakeUpCandles(), [R(100)]),
    higher: { timeframe: "1H", structure: "BEARISH", available: true },
    existingDirection: "BEARISH",
    dataStale: false,
  });
  assert.equal(r.confirmationState, "CONFIRMED_ALIGNED");
  assert.equal(r.mtfFakeMoveState.status, "FAILED_BREAKOUT");
  assert.equal(r.conflict.exists, false); // fake-up implies bearish, matches existing BEARISH
});

test("5M/15M conflict → CONFLICT state, low confidence", () => {
  const r = buildFakeMoveResult({
    tf5: tf("5M", fakeUpCandles(), [R(100)]),     // UP
    tf15: tf("15M", fakeDownCandles(), [S(100)]), // DOWN
    higher: { timeframe: "1H", structure: "RANGING", available: true },
    existingDirection: "NEUTRAL",
    dataStale: false,
  });
  assert.equal(r.confirmationState, "CONFLICT");
  assert.equal(r.mtfFakeMoveState.status, "CONFLICT");
  assert.ok(r.mtfFakeMoveState.confidence <= 25);
});

test("1H context is surfaced from higher-timeframe structure", () => {
  const r = buildFakeMoveResult({
    tf5: tf("5M", fakeUpCandles(), [R(100)]),
    tf15: null,
    higher: { timeframe: "1H", structure: "BULLISH", available: true },
    existingDirection: "BULLISH",
    dataStale: false,
  });
  assert.equal(r.higherTimeframeContext.timeframe, "1H");
  assert.equal(r.higherTimeframeContext.direction, "BULLISH");
  assert.equal(r.higherTimeframeContext.bias, "SUPPORTS_UP");
});

test("Conflict vs EXISTING direction is reported but never overrides it", () => {
  const r = buildFakeMoveResult({
    tf5: tf("5M", fakeUpCandles(), [R(100)]),      // fake-up ⇒ implies BEARISH
    tf15: tf("15M", fakeUpCandles(), [R(100)]),
    higher: { timeframe: "1H", structure: "BULLISH", available: true },
    existingDirection: "BULLISH",                  // existing says BULLISH
    dataStale: false,
  });
  assert.equal(r.conflict.exists, true);
  assert.equal(r.conflict.existingDirection, "BULLISH"); // unchanged/source of truth
  assert.equal(r.conflict.mtfImplied, "BEARISH");
});

test("Data unavailable: null timeframes → available=false, NONE states", () => {
  const r = buildFakeMoveResult({
    tf5: null, tf15: null,
    higher: { timeframe: "1H", structure: null, available: false },
    existingDirection: null, dataStale: false,
  });
  assert.equal(r.available, false);
  assert.equal(r.fakeMove5m.status, "NONE");
  assert.equal(r.fakeMove15m.status, "NONE");
  assert.equal(r.confirmationState, "NONE");
  assert.equal(r.higherTimeframeContext.available, false);
});

test("Stale data flag propagates through the result", () => {
  const r = buildFakeMoveResult({
    tf5: tf("5M", fakeUpCandles(), [R(100)]),
    tf15: null,
    higher: { timeframe: "15M", structure: "BEARISH", available: true },
    existingDirection: "BEARISH", dataStale: true,
  });
  assert.equal(r.dataStale, true);
});

test("No reference levels → NONE (never fabricates a fake move)", () => {
  const fm = detectFakeMoveTF(tf("5M", fakeUpCandles(), []));
  assert.equal(fm.status, "NONE");
  assert.equal(fm.direction, "NONE");
});

// ---- Counter-trend candle / presentation states (never override direction) ----
// Rising candles that don't interact with a far level (no fake move); last is green/red.
const risingGreenLast = () => [bar(90, 91, 89, 90.5), bar(90.5, 91.5, 90, 91), bar(91, 92, 90.5, 91.5), bar(91.5, 92.5, 91, 92)];
const risingRedLast = () => [bar(90, 91, 89, 90.5), bar(90.5, 91.5, 90, 91), bar(91, 92, 90.5, 91.5), bar(91.5, 92, 90, 90.5)];

test("Counter-trend candle: green candle in BEARISH 5M → FAKE WATCH, direction NOT flipped", () => {
  const r = buildFakeMoveResult({
    tf5: tf("5M", risingGreenLast(), [R(200)], "BEARISH"),
    tf15: tf("15M", risingGreenLast(), [R(200)], "BEARISH"),
    higher: { timeframe: "1H", structure: "BEARISH", available: true },
    existingDirection: "BEARISH", dataStale: false,
  });
  assert.equal(r.counterTrend.active, true);
  assert.equal(r.counterTrend.candleColor, "GREEN");
  assert.equal(r.counterTrend.status, "FAKE WATCH");
  assert.equal(r.counterTrend.label, "COUNTER-TREND PULLBACK");
  // The EXISTING 5M direction is unchanged (still BEARISH), only annotated.
  assert.equal(r.mtfDirection.m5.direction, "BEARISH");
  assert.equal(r.mtfDirection.m5.annotation, "COUNTER-TREND PULLBACK");
  assert.match(r.counterTrend.note, /not a reversal/i);
  assert.equal(r.scenario.status, "Counter-trend pullback");
});

test("Continuation candle: red candle in BEARISH 5M → not counter-trend", () => {
  const r = buildFakeMoveResult({
    tf5: tf("5M", risingRedLast(), [R(200)], "BEARISH"),
    tf15: null,
    higher: { timeframe: "1H", structure: "BEARISH", available: true },
    existingDirection: "BEARISH", dataStale: false,
  });
  assert.equal(r.counterTrend.active, false);
  assert.equal(r.counterTrend.label, "CONTINUATION");
  assert.equal(r.mtfDirection.m5.annotation, null);
});

test("Reversal watch: breakout accepted AGAINST bearish structure → REVERSAL WATCH (not a signal)", () => {
  const r = buildFakeMoveResult({
    tf5: tf("5M", breakoutCandles(), [R(100)], "BEARISH"), // accepted breakout up, last candle green
    tf15: null,
    higher: { timeframe: "1H", structure: "BEARISH", available: true },
    existingDirection: "BEARISH", dataStale: false,
  });
  assert.equal(r.counterTrend.active, true);
  assert.equal(r.counterTrend.status, "REVERSAL WATCH");
  // Existing direction still BEARISH — reversal is only a WATCH, never a flip.
  assert.equal(r.mtfDirection.m5.direction, "BEARISH");
  assert.match(r.scenario.reversalWatchNote, /not a confirmed/i);
});

test("MTF Direction view repackages EXISTING directions (1H/15M/5M) unchanged", () => {
  const r = buildFakeMoveResult({
    tf5: tf("5M", risingRedLast(), [R(200)], "BEARISH"),
    tf15: tf("15M", risingRedLast(), [R(200)], "BEARISH"),
    higher: { timeframe: "1H", structure: "BEARISH", available: true },
    existingDirection: "BEARISH", dataStale: false,
  });
  assert.equal(r.mtfDirection.h1.direction, "BEARISH");
  assert.equal(r.mtfDirection.m15.direction, "BEARISH");
  assert.equal(r.mtfDirection.m5.direction, "BEARISH");
});
