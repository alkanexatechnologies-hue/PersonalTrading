import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDailyReport } from "./marketActivityAnalyst";
import { SuggestionRecord, Suggestion, DirResult } from "../advisory/suggestionLog";

const DATE = "2026-09-18";

// Build a resolved SuggestionRecord fixture with the fields the analyst reads.
function rec(o: {
  id: string; symbol?: string; name?: string; suggestion: Suggestion; optionType?: "CE" | "PE" | null;
  win: { m: number; dir: DirResult; move: number | null }[];
  waitEval?: SuggestionRecord["waitEval"]; tradeOutcome?: SuggestionRecord["tradeOutcome"];
  masterVerdict?: string; layers?: Partial<SuggestionRecord["layers"]>; resolved?: boolean;
}): SuggestionRecord {
  return {
    id: o.id, at: 1789600000, istDate: DATE, istTime: "10:00:00",
    symbol: o.symbol ?? "^NSEI", name: o.name ?? "NIFTY 50",
    layers: { SETUP: "PASS", DIRECTIONAL: "CANDIDATE", SCALP: "NO_EDGE", ...(o.layers ?? {}) } as any,
    sourcePath: "DIRECTIONAL", masterVerdict: o.masterVerdict ?? "GO", suggestion: o.suggestion,
    optionType: o.optionType ?? (o.suggestion === "BUY CE" ? "CE" : o.suggestion === "BUY PE" ? "PE" : null),
    strike: 23400, expiry: null, tradingSymbol: null,
    spotAtSignal: 23400, entryPremium: 100, stopPremium: 80, targetPremium: 140, spotTarget: 23460, spotStop: 23360,
    confidence: 70, reasons: [], wall: { support: null, resistance: null, roomPts: null, requiredRoomPts: null, wallSide: null },
    resolved: o.resolved ?? true, resolvedAt: 1789602000,
    windows: o.win.map((w) => ({ minutes: w.m, spotAfter: w.move == null ? null : 23400 + w.move, spotMovePts: w.move, dirResult: w.dir, premiumAfter: null, premiumMovePct: null })),
    tradeOutcome: o.tradeOutcome ?? "UNRESOLVED", waitEval: o.waitEval ?? "UNRESOLVED",
    wallOutcome: { wallHeld: null, breakoutConfirmed: null, falseBreakout: null }, unresolvedReason: null,
  };
}

test("analyst rolls up accuracy, false rate, timing and MFE/MAE from resolved records", () => {
  const suggestions: SuggestionRecord[] = [
    // CE correct at 5m → TIMELY, MFE +40 / MAE -5
    rec({ id: "a", suggestion: "BUY CE", win: [{ m: 5, dir: "CORRECT", move: 20 }, { m: 15, dir: "CORRECT", move: 40 }, { m: 30, dir: "CORRECT", move: 35 }] }),
    // CE flat then correct → EARLY
    rec({ id: "b", suggestion: "BUY CE", win: [{ m: 5, dir: "NEUTRAL", move: 2 }, { m: 15, dir: "CORRECT", move: 25 }, { m: 30, dir: "CORRECT", move: 30 }] }),
    // PE wrong at 15m → FALSE, counts against accuracy
    rec({ id: "c", suggestion: "BUY PE", win: [{ m: 5, dir: "WRONG", move: 12 }, { m: 15, dir: "WRONG", move: 22 }, { m: 30, dir: "WRONG", move: 25 }], tradeOutcome: "STOP_HIT" }),
    // WAIT that missed a move
    rec({ id: "d", suggestion: "WAIT", optionType: null, win: [{ m: 15, dir: "UNRESOLVED", move: null }], waitEval: "MISSED_OPPORTUNITY", masterVerdict: "WAIT" }),
    // WAIT correctly avoided
    rec({ id: "e", suggestion: "WAIT", optionType: null, win: [{ m: 15, dir: "UNRESOLVED", move: null }], waitEval: "CORRECT_WAIT", masterVerdict: "WAIT" }),
  ];
  const rep = buildDailyReport(DATE, { suggestions, oiSignals: [], freshnessAges: [0, 2, 5, 30] });

  assert.equal(rep.totalSignals, 3, "3 actionable signals");
  assert.equal(rep.totalWaits, 2, "2 waits");
  // Accuracy at 15m: 2 correct (a,b) vs 1 wrong (c) = 66.7%
  assert.equal(rep.signalAccuracyPct, 66.7);
  // False-signal rate: 1 bad of 3 decided = 33.3%
  assert.equal(rep.falseSignalRatePct, 33.3);
  // Missed-move rate: 1 of 2 decided waits = 50%
  assert.equal(rep.missedMoveRatePct, 50);
  assert.equal(rep.waitQuality.correctWaitPct, 50);
  // Timing: a=TIMELY, b=EARLY, c=FALSE
  assert.equal(rep.timing.TIMELY, 1);
  assert.equal(rep.timing.EARLY, 1);
  assert.equal(rep.timing.FALSE, 1);
  // MFE present and positive on the winners; data freshness computed.
  assert.ok(rep.avgMfePts != null && rep.avgMfePts > 0);
  assert.equal(rep.dataQuality.samples, 4);
  assert.ok(rep.dataQuality.freshPct != null);
  // Strength score computed (not null) and in range.
  assert.ok(rep.strengthScore != null && rep.strengthScore >= 0 && rep.strengthScore <= 100);
});

test("empty day yields NOT RUN, never a fabricated 0%", () => {
  const rep = buildDailyReport(DATE, { suggestions: [], oiSignals: [], freshnessAges: [] });
  assert.equal(rep.overallStrength, "NOT RUN");
  assert.equal(rep.strengthScore, null);
  assert.equal(rep.signalAccuracyPct, null);
  assert.equal(rep.falseSignalRatePct, null);
});
