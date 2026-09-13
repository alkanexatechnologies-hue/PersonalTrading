import { SuggestionRecord, LayerName, DirResult } from "./suggestionLog";

// ============================ Accuracy aggregation ============================
// Computed ONLY from resolved observations. Never from confidence, never from
// unit tests, never hard-coded.
//
// Two rules keep these numbers honest:
//   1. NEUTRAL and UNRESOLVED are excluded from the denominator. A signal whose
//      move was inside the neutral band was neither right nor wrong.
//   2. When the decided count is zero the accuracy is null, which the UI renders
//      as NOT RUN. It is never 0%, because "no evidence" and "always wrong" are
//      opposite statements.

export interface LayerAccuracy {
  layer: string;
  /** Records where this layer produced an actionable candidate. */
  signals: number;
  correct: number;
  wrong: number;
  neutral: number;
  unresolved: number;
  /** correct / (correct + wrong), or null when nothing is decided yet. */
  accuracyPct: number | null;
}

export interface WaitAccuracy {
  waits: number;
  correctWait: number;
  missedOpportunity: number;
  neutral: number;
  unresolved: number;
  /** correctWait / (correctWait + missedOpportunity), or null. */
  correctWaitPct: number | null;
}

export interface WallStats {
  wallBlocked: number;
  wallHeld: number;
  breakoutConfirmed: number;
  falseBreakout: number;
  /** Of wall-blocked setups, how many later broke out with confirmation. */
  breakoutAfterBlockPct: number | null;
}

export interface PremiumStats {
  buySuggestions: number;
  targetHit: number;
  stopHit: number;
  partial: number;
  loss: number;
  flat: number;
  unresolved: number;
  /** Cases where spot direction was CORRECT but the premium still lost value. */
  correctDirectionButPremiumLoss: number;
}

export interface AccuracyReport {
  /** Window these figures are measured at, in minutes. */
  windowMinutes: number;
  totalRecords: number;
  resolvedRecords: number;
  layers: LayerAccuracy[];
  master: LayerAccuracy;
  wait: WaitAccuracy;
  wall: WallStats;
  premium: PremiumStats;
  /** True when nothing has been resolved yet - the UI must show NOT RUN. */
  noData: boolean;
}

const pct = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : null;

function windowResult(r: SuggestionRecord, minutes: number): DirResult {
  const w = r.windows.find((x) => x.minutes === minutes);
  return w ? w.dirResult : "UNRESOLVED";
}

/** Accuracy over the records a predicate selects. */
function tally(records: SuggestionRecord[], minutes: number, label: string): LayerAccuracy {
  let correct = 0, wrong = 0, neutral = 0, unresolved = 0;
  for (const r of records) {
    switch (windowResult(r, minutes)) {
      case "CORRECT": correct++; break;
      case "WRONG": wrong++; break;
      case "NEUTRAL": neutral++; break;
      default: unresolved++; break;
    }
  }
  return {
    layer: label,
    signals: records.length,
    correct, wrong, neutral, unresolved,
    accuracyPct: pct(correct, correct + wrong),
  };
}

export function buildAccuracyReport(all: SuggestionRecord[], windowMinutes = 15): AccuracyReport {
  // A layer "produced a signal" when it was a CANDIDATE, regardless of whether
  // the Master Selector promoted it. That is what makes per-layer comparison
  // meaningful: it measures the layer's own call, not the arbiter's.
  const layers: LayerAccuracy[] = (["SETUP", "DIRECTIONAL", "SCALP"] as LayerName[]).map((L) =>
    tally(all.filter((r) => r.layers?.[L] === "CANDIDATE"), windowMinutes, L));

  // MASTER is measured only on records where it actually issued an entry.
  const masterActionable = all.filter((r) => r.suggestion === "BUY CE" || r.suggestion === "BUY PE");
  const master = tally(masterActionable, windowMinutes, "MASTER");

  // WAIT measurement - the other half of the picture.
  const waits = all.filter((r) => r.masterVerdict !== "GO");
  const wait: WaitAccuracy = {
    waits: waits.length,
    correctWait: waits.filter((r) => r.waitEval === "CORRECT_WAIT").length,
    missedOpportunity: waits.filter((r) => r.waitEval === "MISSED_OPPORTUNITY").length,
    neutral: waits.filter((r) => r.waitEval === "NEUTRAL").length,
    unresolved: waits.filter((r) => r.waitEval === "UNRESOLVED").length,
    correctWaitPct: null,
  };
  wait.correctWaitPct = pct(wait.correctWait, wait.correctWait + wait.missedOpportunity);

  // Wall behaviour, for the eventual threshold question.
  const wallBlockedRecs = all.filter((r) =>
    r.masterVerdict !== "GO" && r.reasons.some((x) => /wall|room/i.test(x)));
  const wall: WallStats = {
    wallBlocked: wallBlockedRecs.length,
    wallHeld: wallBlockedRecs.filter((r) => r.wallOutcome?.wallHeld === true).length,
    breakoutConfirmed: wallBlockedRecs.filter((r) => r.wallOutcome?.breakoutConfirmed === true).length,
    falseBreakout: wallBlockedRecs.filter((r) => r.wallOutcome?.falseBreakout === true).length,
    breakoutAfterBlockPct: null,
  };
  const wallDecided = wall.wallHeld + wall.breakoutConfirmed;
  wall.breakoutAfterBlockPct = pct(wall.breakoutConfirmed, wallDecided);

  // Premium vs direction - the distinction that stops a correct call from being
  // mistaken for a profitable one.
  const premium: PremiumStats = {
    buySuggestions: masterActionable.length,
    targetHit: masterActionable.filter((r) => r.tradeOutcome === "TARGET_HIT").length,
    stopHit: masterActionable.filter((r) => r.tradeOutcome === "STOP_HIT").length,
    partial: masterActionable.filter((r) => r.tradeOutcome === "PARTIAL").length,
    loss: masterActionable.filter((r) => r.tradeOutcome === "LOSS").length,
    flat: masterActionable.filter((r) => r.tradeOutcome === "FLAT").length,
    unresolved: masterActionable.filter((r) => r.tradeOutcome === "UNRESOLVED").length,
    correctDirectionButPremiumLoss: masterActionable.filter((r) => {
      const w = r.windows.find((x) => x.minutes === windowMinutes);
      return w?.dirResult === "CORRECT" && w.premiumMovePct != null && w.premiumMovePct < 0;
    }).length,
  };

  const resolvedRecords = all.filter((r) => r.resolved).length;
  return {
    windowMinutes,
    totalRecords: all.length,
    resolvedRecords,
    layers,
    master,
    wait,
    wall,
    premium,
    noData: resolvedRecords === 0,
  };
}
