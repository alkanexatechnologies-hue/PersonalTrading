import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDirection, expectedDirection, neutralBandPts, resolveWindows,
  resolveTradeOutcome, resolveWaitEval, resolveWallOutcome, resolveRecord,
} from "./outcomeResolver";
import { buildAccuracyReport } from "./accuracy";
import { SuggestionRecord, emptyWindows } from "./suggestionLog";
import { layerStateFor, wallContextFor, deriveSuggestion, deriveSourcePath, BuildInput } from "./suggestionBuilder";
import { Candle } from "../types";

// ============================ Advisory measurement tests ============================
// These pin the properties that keep the measurement honest: confidence is never
// an outcome, a small move is NEUTRAL rather than forced into a binary, missing
// data is UNRESOLVED rather than a pass, and accuracy is null (not 0%) when
// nothing has been measured.

const bar = (time: number, o: number, h: number, l: number, c: number, v = 1000): Candle =>
  ({ time, open: o, high: h, low: l, close: c, volume: v });

const T0 = 1_700_000_000; // arbitrary epoch seconds
const baseRec = (o: Partial<SuggestionRecord> = {}): SuggestionRecord => ({
  id: "NIFTY-" + T0, at: T0, istDate: "2026-09-14", istTime: "09:50:00",
  symbol: "NIFTY", name: "Nifty 50",
  layers: { SETUP: "NO_EDGE", DIRECTIONAL: "CANDIDATE", SCALP: "NO_EDGE" },
  sourcePath: "DIRECTIONAL", masterVerdict: "GO", suggestion: "BUY CE",
  optionType: "CE", strike: 24300, expiry: "2026-09-17", tradingSymbol: null,
  spotAtSignal: 24300, entryPremium: 120, stopPremium: 105, targetPremium: 150,
  spotTarget: 24370, spotStop: 24240, confidence: 72, reasons: [],
  wall: { support: 24100, resistance: 24400, roomPts: 100, requiredRoomPts: 30, wallSide: "resistance" },
  resolved: false, resolvedAt: null, windows: emptyWindows(),
  tradeOutcome: "UNRESOLVED", waitEval: "UNRESOLVED",
  wallOutcome: { wallHeld: null, breakoutConfirmed: null, falseBreakout: null },
  unresolvedReason: null, ...o,
});

// ---- direction classification ----

test("expectedDirection maps only BUY suggestions to a side", () => {
  assert.equal(expectedDirection("BUY CE"), "UP");
  assert.equal(expectedDirection("BUY PE"), "DOWN");
  for (const s of ["WAIT", "NO EDGE", "AVOID", "WAIT FOR PULLBACK"]) {
    assert.equal(expectedDirection(s), null, s);
  }
});

test("the neutral band scales with the instrument", () => {
  // 0.05% of spot: ~12 pts on NIFTY, ~27 pts on BANKNIFTY.
  assert.ok(Math.abs(neutralBandPts(24300) - 12.15) < 0.01);
  assert.ok(Math.abs(neutralBandPts(54000) - 27) < 0.01);
});

test("a move smaller than the band is NEUTRAL, not a forced win or loss", () => {
  const band = neutralBandPts(24300); // 12.15
  assert.equal(classifyDirection("UP", 5, band), "NEUTRAL");
  assert.equal(classifyDirection("UP", -5, band), "NEUTRAL");
  assert.equal(classifyDirection("DOWN", 5, band), "NEUTRAL");
});

test("direction is CORRECT / WRONG only beyond the band", () => {
  const band = neutralBandPts(24300);
  assert.equal(classifyDirection("UP", 48, band), "CORRECT");
  assert.equal(classifyDirection("UP", -35, band), "WRONG");
  assert.equal(classifyDirection("DOWN", -48, band), "CORRECT");
  assert.equal(classifyDirection("DOWN", 35, band), "WRONG");
});

test("missing data is UNRESOLVED, never a pass", () => {
  assert.equal(classifyDirection("UP", null, 12), "UNRESOLVED");
  assert.equal(classifyDirection(null, 48, 12), "UNRESOLVED");
});

// ---- observation windows ----

test("a window that has not elapsed stays UNRESOLVED rather than reading 0", () => {
  const rec = baseRec();
  const windows = resolveWindows(rec, {
    spotCandles: [bar(T0, 24300, 24310, 24295, 24305)],
    now: T0 + 60, // only 1 minute later
  });
  for (const w of windows) {
    assert.equal(w.dirResult, "UNRESOLVED", `${w.minutes}m must not be graded yet`);
    assert.equal(w.spotMovePts, null);
  }
});

test("windows grade independently from real candles", () => {
  const rec = baseRec();
  const candles = [
    bar(T0, 24300, 24320, 24295, 24318),          // +18 at 5m
    bar(T0 + 300, 24318, 24360, 24315, 24355),    // +55 at 15m (bar covers T0+300..)
    bar(T0 + 600, 24355, 24365, 24350, 24360),
    bar(T0 + 900, 24360, 24362, 24300, 24305),    // +5 at 30m -> NEUTRAL
    bar(T0 + 1200, 24305, 24310, 24295, 24302),
    bar(T0 + 1500, 24302, 24308, 24298, 24304),
  ];
  const windows = resolveWindows(rec, { spotCandles: candles, now: T0 + 3600 });
  const at = (m: number) => windows.find((w) => w.minutes === m)!;
  assert.equal(at(5).spotMovePts, 18);
  assert.equal(at(5).dirResult, "CORRECT");
  assert.equal(at(15).dirResult, "CORRECT");
  assert.equal(at(30).dirResult, "NEUTRAL", "+4 pts at 30m is inside the band");
});

test("premium move is reported separately from spot move and never merged", () => {
  const rec = baseRec();
  const windows = resolveWindows(rec, {
    spotCandles: [bar(T0, 24300, 24360, 24295, 24355)],
    optionCandles: [bar(T0, 120, 145, 118, 141)],
    now: T0 + 3600,
  });
  const w5 = windows.find((w) => w.minutes === 5)!;
  assert.equal(w5.spotMovePts, 55, "spot move in points");
  assert.equal(w5.premiumMovePct, 17.5, "premium move in percent — a different unit");
  assert.equal(w5.premiumAfter, 141);
});

test("SPOT CORRECT but PREMIUM LOSS is representable — direction is not profit", () => {
  const rec = baseRec();
  const windows = resolveWindows(rec, {
    spotCandles: [bar(T0, 24300, 24360, 24295, 24350)], // +50 spot, CORRECT
    optionCandles: [bar(T0, 120, 124, 108, 112)],       // premium DOWN 6.7%
    now: T0 + 3600,
  });
  const w5 = windows.find((w) => w.minutes === 5)!;
  assert.equal(w5.dirResult, "CORRECT");
  assert.ok(w5.premiumMovePct! < 0, "premium lost value despite correct direction");
});

// ---- trade outcome, on premium, distinct from direction ----

test("trade outcome reads TARGET_HIT only when the premium target is touched", () => {
  const rec = baseRec();
  const hit = resolveTradeOutcome(rec, [bar(T0, 120, 152, 118, 148)], T0 + 1800);
  assert.equal(hit, "TARGET_HIT");
});

test("trade outcome is conservative when stop and target are in the same bar", () => {
  const rec = baseRec();
  const both = resolveTradeOutcome(rec, [bar(T0, 120, 155, 100, 130)], T0 + 1800);
  assert.equal(both, "STOP_HIT", "stop is assumed first, matching the hourly resolver");
});

test("trade outcome distinguishes PARTIAL, LOSS and FLAT when no level is reached", () => {
  const rec = baseRec();
  assert.equal(resolveTradeOutcome(rec, [bar(T0, 120, 135, 119, 130)], T0 + 1800), "PARTIAL");
  assert.equal(resolveTradeOutcome(rec, [bar(T0, 120, 121, 110, 112)], T0 + 1800), "LOSS");
  assert.equal(resolveTradeOutcome(rec, [bar(T0, 120, 122, 119, 121)], T0 + 1800), "FLAT");
});

test("no option history means UNRESOLVED, not a silent pass", () => {
  assert.equal(resolveTradeOutcome(baseRec(), null, T0 + 1800), "UNRESOLVED");
  assert.equal(resolveTradeOutcome(baseRec(), [], T0 + 1800), "UNRESOLVED");
});

// ---- WAIT measurement ----

test("a WAIT that the market then ran through is a MISSED_OPPORTUNITY", () => {
  const rec = baseRec({ masterVerdict: "WAIT", suggestion: "AVOID", reasons: ["OI wall 24320 too close (room 20 pts)"] });
  const windows = resolveWindows(rec, { spotCandles: [bar(T0, 24300, 24380, 24298, 24365)], now: T0 + 3600 });
  assert.equal(resolveWaitEval(rec, windows), "MISSED_OPPORTUNITY");
});

test("a WAIT where price went the other way is a CORRECT_WAIT", () => {
  const rec = baseRec({ masterVerdict: "WAIT", suggestion: "AVOID" });
  const windows = resolveWindows(rec, { spotCandles: [bar(T0, 24300, 24305, 24220, 24235)], now: T0 + 3600 });
  assert.equal(resolveWaitEval(rec, windows), "CORRECT_WAIT");
});

test("a WAIT followed by a tiny move is a CORRECT_WAIT, not a miss", () => {
  const rec = baseRec({ masterVerdict: "WAIT", suggestion: "WAIT" });
  const windows = resolveWindows(rec, { spotCandles: [bar(T0, 24300, 24308, 24296, 24306)], now: T0 + 3600 });
  assert.equal(resolveWaitEval(rec, windows), "CORRECT_WAIT");
});

test("WAIT evaluation never applies to a GO", () => {
  const rec = baseRec({ masterVerdict: "GO" });
  const windows = resolveWindows(rec, { spotCandles: [bar(T0, 24300, 24380, 24298, 24365)], now: T0 + 3600 });
  assert.equal(resolveWaitEval(rec, windows), "UNRESOLVED");
});

// ---- wall behaviour ----

test("a wick through the wall that closes back inside is a FALSE BREAKOUT, not a break", () => {
  const rec = baseRec({ masterVerdict: "WAIT" }); // resistance 24400
  const out = resolveWallOutcome(rec, [
    bar(T0, 24300, 24415, 24295, 24380),      // pierced 24400, closed below
    bar(T0 + 300, 24380, 24395, 24360, 24370),
  ], T0 + 1800);
  assert.equal(out.falseBreakout, true);
  assert.equal(out.breakoutConfirmed, false);
  assert.equal(out.wallHeld, true);
});

test("a completed close beyond the wall is a confirmed breakout", () => {
  const rec = baseRec({ masterVerdict: "WAIT" });
  const out = resolveWallOutcome(rec, [
    bar(T0, 24300, 24390, 24295, 24385),
    bar(T0 + 300, 24385, 24440, 24380, 24430), // closed above 24400
  ], T0 + 1800);
  assert.equal(out.breakoutConfirmed, true);
  assert.equal(out.wallHeld, false);
});

test("wall outcome is null when no wall was in play", () => {
  const rec = baseRec({ wall: { support: null, resistance: null, roomPts: null, requiredRoomPts: 30, wallSide: null } });
  const out = resolveWallOutcome(rec, [bar(T0, 24300, 24400, 24200, 24350)], T0 + 1800);
  assert.equal(out.wallHeld, null);
  assert.equal(out.breakoutConfirmed, null);
});

// ---- full record resolution ----

test("resolveRecord reports why it could not resolve rather than guessing", () => {
  const out = resolveRecord(baseRec(), { spotCandles: [], now: T0 + 3600 });
  assert.equal(out.resolved, false);
  assert.match(out.unresolvedReason!, /no spot candles/);
});

test("resolveRecord abstains on premium when option history is missing", () => {
  const out = resolveRecord(baseRec(), {
    spotCandles: [bar(T0, 24300, 24360, 24295, 24355), bar(T0 + 900, 24355, 24360, 24350, 24358), bar(T0 + 1800, 24358, 24360, 24350, 24356)],
    optionCandles: null, now: T0 + 3600,
  });
  assert.equal(out.tradeOutcome, "UNRESOLVED");
  assert.match(out.unresolvedReason!, /ABSTAINED/);
});

// ---- accuracy aggregation ----

test("accuracy is null, not 0%, when nothing has been measured", () => {
  const rep = buildAccuracyReport([], 15);
  assert.equal(rep.noData, true);
  assert.equal(rep.master.accuracyPct, null);
  for (const l of rep.layers) assert.equal(l.accuracyPct, null, l.layer);
  assert.equal(rep.wait.correctWaitPct, null);
});

test("accuracy excludes NEUTRAL and UNRESOLVED from the denominator", () => {
  const mk = (dir: "CORRECT" | "WRONG" | "NEUTRAL" | "UNRESOLVED"): SuggestionRecord =>
    baseRec({ windows: [{ minutes: 15, spotAfter: 1, spotMovePts: 1, dirResult: dir, premiumAfter: null, premiumMovePct: null }], resolved: true });
  const rep = buildAccuracyReport([mk("CORRECT"), mk("CORRECT"), mk("WRONG"), mk("NEUTRAL"), mk("UNRESOLVED")], 15);
  assert.equal(rep.master.correct, 2);
  assert.equal(rep.master.wrong, 1);
  assert.equal(rep.master.neutral, 1);
  assert.equal(rep.master.accuracyPct, 66.7, "2 of 3 decided — neutral/unresolved excluded");
});

test("accuracy is never derived from confidence", () => {
  // Two records with maximum confidence but a WRONG measured outcome must report 0%.
  const rec = baseRec({
    confidence: 99, resolved: true,
    windows: [{ minutes: 15, spotAfter: 1, spotMovePts: -50, dirResult: "WRONG", premiumAfter: null, premiumMovePct: null }],
  });
  const rep = buildAccuracyReport([rec, rec], 15);
  assert.equal(rep.master.accuracyPct, 0, "high confidence must not rescue a wrong call");
});

test("each layer is tallied independently on its own CANDIDATE state", () => {
  const win = [{ minutes: 15, spotAfter: 1, spotMovePts: 50, dirResult: "CORRECT" as const, premiumAfter: null, premiumMovePct: null }];
  const recs = [
    baseRec({ layers: { SETUP: "CANDIDATE", DIRECTIONAL: "CANDIDATE", SCALP: "NO_EDGE" }, windows: win, resolved: true }),
    baseRec({ layers: { SETUP: "NO_EDGE", DIRECTIONAL: "CANDIDATE", SCALP: "CANDIDATE" }, windows: win, resolved: true }),
  ];
  const rep = buildAccuracyReport(recs, 15);
  const by = (n: string) => rep.layers.find((l) => l.layer === n)!;
  assert.equal(by("SETUP").signals, 1);
  assert.equal(by("DIRECTIONAL").signals, 2);
  assert.equal(by("SCALP").signals, 1);
});

test("correct-direction-but-premium-loss is counted as its own statistic", () => {
  const rec = baseRec({
    resolved: true,
    windows: [{ minutes: 15, spotAfter: 24350, spotMovePts: 50, dirResult: "CORRECT", premiumAfter: 112, premiumMovePct: -6.7 }],
  });
  const rep = buildAccuracyReport([rec], 15);
  assert.equal(rep.premium.correctDirectionButPremiumLoss, 1);
});

// ---- builder: layer states and suggestion derivation ----

test("a take-able leg is a CANDIDATE, never a trade by itself", () => {
  assert.equal(layerStateFor({ take: true }), "CANDIDATE");
  assert.equal(layerStateFor(null), "NO_EDGE");
  assert.equal(layerStateFor({ take: false, skipReasons: [] }), "NO_EDGE");
  assert.equal(layerStateFor({ take: false, skipReasons: ["OI confidence 40 < 55"] }), "WAIT");
  assert.equal(layerStateFor({ take: false, skipReasons: ["OI wall 24320 too close (room 20 pts)"] }), "BLOCK");
});

test("an unknown wall yields a NULL room, never a favourable one", () => {
  const w = wallContextFor("CE", 24300, 24100, null, 30);
  assert.equal(w.roomPts, null, "unknown must stay unknown in the display record");
  assert.equal(w.requiredRoomPts, 30);
  assert.equal(w.wallSide, "resistance");
});

const bi = (o: Partial<BuildInput> = {}): BuildInput => ({
  at: T0, istDate: "2026-09-14", istTime: "09:50:00", symbol: "NIFTY", name: "Nifty 50",
  spot: 24300, expiry: "2026-09-17", masterVerdict: "WAIT", primaryMode: null, masterReason: "no actionable candidate",
  directional: null, scalp: null, setup: null, finalScore: null,
  support: 24100, resistance: 24400, expLow: 30, ...o,
});

test("the engine's WAIT is never displayed as an entry", () => {
  for (const v of ["WAIT", "CONFLICT"]) {
    const s = deriveSuggestion(bi({ masterVerdict: v, directional: { take: true, optionType: "CE", strike: 24300 } }), null);
    assert.ok(!s.startsWith("BUY"), `${v} must not become a BUY (got ${s})`);
  }
});

test("a GO with a concrete leg becomes the matching BUY", () => {
  const leg = { take: true, optionType: "CE" as const, strike: 24300, ltp: 120 };
  assert.equal(deriveSuggestion(bi({ masterVerdict: "GO", primaryMode: "Directional", directional: leg }), leg), "BUY CE");
  const pe = { take: true, optionType: "PE" as const, strike: 24300, ltp: 110 };
  assert.equal(deriveSuggestion(bi({ masterVerdict: "GO", primaryMode: "Directional", directional: pe }), pe), "BUY PE");
});

test("AVOID is reserved for a danger the engine actually named", () => {
  const s = deriveSuggestion(bi({ directional: { take: false, skipReasons: ["setup invalidated vs OI wall"] } }), null);
  assert.equal(s, "AVOID");
  const noEdge = deriveSuggestion(bi({ directional: { take: false, skipReasons: [] } }), null);
  assert.equal(noEdge, "NO EDGE", "absence of a setup is NO EDGE, not AVOID");
});

test("WAIT FOR PULLBACK appears only when the engine reports extension", () => {
  // The engine has no pullback gate today, so with ordinary reasons it must not appear.
  const s = deriveSuggestion(bi({ directional: { take: false, skipReasons: ["OI FLAT — WAIT"] } }), null);
  assert.notEqual(s, "WAIT FOR PULLBACK");
});

test("source path names the promoted layer and any agreeing layer", () => {
  const layers = { SETUP: "NO_EDGE" as const, DIRECTIONAL: "CANDIDATE" as const, SCALP: "CANDIDATE" as const };
  const go = deriveSourcePath(bi({ masterVerdict: "GO", primaryMode: "Directional" }), layers);
  assert.equal(go, "DIRECTIONAL + SCALP");
  const held = deriveSourcePath(bi({ masterVerdict: "WAIT" }), layers);
  assert.match(held, /MASTER \(held\)/);
  const none = deriveSourcePath(bi({ masterVerdict: "WAIT" }), { SETUP: "NO_EDGE", DIRECTIONAL: "NO_EDGE", SCALP: "NO_EDGE" });
  assert.equal(none, "NONE");
});
